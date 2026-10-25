import type { UsageLine } from '../models/Usage';
import type { DisplayBlock, SubagentBlock, SubagentChild, SubagentStatus } from './blocks';
import { subagentBlock, usageBlock } from './records';

/*
 * The block-list operations both reducers are built from — the planner
 * conversation (`reduce.ts`) and a structured task's log (`taskLog.ts`) — so
 * a subagent, a streaming run of text or the usage line behaves the same in
 * either view.
 */

/** What every view over display blocks holds; each view adds its own state beside it. */
export interface BlockList {
  readonly blocks: readonly DisplayBlock[];
  readonly nextId: number;
}

/** The top level of the view (`null`), or the index of the subagent whose children are meant. */
export type Lane = number | null;

export function findLastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return i;
  return -1;
}

export function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = items.slice();
  next[index] = item;
  return next;
}

// The usage line always sits last, so everything else lands above it.
function insertTop(blocks: readonly DisplayBlock[], block: DisplayBlock): DisplayBlock[] {
  const last = blocks[blocks.length - 1];
  return last?.type === 'usage' ? [...blocks.slice(0, -1), block, last] : [...blocks, block];
}

export function append<V extends BlockList>(view: V, make: (id: string) => DisplayBlock): V {
  return { ...view, blocks: insertTop(view.blocks, make(`b${view.nextId}`)), nextId: view.nextId + 1 };
}

export function subagentAt(view: BlockList, lane: number): SubagentBlock {
  const block = view.blocks[lane];
  if (block.type !== 'subagent') throw new Error(`block ${lane} is not a subagent`);
  return block;
}

export function laneBlocks(view: BlockList, lane: Lane): readonly DisplayBlock[] {
  return lane === null ? view.blocks : subagentAt(view, lane).children;
}

function setChildren<V extends BlockList>(view: V, lane: number, children: readonly SubagentChild[]): V {
  return { ...view, blocks: replaceAt(view.blocks, lane, { ...subagentAt(view, lane), children }) };
}

export function laneReplace<V extends BlockList>(view: V, lane: Lane, index: number, block: SubagentChild): V {
  if (lane === null) return { ...view, blocks: replaceAt(view.blocks, index, block) };
  return setChildren(view, lane, replaceAt(subagentAt(view, lane).children, index, block));
}

export function laneAppend<V extends BlockList>(view: V, lane: Lane, make: (id: string) => SubagentChild): V {
  if (lane === null) return append(view, make);
  const children = [...subagentAt(view, lane).children, make(`b${view.nextId}`)];
  return { ...setChildren(view, lane, children), nextId: view.nextId + 1 };
}

function isStreaming(block: DisplayBlock): boolean {
  return (block.type === 'message' || block.type === 'thinking') && block.streaming;
}

export function sealed<B extends DisplayBlock>(block: B): B {
  return isStreaming(block) ? { ...block, streaming: false } : block;
}

/**
 * Output landed at `keep` in the lane, so nothing else there is still
 * streaming: one lane has one voice at a time, and a block left marked as
 * streaming would keep its cursor after its text had moved on.
 */
export function sealLane<V extends BlockList>(view: V, lane: Lane, keep: number): V {
  const blocks = laneBlocks(view, lane);
  if (!blocks.some((b, i) => i !== keep && isStreaming(b))) return view;
  if (lane === null) return { ...view, blocks: view.blocks.map((b, i) => (i === keep ? b : sealed(b))) };
  return setChildren(view, lane, subagentAt(view, lane).children.map((b, i) => (i === keep ? b : sealed(b))));
}

/** Append output to the lane, which then speaks through it alone. */
export function appendOutput<V extends BlockList>(view: V, lane: Lane, make: (id: string) => SubagentChild): V {
  const next = laneAppend(view, lane, make);
  return sealLane(next, lane, findLastIndex(laneBlocks(next, lane), (b) => b.type !== 'usage'));
}

/**
 * The subagent's block, created on first sighting: its activity can arrive
 * before (or without) its start. The call that spawns it becomes the block,
 * keeping the call's id and position — the call and the subagent are one
 * thing on screen.
 */
