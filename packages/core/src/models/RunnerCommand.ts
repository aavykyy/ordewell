/**
 * What a runner command is to the runner that offers it: a `builtin` of the
 * harness itself (`/compact`, `/model`), a `skill`, or any other `command` —
 * a user's or a project's custom command, an MCP prompt.
 */
export type RunnerCommandKind = 'command' | 'skill' | 'builtin';

/**
 * One slash command a task's runner offers, as the runner itself reported it
 * (#66). Ordewell transports it and records it; it never interprets one.
 */
export interface RunnerCommand {
  name: string;
  description: string;
  /** How the runner describes its arguments (`<model>`, `[name]`); absent when it takes none it names. */
  argumentHint?: string;
  kind: RunnerCommandKind;
  /** Other names the runner answers to for the same command. */
  aliases?: string[];
}

/** A model as a runner lists it: the id it accepts, which is the one a plan holds, and the name it shows. */
export interface RunnerModelRef {
  model: string;
  label?: string;
}

/** An MCP server a runner loaded for a task, and the state the runner reported it in. */
export interface RunnerMcpServer {
  name: string;
  status?: string;
}

/** The command `name` names, by its own name or an alias. */
export function findRunnerCommand(commands: readonly RunnerCommand[], name: string): RunnerCommand | undefined {
  return commands.find((c) => c.name === name || c.aliases?.includes(name));
}
