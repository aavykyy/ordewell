/**
 * The chat's slash commands, as one table: the host answers exactly these
 * (SlashParser), the input suggests them, and /help lists them. Plain data,
 * so the webview can import it as well as the host.
 */
export interface SlashCommandSpec {
  label: string;
  detail: string;
  insertText: string;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { label: '/planner', detail: 'Pick the planner: harness, model and effort in one flow', insertText: '/planner' },
  { label: '/login', detail: 'Sign the active planner in; /login <runner> signs in a named agent', insertText: '/login' },
  { label: '/key set ', detail: 'Set an API key for a provider', insertText: '/key set ' },
  { label: '/sessions', detail: 'Browse and load saved sessions', insertText: '/sessions' },
  { label: '/new', detail: 'Start a new session (clears current plan)', insertText: '/new' },
  { label: '/fork', detail: 'Continue in a copy of this conversation and its tasks; the original stays as it is', insertText: '/fork' },
  { label: '/rewind', detail: 'Fork the conversation from just before one of your messages (the original is kept)', insertText: '/rewind' },
  { label: '/compact', detail: 'Condense this conversation into a summary; the last two exchanges and all tasks are kept', insertText: '/compact' },
  { label: '/allowlist', detail: 'Restrict which models the planner may auto-assign per runner', insertText: '/allowlist' },
  { label: '/refresh', detail: 'Re-discover runner models (e.g. after enabling an opencode backend)', insertText: '/refresh' },
  { label: '/settings', detail: 'Open the run settings: autonomy, supervisor, merging, autorun, parallel tasks', insertText: '/settings' },
  { label: '/help', detail: 'Show all available commands', insertText: '/help' },
];

/** First words the host answers. Anything else starting with '/' is a skill invocation, and goes to the planner. */
export const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
  SLASH_COMMANDS.map((c) => c.label.trim().slice(1).split(/\s+/)[0]),
);

/**
 * Whether the text names a built-in the host answers itself, as opposed to a
 * discovered skill invocation (or unknown) that goes to the planner. Pure, so
 * the webview can share the rule without importing the host's parser.
 */
export function isBuiltinSlashCommand(text: string): boolean {
  const name = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase();
  return !!name && SLASH_COMMAND_NAMES.has(name);
}

export function slashHelp(): string {
  return SLASH_COMMANDS.map((c) => `${c.label.trim()}: ${c.detail}`).join('\n');
}
