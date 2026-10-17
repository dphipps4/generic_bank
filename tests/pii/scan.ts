// What the PII suite looks for and how it looks. Every needle is a seeded value with a name that
// says what it is without repeating it, so a failure names the place and the kind of value, never
// the value itself.
import { PNG } from 'pngjs';
import type { Box } from '../../packages/runtime/src/index.js';

export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}
export const decodePng = (png: Buffer): Image => PNG.sync.read(png);

export interface Needle {
  what: string;
  re: RegExp;
}

export interface Hit {
  where: string;
  what: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A number, found only where no other digit touches it: 40017732 is not inside 400177321. */
export const digits = (what: string, v: string): Needle => ({
  what,
  re: new RegExp(`(?<!\\d)${escape(v)}(?!\\d)`, 'g'),
});

/** A word or a phrase, found only as a whole word. */
export const words = (what: string, v: string, o: { anyCase?: boolean } = {}): Needle => ({
  what,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, `gu${o.anyCase ? 'i' : ''}`),
});

/** A secret, found anywhere. */
export const anywhere = (what: string, v: string): Needle => ({
  what,
  re: new RegExp(escape(v), 'g'),
});

/** The text with every needle replaced by its name: safe to print in a failure. */
export function redact(text: string, needles: Needle[]): string {
  let out = text;
  for (const n of needles) out = out.replace(n.re, `‹${n.what}›`);
  return out;
}

/**
 * Every seeded value the text holds, once per place: where needles overlap (a name and its surname,
 * the same member at two banks) they are one hit that names them all. The excerpt is redacted.
 */
export function scanText(text: string, needles: Needle[], where: string): Hit[] {
  const found: { from: number; to: number; what: string[] }[] = [];
  for (const n of needles) {
    n.re.lastIndex = 0;
    for (let m = n.re.exec(text); m; m = n.re.exec(text)) {
      const from = m.index;
      const to = m.index + m[0].length;
      const same = found.find((f) => f.from < to && from < f.to);
      if (same) {
        same.from = Math.min(same.from, from);
        same.to = Math.max(same.to, to);
        if (!same.what.includes(n.what)) same.what.push(n.what);
      } else found.push({ from, to, what: [n.what] });
      if (m[0].length === 0) n.re.lastIndex++;
    }
    n.re.lastIndex = 0;
  }
  return found
    .sort((a, b) => a.from - b.from)
    .map((f) => {
      const excerpt = redact(text.slice(Math.max(0, f.from - 60), f.to + 60), needles);
      return { where: `${where}: …${excerpt.replace(/\s+/g, ' ')}…`, what: f.what.join(' / ') };
    });
}

// ── The control database ─────────────────────────────────────────────────────

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const asText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('latin1');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export interface Row {
  table: string;
  id: string;
  /** The row as it reads, to tell a row the runs wrote from one that was there before them. */
  key: string;
  columns: [string, string][];
}

/** Every row of every table in the database, each column as text. */
export async function everyRow(sql: Sql): Promise<Row[]> {
  const tables = await sql.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1, 2`,
  );
  const out: Row[] = [];
  for (const { s, t } of tables.rows) {
    const table = s === 'public' ? t : `${s}.${t}`;
    const rows = await sql.query<Record<string, unknown>>(`SELECT * FROM "${s}"."${t}"`);
    rows.rows.forEach((r, i) => {
      const columns = Object.entries(r)
        .map(([c, v]) => [c, asText(v)] as const)
        .filter((e): e is [string, string] => e[1] !== null);
      out.push({
        table,
        id: String(r.id ?? `#${i + 1}`),
        key: `${table}\u0000${JSON.stringify(columns)}`,
        columns,
      });
    });
  }
  return out;
}

/** Every needle in a row, by column. */
export function scanRow(r: Row, needles: Needle[]): Hit[] {
  return r.columns.flatMap(([c, v]) =>
    scanText(v, needles, `control database, "${r.table}" row ${r.id}, column "${c}"`),
  );
}

// ── Pictures ─────────────────────────────────────────────────────────────────

/** What the bank drew, as the screen model read it before masking; the picture itself is not kept. */
/**
 * The share of a box's pixels the mask did not cover. The mask paints exactly three greys: a white
 * fill, a grey outline and darker grey asterisks; text the bank drew, even in light grey, leaves
 * other values at the edges of its letters. Only the part of the box on screen counts.
 */
export function uncoveredShare(img: Image, b: Box): number | null {
  let all = 0;
  let open = 0;
  for (let y = Math.max(0, Math.ceil(b.y)); y < Math.min(img.height, b.y + b.h); y++) {
    for (let x = Math.max(0, Math.ceil(b.x)); x < Math.min(img.width, b.x + b.w); x++) {
      const i = (y * img.width + x) * 4;
      const v = img.data[i]!;
      all++;
      if (!(v === img.data[i + 1] && v === img.data[i + 2] && MASK_GREYS.includes(v))) open++;
    }
  }
  return all === 0 ? null : open / all;
}
const MASK_GREYS = [255, 190, 120];

/**
 * A PNG's text, apart from its pixels: every chunk but the image data, where a writer could leave
 * words (tEXt, iTXt, a comment). The compressed pixels are judged by what they show, above.
 */
export function pngText(png: Buffer): string {
  const out: string[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type !== 'IDAT') out.push(`${type} ${png.toString('latin1', at + 8, at + 8 + len)}`);
    at += 12 + len;
  }
  return out.join('\n');
}
