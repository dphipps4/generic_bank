// make agent: the demo agent on the command line. With a model key it talks to the configured model
// and the member types; without one, the scripted mock plays the model and the member's lines.
import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { assistant } from './agent.js';
import { type ClientCredentials, connect } from './api.js';
import { agentConfig } from './config.js';
import { demoScript, mockModel } from './mock.js';

const cfg = agentConfig();
const api = await connect(
  cfg.API_URL,
  JSON.parse(cfg.AGENT_CLIENT) as ClientCredentials,
  cfg.AGENT_SAVE_TO,
);
const live = Boolean(cfg.ANTHROPIC_API_KEY);
const script = demoScript();
const client = live ? new Anthropic() : new Anthropic({ apiKey: 'mock', fetch: mockModel(script) });
const say = assistant({ client, name: cfg.AGENT_MODEL }, api, {
  onText: (t) => console.log(`\nAssistant: ${t}`),
  onCall: (c) =>
    console.log(
      `  ${c.tool} ${JSON.stringify(c.input)} -> ${c.status}${c.isError ? ' (error)' : ''}`,
    ),
});

console.log(
  live
    ? `The demo agent, on ${cfg.AGENT_PROVIDER} ${cfg.AGENT_MODEL}. Type to the assistant; an empty line ends.`
    : 'The demo agent, scripted: no ANTHROPIC_API_KEY, so a mock plays the model.',
);
try {
  if (live) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question('\nMember: ')).trim();
      if (!line) break;
      await say(line);
    }
    rl.close();
  } else {
    for (const turn of script) {
      console.log(`\nMember: ${turn.member}`);
      await say(turn.member);
    }
  }
} finally {
  await api.close();
}
