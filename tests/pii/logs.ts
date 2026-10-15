// Everything this process logs while the runs happen: what is written to stdout and stderr, and every
// console call. Started before any service is built, so each service's logger writes through it, as
// it writes to the container's stdout in compose.
import { format } from 'node:util';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

export function captureLogs() {
  const chunks: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const saved = METHODS.map((m) => console[m]);
  const sink = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  for (const m of METHODS)
    console[m] = (...args: unknown[]) => void chunks.push(`${format(...args)}\n`);
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim()),
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
      METHODS.forEach((m, i) => (console[m] = saved[i]!));
    },
  };
}