export function subagentLane<V extends BlockList>(view: V, subagentId: string, turnId?: string): [V, number] {
  const existing = findLastIndex(view.blocks, (b) => b.type === 'subagent' && b.subagentId === subagentId);
  if (existing >= 0) return [view, existing];
  const spawn = findLastIndex(view.blocks, (b) => b.type === 'tool' && (b.spawns === subagentId || b.toolCallId === subagentId));
  const call = view.blocks[spawn];
  if (call?.type === 'tool') {
    const block = subagentBlock(call.id, {
      subagentId, brief: call.headline.keyArg, status: 'running', children: [], digest: '', toolCallId: call.toolCallId, turnId: call.turnId,
    });
    return [{ ...view, blocks: replaceAt(view.blocks, spawn, block) }, spawn];
  }
  const next = append(view, (id) => subagentBlock(id, { subagentId, brief: '', status: 'running', children: [], digest: '', turnId }));
  return [next, findLastIndex(next.blocks, (b) => b.type === 'subagent' && b.subagentId === subagentId)];
}

export function updateSubagent<V extends BlockList>(view: V, subagentId: string, turnId: string | undefined, update: (block: SubagentBlock) => SubagentBlock): V {
  const [next, lane] = subagentLane(view, subagentId, turnId);
  return { ...next, blocks: replaceAt(next.blocks, lane, update(subagentAt(next, lane))) };
}

/** The lane a subagent's activity lands in: its own block's children, or the top level. */
export function laneOf<V extends BlockList>(view: V, subagentId: string | undefined, turnId?: string): [V, Lane] {
  return subagentId ? subagentLane(view, subagentId, turnId) : [view, null];
}

export function think<V extends BlockList>(view: V, text: string, turnId?: string, segmentId?: string, subagentId?: string): V {
  const [placed, lane] = laneOf(view, subagentId, turnId);
  const blocks = laneBlocks(placed, lane);
  const lastIndex = findLastIndex(blocks, (b) => b.type !== 'usage');
  const last = blocks[lastIndex];
  if (last?.type === 'thinking' && last.streaming && last.segmentId === segmentId) {
    return laneReplace(placed, lane, lastIndex, { ...last, text: last.text + text });
  }
  return appendOutput(placed, lane, (id) => ({
    type: 'thinking', id, text, streaming: true,
    ...(turnId ? { turnId } : {}),
    ...(segmentId ? { segmentId } : {}),
    ...(subagentId ? { subagentId } : {}),
  }));
}

/** The one usage line, replaced in place or added as the last block. */
export function setUsageLine<V extends BlockList>(view: V, line: UsageLine): V {
  const last = view.blocks[view.blocks.length - 1];
  const block = usageBlock(last?.type === 'usage' ? last.id : `b${view.nextId}`, line);
  if (last?.type === 'usage') return { ...view, blocks: replaceAt(view.blocks, view.blocks.length - 1, block) };
  return { ...view, blocks: [...view.blocks, block], nextId: view.nextId + 1 };
}

function closeBlock<B extends DisplayBlock>(block: B, interrupted: boolean): B {
  return interrupted && block.type === 'tool' && block.status === 'pending' ? { ...block, status: 'interrupted' } : sealed(block);
}

function closeSubagent(block: SubagentBlock, cut: SubagentStatus | null): SubagentBlock {
  const children = block.children.map((c) => closeBlock(c, cut !== null));
  const status = cut && block.status === 'running' ? cut : block.status;
  return status === block.status && children.every((c, i) => c === block.children[i]) ? block : { ...block, status, children };
}

/**
 * A turn is over, so whatever it left open is closed: streaming stops, and
 * when the turn was cut short (`cut`), its unanswered calls and running
 * subagents say so.
 */
export function closeOpenBlocks<V extends BlockList>(view: V, cut: SubagentStatus | null): V {
  const blocks = view.blocks.map((b) => {
    if (b.type === 'subagent') return closeSubagent(b, cut);
    // A compaction's end is its own to report; a turn cut short reports it for the one still running.
    if (b.type === 'compaction') return b.status === 'running' && (cut === 'stopped' || cut === 'failed') ? { ...b, status: cut } : b;
    return closeBlock(b, cut !== null);
  });
  return blocks.every((b, i) => b === view.blocks[i]) ? view : { ...view, blocks };
}
