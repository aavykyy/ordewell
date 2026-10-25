import { describe, it, expect } from 'vitest';
import type { ApprovalBlock, DisplayBlock, MessageBlock, SubagentBlock, ThinkingDisplayBlock, ToolBlock, ToolStatus } from '@ordewell/core';
import { activitySummary, conversationItems } from '../activity';

let n = 0;
const id = () => `x${++n}`;
const message = (role: MessageBlock['role'], over: Partial<MessageBlock> = {}): MessageBlock => ({ type: 'message', id: id(), role, text: 'hi', streaming: false, ...over });
const thinking = (over: Partial<ThinkingDisplayBlock> = {}): ThinkingDisplayBlock => ({ type: 'thinking', id: id(), text: 'hm', streaming: false, ...over });
const tool = (kind: string, status: ToolStatus = 'ok', over: Partial<ToolBlock> = {}): ToolBlock => ({
  type: 'tool', id: id(), tool: kind, headline: { name: kind, keyArg: '' }, args: '{}', status, output: '', outputLineCount: 0, ...over,
});
const agentTool = (label: string, status: ToolStatus = 'ok', over: Partial<ToolBlock> = {}) => tool('agent_tool', status, { toolLabel: label, ...over });
const subagent = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  type: 'subagent', id: id(), subagentId: id(), brief: 'look', status: 'done', children: [], digest: '', ...over,
});
const approval = (status: ApprovalBlock['status']): ApprovalBlock => ({
  type: 'approval', id: id(), approvalId: id(), kind: 'shell_command', subject: 'npm test', scope: 'npm', status,
});
const skill = (name: string, invokedBy: 'user' | 'planner' = 'planner'): DisplayBlock => ({
  type: 'skill_load', id: id(), invokedBy, name, source: 'workspace', path: `.ordewell/skills/${name}/SKILL.md`,
});
const text = (blocks: DisplayBlock[]) => activitySummary(blocks).text;

describe('activitySummary', () => {
  it('reads a run of calls as one sentence, counted by kind in the order they first ran', () => {
    expect(text([
      tool('bash'), tool('bash'), tool('fetch', 'error'), tool('bash'), tool('web_search'), tool('fetch', 'error'), tool('bash'), agentTool('TodoWrite'),
    ])).toBe('Ran 4 commands, fetched 2 pages (2 failed), searched the web, used a tool');
  });

  it('says one of a kind with an article', () => {
    expect(text([tool('bash')])).toBe('Ran a command');
    expect(text([tool('read_file')])).toBe('Read a file');
    expect(text([tool('list_dir')])).toBe('Listed a directory');
    expect(text([tool('list_dir'), tool('list_dir')])).toBe('Listed 2 directories');
    expect(text([agentTool('mcp__github__create_issue')])).toBe('Used an MCP tool');
  });

  it('counts the files one read_files call names', () => {
    expect(text([tool('read_files', 'ok', { args: '{"paths":["a.ts","b.ts","c.ts"]}' }), tool('read_file')])).toBe('Read 4 files');
  });

  it('never claims a call still running has run', () => {
    expect(text([tool('bash', 'pending')])).toBe('Running a command');
    expect(text([tool('bash'), tool('bash'), tool('bash', 'pending')])).toBe('Ran 2 commands (1 more running)');
    expect(text([tool('web_search'), tool('web_search', 'pending')])).toBe('Searched the web (1 more running)');
    expect(activitySummary([tool('bash', 'pending')]).running).toBe(true);
    expect(activitySummary([tool('bash')]).running).toBe(false);
  });

  it('tells a failure, a denial and an interruption apart', () => {
    const summary = activitySummary([tool('bash', 'error'), tool('bash', 'denied'), tool('bash', 'interrupted'), tool('bash')]);
    expect(summary.text).toBe('Ran 4 commands (1 failed, 1 denied, 1 interrupted)');
    expect(summary.failed).toBe(true);
    expect(activitySummary([tool('bash')]).failed).toBe(false);
  });

  it('counts repeated searches as times, and code searches apart from the web', () => {
    expect(text([tool('grep'), tool('glob'), tool('find_symbol')])).toBe('Searched the code 3 times');
    expect(text([tool('web_search'), tool('web_search')])).toBe('Searched the web 2 times');
  });

  it('counts edits as edits, never as files, failed ones included', () => {
    expect(text([
      agentTool('Edit', 'ok', { diff: { added: 1, removed: 0 } }), agentTool('Write', 'error'), agentTool('Update'),
    ])).toBe('Made 3 edits (1 failed)');
  });

  it('counts a subagent once, its own steps not at all, and its wrapper call as the agent it starts', () => {
    expect(text([subagent({ children: [tool('bash'), tool('bash'), thinking()] })])).toBe('Delegated to an agent');
    expect(text([agentTool('Task', 'pending')])).toBe('Delegating to an agent');
    expect(text([tool('spawn_research_agent', 'pending', { spawns: 'sa' })])).toBe('Delegating to an agent');
    expect(text([subagent(), subagent({ status: 'failed' }), subagent({ status: 'stopped' }), subagent({ status: 'running' })]))
      .toBe('Delegated to 3 agents (1 failed, 1 stopped, 1 more running)');
  });

  it('reads thinking alone as thought, and live thinking as still going', () => {
    expect(text([thinking()])).toBe('Thought');
    expect(text([thinking({ streaming: true })])).toBe('Thinking…');
    expect(text([thinking(), tool('bash')])).toBe('Ran a command');
    expect(text([tool('bash'), thinking({ streaming: true })])).toBe('Ran a command, thinking…');
    expect(activitySummary([thinking({ streaming: true })]).running).toBe(true);
  });

  it('names setup notices for what they are', () => {
    expect(text([skill('tdd'), skill('docs')])).toBe('Loaded 2 skills');
    expect(text([{ type: 'runner_loaded', id: id(), commands: [], mcpServers: [] }])).toBe("Loaded the runner's setup");
    expect(text([{ type: 'compaction', id: id(), trigger: 'auto' }])).toBe('Compacted the context');
  });

  it('does not count an answered approval beside the call it was about', () => {
    expect(text([tool('bash'), approval('granted')])).toBe('Ran a command');
    expect(text([approval('denied')])).toBe('Settled an approval request');
  });

  it('counts a skill the planner loaded once, from its call and its notice together', () => {
    const load = (status: ToolStatus = 'ok') => agentTool('mcp__ordewell__load_skill', status, { args: '{"name":"tdd"}' });
    expect(text([load(), skill('tdd')])).toBe('Loaded a skill');
    expect(text([load()])).toBe('Loaded a skill');
    expect(text([skill('tdd')])).toBe('Loaded a skill');
    expect(text([load('pending')])).toBe('Loading a skill');
    expect(text([load(), skill('tdd'), load('error')])).toBe('Loaded 2 skills (1 failed)');
    expect(text([tool('load_skill'), skill('tdd'), tool('bash')])).toBe('Loaded a skill, ran a command');
  });

  it('checks the task tools as one kind', () => {
    expect(text([tool('task_query'), tool('task_output'), tool('task_diff')])).toBe('Checked tasks 3 times');
  });
});

