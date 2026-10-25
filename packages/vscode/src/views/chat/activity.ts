import type { DisplayBlock, ToolBlock } from '@ordewell/core';
import { isFileEditTool } from '@ordewell/core/plan-utils';

/*
 * The conversation as VS Code folds it: each run of activity between two
 * ordinary messages — thinking, calls, subagents, setup notices, answered
 * approvals — is one quiet group that says in a sentence what it did. Only the
 * blocks core already built are read; nothing here knows the event stream.
 */

export type ConversationItem =
  | { kind: 'block'; block: DisplayBlock }
  | { kind: 'activity'; key: string; blocks: readonly DisplayBlock[] };

/**
 * What a group folds. A waiting approval stays out, where it can be answered,
 * and so does what a user's own `/name` loaded or will attach: it answers
 * their message, right under it.
 */
function isActivity(block: DisplayBlock): boolean {
  switch (block.type) {
    case 'thinking':
    case 'tool':
    case 'subagent':
    case 'runner_loaded':
    case 'compaction':
      return true;
    case 'skill_load':
      return block.invokedBy === 'planner';
    case 'approval':
      return block.status !== 'pending';
    default:
      return false;
  }
}

/**
 * The blocks in order, each run of activity as one group keyed by its first
 * block, whose id is stable for as long as the block exists.
 */
