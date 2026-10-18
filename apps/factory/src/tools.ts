// The closed tool set (plan, §7): each role's tools, by name, and a tool's shape whatever model
// calls it. Every call is checked here before it runs; a tool outside the role's list is refused.
import type { z } from 'zod';
import type { Role } from './models.js';

export const TOOLS: Readonly<Record<Role, readonly string[]>> = {
  scout: [
    'browser_open',
    'browser_look',
    'browser_wait',
    'browser_press',
    'browser_type',
    'browser_choose',
    // When words find nothing: what the Scout sees, and acting on it by position.
    'list_page',
    'type_item',
    'press_item',
    'choose_item',
    'name_page',
    'note_answer',
    'note_trouble',
    'note_read',
    'goal_reached',
    'memory_query',
  ],
  // The Supervisor judges each action from its picture, and can reopen any frame of a run.
  supervisor: ['open_frame', 'memory_query', 'record_lesson'],
  // The Supervisor writing the run's lessons, on the budget kept for them.
  lessons: ['open_frame', 'memory_query', 'record_lesson'],
};

/** Of the tools given, those the role may call. */
export const toolsOf = (role: Role, tools: Tool[]): Tool[] =>
  tools.filter((t) => refusal(role, t.name) === null);

/** Why a role may not call a tool, or null when it may. */
export const refusal = (role: Role, tool: string): string | null =>
  TOOLS[role].includes(tool) ? null : `${tool} is not one of the ${role}'s tools`;

/** What a tool gives back: the page as text, and its masked picture when the tool shows one. */
export interface ToolResult {
  text: string;
  image?: Buffer;
}

/** A call refused or failed; the model is told why. */
export class ToolRefusal extends Error {}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  run(input: unknown): Promise<ToolResult>;
}
