// The model gateway (plan §M.6): the agents' only route to the model. Before every request it
// checks the run's and the week's spend against the caps at the request's worst case; after, it
// records what the call cost, per run and role. It fails closed.
import { CAPS, type Caps } from './caps.js';
import type { Ledger } from './ledger.js';
import { costUsd, priceOf, type Price, type Role } from './models.js';
import { Refusal, type Request, type Upstream } from './upstream.js';

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

// An image costs at most this many input tokens, whatever its size in bytes.
const IMAGE_TOKENS = 5_000;

/**
 * The most a request can cost: a token for every byte of it (no token is shorter), a fixed count
 * for each image, every input token at the cache-write rate if it asks for caching, and every
 * output token it allows.
 */
export function worstCaseUsd(price: Price, request: Request): number {
  let images = 0;
  const json = JSON.stringify(request, (_k, v: unknown) => {
    if ((v as { type?: unknown } | null)?.type !== 'image') return v;
    images++;
    return null;
  });
  const tokensIn = Buffer.byteLength(json) + images * IMAGE_TOKENS;
  const inputRate = json.includes('"cache_control"') ? price.cacheWrite : price.input;
  return (tokensIn * inputRate + Number(request.max_tokens) * price.output) / 1e6;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function gateway(opts: { ledger: Ledger; upstream: Upstream; caps?: Caps }) {
  const { ledger, upstream, caps = CAPS } = opts;
  // The worst case of every request still in flight, by run. A call that could not be recorded
  // stays held, so its spend is never forgotten.
  const held = new Map<string, number>();
  const heldFor = (runId: string) => held.get(runId) ?? 0;
  const heldAll = () => [...held.values()].reduce((a, b) => a + b, 0);

  async function call(runId: string, role: Role, request: Request): Promise<Reply> {
    const price = priceOf(request.model);
    if (!price)
      throw new Refusal(
        400,
        'invalid_request_error',
        `no known price for model ${String(request.model)}`,
      );
    if (!Number.isInteger(request.max_tokens) || (request.max_tokens as number) < 1)
      throw new Refusal(400, 'invalid_request_error', 'max_tokens is required');
    // Server tools (web search and the like) are billed beyond tokens, at no price we know.
    const tools = Array.isArray(request.tools)
      ? (request.tools as ({ type?: unknown } | null)[])
      : [];
    if (tools.some((t) => t?.type !== undefined && t?.type !== 'custom'))
      throw new Refusal(400, 'invalid_request_error', 'server tools have no known price');

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
      const answer = await upstream.answer(runId, role, request);
      const u = answer.usage;
      if (u) {
        const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        await ledger.record({
          runId,
          role,
          model: request.model as string,
          tokensIn: u.input_tokens + cached,
          tokensOut: u.output_tokens,
          tokensCached: u.cache_read_input_tokens ?? 0,
          costUsd: upstream.spends ? costUsd(price, u) : 0,
        });
      }
      recorded = true;
      const ok = answer.status === 200;
      const contentType = ok && request.stream === true ? 'text/event-stream' : 'application/json';
      return { status: answer.status, contentType, body: answer.body };
    } finally {
      if (recorded || !upstream.spends) {
        const left = heldFor(runId) - worst;
        if (left > 1e-9) held.set(runId, left);
        else held.delete(runId);
      }
    }
  }

  return {
    async call(runId: string, role: Role, request: Request): Promise<Reply> {
      try {
        return await call(runId, role, request);
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        return { status: e.status, contentType: 'application/json', body: e.body };
      }
    },
  };
}
