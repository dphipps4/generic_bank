// The demo agent's settings. The provider and model are configuration, never code; only Anthropic
// is accepted until the agents move to pi (M7 step 4b), which drives any configured provider.
import { loadConfig } from '@gb/config';
import { z } from 'zod';

export const agentConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig(
    {
      AGENT_PROVIDER: z.enum(['anthropic']).default('anthropic'),
      AGENT_MODEL: z.string().min(1).default('claude-opus-5-5'),
      /** The client id, secret and one-time code, as JSON. */
      AGENT_CLIENT: z.string().min(1),
      API_URL: z.string().url().default('http://localhost:8000'),
      /** Where statements are saved. */
      AGENT_SAVE_TO: z.string().default('.run/agent'),
      ANTHROPIC_API_KEY: z.string().optional(),
    },
    env,
  );
