// Measuring sight, before any live run (plan, step 0): can these models list a page correctly
// from its picture, and place their boxes well enough to click a field? Each captured page of
// bank 2 (its masked picture, and the truth about it from the browser) goes to the Scout's model
// for its list, and to the Supervisor's to check that list. The scoring is code, against the
// truth: a control is found when the model's box middle lands inside the real one, with a kind that
// fits; a picture label is read when its field's item says the words the picture draws.
import type { Box } from '@gb/runtime';
import { type Agent, turn } from './agent.js';

export interface Truth {
  page: string;
  controls: { kind: string; name: string; box: Box }[];
  labelPictures: Box[];
  pictureWords: string[];
}

export interface Listed {
  id: string;
  kind: string;
  label: string;
  labelFrom: 'text' | 'image' | 'none';
  box: Box;
  labelBox?: Box;
}

export interface Score {
  page: string;
  /** Controls a person can act on, and how many the model placed. */
  controls: number;
  found: number;
  /** Fields labeled with a picture of words, and how many the model read right. */
  pictureFields: number;
  read: number;
  /** Things the model listed as controls where the page has none. */
  invented: number;
  /** The controls it missed, by kind and name. */
  missed: string[];
}

const ACTS = ['field', 'password field', 'button', 'link', 'checkbox', 'list'];
/** Kinds a person treats alike: anything typed in, anything pressed. */
const family = (k: string) =>
  k === 'password field' ? 'field' : k === 'link' || k === 'checkbox' ? 'button' : k;
const middle = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p: { x: number; y: number }, b: Box, slack = 4) =>
  p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack;
const words = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** How well a model's list of a page matches the truth about it. */
export function score(truth: Truth, items: Listed[]): Score {
  const acts = truth.controls.filter((c) => ACTS.includes(c.kind));
  const listed = items.filter((i) => ACTS.includes(i.kind));
  const matchOf = (c: Truth['controls'][number]) =>
    listed.find((i) => family(i.kind) === family(c.kind) && inside(middle(i.box), c.box));
  const found = acts.filter((c) => matchOf(c));
  // A field labeled with a picture: the field drawn just right of the picture, on its line.
  const pictureFields = truth.labelPictures.flatMap((p) => {
    const mid = p.y + p.h / 2;
    const f = acts
      .filter(
        (c) =>
          family(c.kind) !== 'button' &&
          c.box.x >= p.x + p.w - 2 &&
          mid >= c.box.y - 4 &&
          mid <= c.box.y + c.box.h + 4,
      )
      .sort((a, b) => a.box.x - b.box.x)[0];
    return f ? [f] : [];
  });
  const said = new Set(truth.pictureWords.map(words));
  const read = pictureFields.filter((f) => {
    const m = matchOf(f);
    return m && m.labelFrom === 'image' && said.has(words(m.label));
  });
  const invented = listed.filter((i) => !acts.some((c) => inside(middle(i.box), c.box)));
  return {
    page: truth.page,
    controls: acts.length,
    found: found.length,
    pictureFields: pictureFields.length,
    read: read.length,
    invented: invented.length,
    missed: acts.filter((c) => !matchOf(c)).map((c) => `${c.kind} "${c.name}"`),
  };
}

const LIST = `You look at a picture of one page of a bank's staff console, 1280 by 900 pixels, and list everything a person could act on or read there. For each item: an id (i1, i2, …), its kind (field, password field, button, link, checkbox, list, message, heading, text), its label as you read it (words drawn as text, or a picture of words: read the picture), where the label came from (text, image or none), and its box in the picture's pixels (x, y, width, height). For a field or a list, also give the box of its label. Some values are painted out in white: list the field, not the value. List only what you can place on the picture.`;

const LIST_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          label: { type: 'string' },
          labelFrom: { type: 'string', enum: ['text', 'image', 'none'] },
          box: BOX(),
          labelBox: BOX(),
        },
        required: ['id', 'kind', 'label', 'labelFrom', 'box'],
      },
    },
  },
  required: ['items'],
};
function BOX() {
  return {
    type: 'object',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      w: { type: 'number' },
      h: { type: 'number' },
    },
    required: ['x', 'y', 'w', 'h'],
  };
}

const CHECK = `You check another agent's list of a page against the page's picture: is anything you can see missing from it, is anything listed that is not there, is any label misread, is any box not where the thing is drawn? Answer with your verdict and what is wrong, citing items by id.`;

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['right', 'wrong'] },
    says: { type: 'string' },
  },
  required: ['verdict', 'says'],
};

/** One page measured: the Scout's model lists it, the Supervisor's checks the list, code scores it. */
export async function measurePage(
  agents: { scout: Agent; supervisor: Agent },
  picture: Buffer,
  truth: Truth,
): Promise<Score & { supervisor: string }> {
  const listed = await turn(agents.scout, {
    system: LIST,
    say: 'List this page.',
    image: picture,
    answer: LIST_SCHEMA,
    maxTokens: 8000,
  });
  const items = (JSON.parse(listed.text) as { items: Listed[] }).items;
  const checked = await turn(agents.supervisor, {
    system: CHECK,
    say: `The list:\n${JSON.stringify(items)}`,
    image: picture,
    answer: CHECK_SCHEMA,
    maxTokens: 8000,
  });
  const c = JSON.parse(checked.text) as { verdict: string; says: string };
  return { ...score(truth, items), supervisor: `${c.verdict}: ${c.says}` };
}

/** The scores as a table a person reads. */
export function table(scores: (Score & { supervisor: string })[]): string {
  const rows = scores.map(
    (s) =>
      `| ${s.page} | ${s.found} of ${s.controls} | ${s.pictureFields ? `${s.read} of ${s.pictureFields}` : '-'} | ${s.invented} | ${s.missed.join(', ') || '-'} | ${s.supervisor.replace(/\|/g, '/').slice(0, 160)} |`,
  );
  return [
    '| Page | Controls placed | Picture labels read | Invented | Missed | The Supervisor said |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}