export function conversationItems(blocks: readonly DisplayBlock[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let run: DisplayBlock[] = [];
  const close = () => {
    if (run.length > 0) items.push({ kind: 'activity', key: `activity:${run[0].id}`, blocks: run });
    run = [];
  };
  for (const block of blocks) {
    // The usage line is pinned below the conversation, so it splits nothing.
    if (block.type === 'usage') continue;
    if (isActivity(block)) {
      run.push(block);
    } else {
      close();
      items.push({ kind: 'block', block });
    }
  }
  close();
  return items;
}

type Ending = 'ok' | 'failed' | 'denied' | 'interrupted' | 'stopped' | 'running';

/**
 * How one kind reads: a counted noun (`ran 3 commands`) or, for an act with
 * no object worth counting, how many times (`searched the web 2 times`).
 */
interface Kind {
  done: string;
  doing: string;
  noun?: readonly [singular: string, plural: string, article: string];
}

const KINDS = {
  command: { done: 'ran', doing: 'running', noun: ['command', 'commands', 'a'] },
  edit: { done: 'made', doing: 'making', noun: ['edit', 'edits', 'an'] },
  read: { done: 'read', doing: 'reading', noun: ['file', 'files', 'a'] },
  list: { done: 'listed', doing: 'listing', noun: ['directory', 'directories', 'a'] },
  code: { done: 'searched the code', doing: 'searching the code' },
  web: { done: 'searched the web', doing: 'searching the web' },
  fetch: { done: 'fetched', doing: 'fetching', noun: ['page', 'pages', 'a'] },
  agent: { done: 'delegated to', doing: 'delegating to', noun: ['agent', 'agents', 'an'] },
  tasks: { done: 'checked tasks', doing: 'checking tasks' },
  mcp: { done: 'used', doing: 'using', noun: ['MCP tool', 'MCP tools', 'an'] },
  tool: { done: 'used', doing: 'using', noun: ['tool', 'tools', 'a'] },
  skill: { done: 'loaded', doing: 'loading', noun: ['skill', 'skills', 'a'] },
  setup: { done: "loaded the runner's setup", doing: "loading the runner's setup" },
  compaction: { done: 'compacted the context', doing: 'compacting the context' },
  approval: { done: 'settled', doing: 'settling', noun: ['approval request', 'approval requests', 'an'] },
} satisfies Record<string, Kind>;

type KindName = keyof typeof KINDS;

const TOOL_KIND: Partial<Record<string, KindName>> = {
  bash: 'command',
  read_file: 'read',
  read_files: 'read',
  list_dir: 'list',
  glob: 'code',
  grep: 'code',
  find_symbol: 'code',
  web_search: 'web',
  fetch: 'fetch',
  spawn_research_agent: 'agent',
  task_query: 'tasks',
  task_output: 'tasks',
  task_diff: 'tasks',
};

// A coding agent's own subagent tool: its call is the agent until the agent
// announces itself and takes the call's place.
const AGENT_TOOLS = new Set(['task', 'agent']);
const MCP_TOOL = /^mcp__(?!ordewell__)/i;
// `load_skill` as each harness names it: bare, `mcp__ordewell__load_skill`, `ordewell_load_skill`.
const LOAD_SKILL = /(?:^|_)load_skill$/i;

const TOOL_ENDING: Record<ToolBlock['status'], Ending> = {
  pending: 'running',
  ok: 'ok',
  error: 'failed',
  denied: 'denied',
  interrupted: 'interrupted',
};

function toolKind(block: ToolBlock): KindName {
  const mapped = TOOL_KIND[block.tool];
  if (mapped) return mapped;
  if (block.spawns) return 'agent';
  const label = block.toolLabel?.trim() ?? '';
  if (LOAD_SKILL.test(label || block.tool)) return 'skill';
  if (block.diff || isFileEditTool(label)) return 'edit';
  if (AGENT_TOOLS.has(label.toLowerCase())) return 'agent';
  return MCP_TOOL.test(label) ? 'mcp' : 'tool';
}

// One read_files call reads every path it names; anything it cannot say is one.
function filesRead(block: ToolBlock): number {
  if (block.tool !== 'read_files') return 1;
  try {
    const parsed: unknown = JSON.parse(block.args);
    const paths = parsed && typeof parsed === 'object' && 'paths' in parsed ? parsed.paths : undefined;
    return Array.isArray(paths) && paths.length > 0 ? paths.length : 1;
  } catch {
    return 1;
  }
}

interface Tally {
  kind: KindName;
  endings: Partial<Record<Ending, number>>;
}

function sightings(block: DisplayBlock): Array<{ kind: KindName; ending: Ending; count: number }> {
  switch (block.type) {
    case 'tool':
      return [{ kind: toolKind(block), ending: TOOL_ENDING[block.status], count: filesRead(block) }];
    case 'subagent':
      return [{ kind: 'agent', ending: block.status === 'done' ? 'ok' : block.status, count: 1 }];
    case 'skill_load':
      return [{ kind: 'skill', ending: 'ok', count: 1 }];
    case 'runner_loaded':
      return [{ kind: 'setup', ending: 'ok', count: 1 }];
    case 'compaction':
      return [{ kind: 'compaction', ending: 'ok', count: 1 }];
    case 'approval':
      return [{ kind: 'approval', ending: 'ok', count: 1 }];
    default:
      return [];
  }
}

/**
 * A skill the planner loaded is both its `load_skill` call and the notice
 * that names it, and a reload may keep either: a load counts once, as many
 * as the larger side says.
 */
function pairSkillLoads(blocks: readonly DisplayBlock[], tallies: Map<KindName, Tally>): void {
  const tally = tallies.get('skill');
  if (!tally) return;
  const notices = blocks.filter((b) => b.type === 'skill_load').length;
  const calls = blocks.filter((b) => b.type === 'tool' && b.status === 'ok' && toolKind(b) === 'skill').length;
  tally.endings.ok = Math.max(notices, calls);
  if (tally.endings.ok === 0) delete tally.endings.ok;
}

const TROUBLE: readonly Ending[] = ['failed', 'denied', 'interrupted', 'stopped'];

function counted(kind: Kind, count: number): string {
  if (!kind.noun) return count === 1 ? '' : ` ${count} times`;
  const [singular, plural, article] = kind.noun;
  return count === 1 ? ` ${article} ${singular}` : ` ${count} ${plural}`;
}

function phrase({ kind: name, endings }: Tally): string {
  const kind: Kind = KINDS[name];
  const running = endings.running ?? 0;
  const settled = Object.entries(endings).reduce((sum, [ending, count]) => sum + (ending === 'running' ? 0 : count), 0);
  if (settled === 0) return `${kind.doing}${counted(kind, running)}`;
  const notes = TROUBLE.flatMap((ending) => (endings[ending] ? [`${endings[ending]} ${ending}`] : []));
  if (running > 0) notes.push(`${running} more running`);
  return `${kind.done}${counted(kind, settled)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

export interface ActivitySummary {
  /** One sentence: what the group did, in the order each kind first ran. */
  text: string;
  /** Something in it has not finished. */
  running: boolean;
  /** Something in it failed, was denied or was cut short. */
  failed: boolean;
}

/**
 * What a group did, from the blocks' own facts alone: a call is counted by its
 * kind and how it ended, never by what a script inside it may have done; a
 * subagent counts once, its steps not at all; an answered approval is counted
 * only when there is no call beside it to count instead.
 */
export function activitySummary(blocks: readonly DisplayBlock[]): ActivitySummary {
  const tallies = new Map<KindName, Tally>();
  for (const block of blocks) {
    for (const { kind, ending, count } of sightings(block)) {
      const tally = tallies.get(kind) ?? { kind, endings: {} };
      tally.endings[ending] = (tally.endings[ending] ?? 0) + count;
      tallies.set(kind, tally);
    }
  }
  if (tallies.size > 1) tallies.delete('approval');
  pairSkillLoads(blocks, tallies);
  const thinking = blocks.filter((b) => b.type === 'thinking');
  const thinkingLive = thinking.some((b) => b.streaming);
  const phrases = [...tallies.values()].map(phrase);
  if (thinkingLive) phrases.push('thinking…');
  else if (phrases.length === 0 && thinking.length > 0) phrases.push('thought');
  const sentence = phrases.join(', ');
  const endings = [...tallies.values()].flatMap((t) => Object.keys(t.endings) as Ending[]);
  return {
    text: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    running: thinkingLive || endings.includes('running'),
    failed: endings.some((ending) => TROUBLE.includes(ending)),
  };
}
