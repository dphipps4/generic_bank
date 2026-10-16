// The closed tool set (plan, §M.4): each role's tools, by name. Every call is checked here before
// it runs; a tool outside the role's list is refused.
import type { Role } from './models.js';

export const TOOLS: Readonly<Record<Role, readonly string[]>> = {
  scout: [
    'browser_open',
    'browser_look',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_wait',
    'browser_type_credential',
    'browser_enter_code',
  ],
  supervisor: ['browser_look'],
  lessons: [],
};

/** Why a role may not call a tool, or null when it may. */
export const refusal = (role: Role, tool: string): string | null =>
  TOOLS[role].includes(tool) ? null : `${tool} is not one of the ${role}'s tools`;
