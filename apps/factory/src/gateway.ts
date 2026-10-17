// The model gateway (plan §7): the agents' only route to the model, Anthropic's or OpenAI's.
// Before every request it checks the run's and the week's spend against the caps at the request's
// worst case; after, it records what the call cost, per run and role. It fails closed.
import { CAPS, type Caps } from './caps.js';
import type { Ledger } from './ledger.js';
import { costUsd, PRICES, priceOf, type Price, type Provider, type Role } from './models.js';
import { isPicture, Refusal, type Request, type Upstream } from './upstream.js';

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

// An image costs at most this many input tokens, whatever its size in bytes.
const IMAGE_TOKENS = 5_000;

// Billed beyond tokens, or at rates other than the model's: server tools, fast mode, another
// model as a fallback, another service tier.
const UNPRICED = ['speed', 'fallbacks', 'service_tier', 'web_search_options'];

/** The most output a request allows, in either provider's field. */
const maxTokensOf = (r: Request) => r.max_tokens ?? r.max_completion_tokens;

/**
 * The most a request can cost: a token for every byte of it (no token is shorter), a fixed count
 * for each image, every input token at the cache-write rate if it asks for caching, and every
 * output token it allows.
 */
export function worstCaseUsd(price: Price, request: Request): number {
  let images = 0;
  const json = JSON.stringify(request, (_k, v: unknown) => {
    if (!isPicture(v)) return v;
    images++;
    return null;
  });
  const tokensIn = Buffer.byteLength(json) + images * IMAGE_TOKENS;
  const inputRate = json.includes('"cache_control"') ? price.cacheWrite : price.input;
  return (tokensIn * inputRate + Number(maxTokensOf(request)) * price.output) / 1e6;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function gateway(opts: {
  ledger: Ledger;
  upstream: Upstream;
  caps?: Caps;
  prices?: Readonly<Record<string, Price>>;
}) {
  const { ledger, upstream, caps = CAPS, prices = PRICES } = opts;
  // The worst case of every request still in flight, by run. A call that could not be recorded
  // stays held, so its spend is never forgotten.
  const held = new Map<string, number>();
  const heldFor = (runId: string) => held.get(runId) ?? 0;
  const heldAll = () => [...held.values()].reduce((a, b) => a + b, 0);

  async function call(
    provider: Provider,
    runId: string,
    role: Role,
    request: Request,
  ): Promise<Reply> {
    const price = priceOf(request.model, prices);
    const max = maxTokensOf(request);
    if (!Number.isInteger(max) || (max as number) < 1)
      throw new Refusal(400, 'invalid_request_error', 'max_tokens is required');
    // The agents' own tools are priced as tokens; any other kind of tool is not.
    const tools = Array.isArray(request.tools)
      ? (request.tools as ({ type?: unknown } | null)[])
      : [];
    if (tools.some((t) => t?.type !== undefined && t?.type !== 'custom' && t?.type !== 'function'))
      throw new Refusal(400, 'invalid_request_error', 'server tools have no known price');
    const unpriced = UNPRICED.find((k) => request[k] !== undefined);
    if (unpriced) throw new Refusal(400, 'invalid_request_error', `${unpriced} has no known price`);

    const worst = worstCaseUsd(price, request);
    const spend = await ledger.spend(runId).catch(() => {
      throw new Refusal(503, 'api_error', 'the spend ledger is unreadable');
    });
    if (!spend) throw new Refusal(404, 'not_found_error', `no factory run ${runId}`);
    const runCap = caps.runUsd - (role === 'lessons' ? 0 : caps.lessonsReserveUsd);
    const run = spend.runUsd + heldFor(runId);
    if (run + worst > runCap)
      throw new Refusal(
        402,
        'billing_error',
        `the run has spent ${usd(run)} of ${usd(runCap)}; this request could cost ${usd(worst)}`,
      );
    const week = spend.weekUsd + heldAll();
    if (week + worst > caps.weekUsd)
      throw new Refusal(
        402,
        'billing_error',
        `the week has spent ${usd(week)} of ${usd(caps.weekUsd)}; this request could cost ${usd(worst)}`,
      );

    held.set(runId, heldFor(runId) + worst);
    let recorded = false;
    try {
      const answer = await upstream.answer(provider, request);
      const u = answer.usage;
      if (u)
        await ledger.record({
          runId,
          role,
          model: request.model as string,
          tokensIn: u.input + u.cacheRead + u.cacheWrite,
          tokensOut: u.output,
          tokensCached: u.cacheRead,
          costUsd: costUsd(price, u),
        });
      recorded = true;
      const ok = answer.status === 200;
      const contentType = ok && request.stream === true ? 'text/event-stream' : 'application/json';
      return { status: answer.status, contentType, body: answer.body };
    } finally {
      if (recorded) {
        const left = heldFor(runId) - worst;
        if (left > 1e-9) held.set(runId, left);
        else held.delete(runId);
      }
    }
  }

  return {
    async call(provider: Provider, runId: string, role: Role, request: Request): Promise<Reply> {
      try {
        return await call(provider, runId, role, request);
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        return { status: e.status, contentType: 'application/json', body: e.body };
      }
    },
  };
}
