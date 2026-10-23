// The notifier: tells a Slack channel when something needs a person, or a run failed, with a link
// to the Console page where a person acts on it. It reads the control database and posts; it never
// changes a run.
import { z } from 'zod';
import { loadConfig } from '@gb/config';
import { sql as connect } from '@gb/db';
import { pending, told } from './notices.js';
import { channelId, post, tokenFrom } from './slack.js';

const cfg = loadConfig(
  {
    CONTROL_DATABASE_URL: z.url(),
    SLACK_CHANNEL: z.string().min(1),
    CONSOLE_URL: z.url(),
    BANK_INBOX_URL: z.url(),
    NOTIFIER_EVERY_MS: z.coerce.number().int().min(1000).default(5000),
    SLACK_TOKEN: z.string().optional(),
    REPLIT_CONNECTORS_HOSTNAME: z.string().optional(),
    REPL_IDENTITY: z.string().optional(),
  },
  process.env,
);
const sql = connect(cfg.CONTROL_DATABASE_URL);
const token = tokenFrom(cfg);
const channel = await channelId(token, cfg.SLACK_CHANNEL);
const links = { console: cfg.CONSOLE_URL.replace(/\/$/, ''), inbox: cfg.BANK_INBOX_URL };
console.log(`notifier: posting to ${cfg.SLACK_CHANNEL} (${channel})`);

for (;;) {
  try {
    for (const n of await pending(sql, links)) {
      await told(sql, n, channel, await post(token, channel, n.text));
      console.log(`notifier: told Slack of ${n.kind} ${n.ref}`);
    }
  } catch (e) {
    // Slack or the database is away for a moment: the next round tells what this one could not.
    console.error(`notifier: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, cfg.NOTIFIER_EVERY_MS));
}