describe('conversationItems', () => {
  const shape = (blocks: DisplayBlock[]) => conversationItems(blocks).map((item) => (item.kind === 'block' ? item.block.id : item.blocks.map((b) => b.id)));

  it('folds each run of activity between ordinary messages into one group, in order', () => {
    const blocks = [message('user'), thinking(), tool('bash'), message('planner'), tool('bash'), subagent(), message('agent'), message('supervisor')];
    const ids = blocks.map((b) => b.id);
    expect(shape(blocks)).toEqual([ids[0], [ids[1], ids[2]], ids[3], [ids[4], ids[5]], ids[6], ids[7]]);
  });

  it('keys a group by its first block', () => {
    const blocks = [thinking(), tool('bash')];
    const [group] = conversationItems(blocks);
    expect(group.kind === 'activity' && group.key).toBe(`activity:${blocks[0].id}`);
  });

  it('keeps the skills a user\'s message loaded under that message, and folds in the ones the planner loaded', () => {
    const blocks = [message('user'), skill('tdd', 'user'), tool('bash'), skill('docs', 'planner'), tool('bash')];
    const ids = blocks.map((b) => b.id);
    expect(shape(blocks)).toEqual([ids[0], ids[1], [ids[2], ids[3], ids[4]]]);
  });

  it('keeps a waiting approval, an error, a notice, a plan marker, a runner command and a handoff out of any group', () => {
    const blocks: DisplayBlock[] = [
      tool('bash'), approval('pending'), tool('bash'), message('error'), tool('bash'), message('system'), tool('bash'),
      { type: 'plan', id: id(), status: 'generated', text: '' }, tool('bash'),
      { type: 'command', id: id(), name: 'compact', status: 'done', output: '' }, tool('bash'),
      { type: 'handoff', id: id(), handoff: { summary: 's', findings: [], findingCount: 0 } }, tool('bash'), message('wake_up'),
    ];
    const kinds = conversationItems(blocks).map((item) => (item.kind === 'block' ? item.block.type : 'activity'));
    expect(kinds).toEqual(['activity', 'approval', 'activity', 'message', 'activity', 'message', 'activity', 'plan', 'activity', 'command', 'activity', 'handoff', 'activity', 'message']);
  });

  it('takes an answered approval into the run it belongs to', () => {
    const blocks = [tool('bash'), approval('granted'), tool('bash')];
    expect(shape(blocks)).toEqual([blocks.map((b) => b.id)]);
  });

  it('leaves the usage line out: it is drawn below the conversation', () => {
    const usage: DisplayBlock = { type: 'usage', id: id(), totals: {} };
    expect(shape([tool('bash'), usage]).flat()).not.toContain(usage.id);
  });
});
