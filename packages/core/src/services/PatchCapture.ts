import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OwnSealedRuns, TaskShell, ToolOutcome } from '../interfaces/IFileSystem';
import { HANDOFF_LIMITS, byteSize, patchFlagText, readableTaskIds, savedPatchOf, type HandoffPatch, type PatchFlag } from '../models/Handoff';
import { flattenTasks, type Task } from '../models/Task';
import { git, tryGit, type GitInvoker } from './gitExec';
import { patchFiles, unquoted } from './taskDiffRead';
import { loggedHandoff, type TaskLogReader } from './readTask';
import { listed } from './harness/ordewellBinding';
import { resolveTaskRef, titledTaskRefOf } from './TaskRefs';
import type { ApplyPatchArgs, McpToolReply } from './mcp/tools';

/*
 * A read-only task's prototype, kept as a patch (ADR-0050). Its worktree is
 * thrown away when it ends (ADR-0046), so what it changed survives only if it
 * is captured first, and the capture runs inside the task's own seal: git
 * that reads a tree a sealed run wrote, `.gitattributes` and filters
 * included, runs nowhere else, and outside the seal it would also freshen the
 * repository's own objects.
 *
 * Two sealed scripts. The first stages every change into a private index,
 * seeded from the worktree's own so git rehashes only what changed, with a
 * private object store whose alternates are the repository's objects, and
 * lists what it staged. Between the two, Ordewell decides what is refused and
 * what is not carried. The second takes that back out of the private index,
 * writes the patch, and replays it on a fresh index at the same base: the
 * patch is kept only if that gives the very tree that was staged.
 *
 * Whatever the scripts write is a file in the task's own scratch, which a
 * process its commands left behind can rewrite. So the patch that is kept is
 * judged on the bytes Ordewell reads, with no git: it holds no link or
 * submodule, its counts are of those bytes, and its hash is what `apply_patch`
 * checks it against.
 *
 * Applying one is the same concept seen from the other side: a change task
 * brings a saved patch into its own worktree as a three-way merge and is told
 * exactly what merged and what did not. That half is at the end of this file.
 */

/** How large a saved patch may grow. A file's part is measured in the patch, so a small edit to a large file counts as small. */
export const PATCH_LIMITS = {
  /** A file whose part of the patch is larger is dropped, and named. */
  fileBytes: 1024 * 1024,
  /** The most a saved patch holds: past it, the largest files are dropped, and named. */
  patchBytes: 8 * 1024 * 1024,
  /** How many paths a flag names; the rest are counted. */
  flagPaths: 10,
} as const;

/** What git lists of the changes beside the patch, bounded so a runaway tree cannot fill Ordewell's memory. */
const LISTING_BYTES = 64 * 1024 * 1024;

const LINK = '120000';
const SUBMODULE = '160000';

/** What a saved patch holds, as its artifact states it. */
export interface PatchStats {
  base: string;
  files: number;
  added: number;
  removed: number;
  binary: number;
  bytes: number;
  sha256: string;
  flags: PatchFlag[];
}

/**
 * How a capture ended: a patch, nothing to save (the task changed nothing
 * that a patch carries), or a refusal that names why nothing was saved.
 */
export type PatchCaptureResult =
  | { kind: 'saved'; patch: Buffer; stats: PatchStats }
  | { kind: 'empty'; reason: string; flags: PatchFlag[] }
  | { kind: 'refused'; reason: string };

/** One staged change as `git diff --raw -z --no-renames` lists it. */
interface Change {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  /** The path as git wrote it, byte for byte, for the index records that take a change back. */
  bytes: Buffer;
  name: string;
}

class Refusal extends Error {}

/** Pinned for every git the scripts run, whatever the repository's own configuration says (ADR-0050). */
const PINNED = [
  'core.fsmonitor=false', 'core.splitIndex=false', 'core.untrackedCache=false',
  // A case-only rename is then two paths, which the fold check refuses, rather than nothing at all.
  'core.ignoreCase=false',
  // Any write bumps ctime, which userspace cannot set back, so a same-size edit with its mtime restored is still seen.
  'core.trustctime=true', 'core.checkStat=default',
  'core.quotePath=true', 'gc.auto=0', 'maintenance.auto=false',
  'diff.relative=false', 'diff.noprefix=false', 'diff.mnemonicPrefix=false',
].map((setting) => `-c ${setting}`).join(' ');

/** A patch `git apply` takes at the repository root, whatever the repository says about diffs. */
const DIFF = '--no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -O/dev/null';

function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** What both scripts start with: where their files go, and git pointed at the private index and object store. */
function prelude(stem: string): string {
  return [
    'set -e',
    'export LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1',
    `O=${shellQuoted(stem)}`,
    'G="$(git rev-parse --git-dir)"',
    'C="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"',
    'export GIT_INDEX_FILE="$O.d/index" GIT_OBJECT_DIRECTORY="$O.d/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$C/objects"',
    `git() { command git ${PINNED} "$@"; }`,
    `D=${shellQuoted(DIFF)}`,
  ].join('\n');
}

/**
 * Stage every change but what Ordewell linked in, and list it: the base, each
 * change with its modes and blobs, every path the index then holds, the size
 * of each change's part of a patch, one line per `diff --git` section, and
 * the size of each rename's, since the saved patch holds a rename as one
 * section and not as a removal and an addition. A linked path is excluded as
 * the landing commit excludes it: by name, whatever it is on disk, unless git
 * already ignores it, since naming an ignored path in an exclude makes `add`
 * refuse.
 */
function stageScript(stem: string, linked: readonly string[]): string {
  return [
    prelude(stem),
    'mkdir -p "$O.d/objects"',
    'if [ -f "$G/index" ]; then cp "$G/index" "$GIT_INDEX_FILE"; else git read-tree HEAD; fi',
    'set -- .',
    ...(linked.length ? [`for p in ${linked.map(shellQuoted).join(' ')}; do git check-ignore -q -- "$p" || set -- "$@" ":(exclude,literal)$p"; done`] : []),
    'git add -A -- "$@"',
    "git rev-parse --verify 'HEAD^{commit}' > \"$O.base\"",
    'git diff --cached --raw -z --no-renames --no-abbrev $D HEAD > "$O.raw"',
    'git ls-files -z > "$O.files"',
    'git diff --cached --binary --full-index --no-renames $D HEAD > "$O.d/full"',
    `awk '/^diff --git /{ if (n) print s; s = 0; n = 1 } { s += length($0) + 1 } END { if (n) print s }' "$O.d/full" > "$O.sizes"`,
    'git diff --cached --binary --full-index -M --diff-filter=R $D HEAD > "$O.d/renamed"',
    `awk '/^diff --git /{ if (n) printf "%s\\t%s\\t%s\\n", s, f, t; s = 0; n = 1; f = ""; t = "" } { s += length($0) + 1 } /^rename from /{ f = substr($0, 13) } /^rename to /{ t = substr($0, 11) } END { if (n) printf "%s\\t%s\\t%s\\n", s, f, t }' "$O.d/renamed" > "$O.renames"`,
    'rm -f "$O.d/full" "$O.d/renamed"',
  ].join('\n');
}

/**
 * Take back what is not carried, write the patch, and replay it on a fresh
 * index at the same base. Beside it: what is carried, with the hash of each
 * file's bytes as the task left them.
 */
function exportScript(stem: string): string {
  return [
    prelude(stem),
    '[ ! -s "$O.revert" ] || git update-index -z --index-info < "$O.revert"',
    'git diff --cached --raw -z --no-renames --no-abbrev --diff-filter=AMT $D HEAD > "$O.kept"',
    'git diff --cached --name-only --no-renames --diff-filter=AMT $D HEAD > "$O.d/names"',
    'git hash-object --no-filters --stdin-paths < "$O.d/names" > "$O.hashes"',
    'git diff --cached --binary --full-index -M $D HEAD > "$O.patch"',
    'git write-tree > "$O.tree"',
    '(export GIT_INDEX_FILE="$O.d/replay"; git read-tree HEAD && git apply --cached --whitespace=nowarn "$O.patch" && git write-tree > "$O.replayed")',
  ].join('\n');
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = buffer.indexOf(0); i !== -1; i = buffer.indexOf(0, start)) {
    parts.push(buffer.subarray(start, i));
    start = i + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

const RAW_HEADER = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([ADMT])$/;

function parseRaw(raw: Buffer): Change[] {
  const fields = splitNul(raw);
  if (fields.length % 2 !== 0) throw new Refusal('git listed the changes in a form Ordewell does not read');
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const header = RAW_HEADER.exec(fields[i].toString('latin1'));
    if (!header) throw new Refusal('git listed a change Ordewell does not read');
    const [, oldMode, newMode, oldSha, newSha, status] = header;
    changes.push({ oldMode, newMode, oldSha, newSha, status, bytes: fields[i + 1], name: fields[i + 1].toString('utf8') });
  }
  return changes;
}

/** Two names a case-insensitive, normalization-insensitive file system holds as one. */
function folded(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * A new path that differs from another only in case is refused: a case-only
 * rename, or a file named like one already there. On a case-insensitive file
 * system git stages the new spelling beside the old one, and the patch then
 * applies nowhere; on a case-sensitive one it applies there and nowhere else.
 */
function caseClash(kept: readonly Change[], indexed: readonly string[], changes: readonly Change[]): string | undefined {
  const takenBack = new Set(changes.filter((c) => c.status === 'A' && !kept.includes(c)).map((c) => c.name));
  const others = new Map<string, string[]>();
  const add = (name: string) => {
    const key = folded(name);
    others.set(key, [...(others.get(key) ?? []), name]);
  };
  for (const name of indexed) if (!takenBack.has(name)) add(name);
  for (const change of changes) if (change.status === 'D') add(change.name);
  for (const change of kept) {
    if (change.status !== 'A') continue;
    const twin = others.get(folded(change.name))?.find((name) => name !== change.name);
    if (twin !== undefined) {
      return `${JSON.stringify(twin)} and ${JSON.stringify(change.name)} differ only in case: a case-only rename, or a new file named like one already there, which a case-insensitive file system (macOS, Windows) cannot apply. Rename it to a name that differs by more than case, or move it back, then save again.`;
    }
  }
  return undefined;
}

/** The first {@link PATCH_LIMITS.flagPaths} names a flag lists, past any too long to be a reference. */
function flag(kind: PatchFlag['kind'], names: readonly string[]): PatchFlag[] {
  if (names.length === 0) return [];
  return [{ kind, count: names.length, paths: names.filter((n) => n.length <= HANDOFF_LIMITS.reference).slice(0, PATCH_LIMITS.flagPaths) }];
}

/** Each change's part of the patch in bytes; a type change is two sections, a removal and an addition. */
function sizesOf(changes: readonly Change[], sizes: string): number[] {
  const sections = sizes.split('\n').filter((line) => line !== '').map(Number);
  const expected = changes.reduce((n, c) => n + (c.status === 'T' ? 2 : 1), 0);
  if (sections.length !== expected || sections.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new Refusal('Ordewell could not measure the changes git listed');
  }
  let next = 0;
  return changes.map((c) => (c.status === 'T' ? sections[next++] + sections[next++] : sections[next++]));
}

/** What the caps judge as one: a change, or a rename's removal and addition, which the saved patch holds as the one section. */
interface Part {
  changes: Change[];
  /** The path the part is named by: where a rename goes. */
  name: string;
  size: number;
}

/** One rename the saved patch holds, with the size of its section, as the first script measures it. */
interface Rename {
  size: number;
  from: string;
  to: string;
}

function renamesOf(listing: string): Rename[] {
  return listing.split('\n').filter((line) => line !== '').map((line) => {
    const [size, from, to, ...rest] = line.split('\t');
    const name = (quoted: string | undefined) => (quoted?.startsWith('"') ? unquoted(quoted) : quoted);
    if (rest.length > 0 || !Number.isSafeInteger(Number(size)) || !from || !to) throw new Refusal('Ordewell could not measure the renames git listed');
    return { size: Number(size), from: name(from)!, to: name(to)! };
  });
}

/**
 * The changes as the caps see them. A removal and an addition that the saved
 * patch pairs as a rename are measured by the rename's section, so a large file
 * that only moved is as small as the patch makes it, and they are kept or
 * dropped together.
 */
function partsOf(candidates: readonly Change[], sizes: ReadonlyMap<Change, number>, renames: readonly Rename[]): Part[] {
  const removals = new Map(candidates.filter((c) => c.status === 'D').map((c) => [c.name, c]));
  const additions = new Map(candidates.filter((c) => c.status === 'A').map((c) => [c.name, c]));
  const paired = new Set<Change>();
  const parts: Part[] = [];
  for (const { size, from, to } of renames) {
    const removal = removals.get(from);
    const addition = additions.get(to);
    if (!removal || !addition || paired.has(removal) || paired.has(addition)) continue;
    paired.add(removal).add(addition);
    parts.push({ changes: [removal, addition], name: to, size });
  }
  for (const c of candidates) if (!paired.has(c)) parts.push({ changes: [c], name: c.name, size: sizes.get(c)! });
  return parts;
}

/** What fits: a part over its own cap is dropped, then the largest of the rest until the whole fits. */
function withinCaps(candidates: readonly Change[], parts: readonly Part[]): { kept: Change[]; dropped: Part[] } {
  const dropped = parts.filter((p) => p.size > PATCH_LIMITS.fileBytes);
  const rest = parts.filter((p) => !dropped.includes(p));
  let total = rest.reduce((sum, p) => sum + p.size, 0);
  for (const largest of [...rest].sort((a, b) => b.size - a.size)) {
    if (total <= PATCH_LIMITS.patchBytes) break;
    dropped.push(largest);
    total -= largest.size;
  }
  const out = new Set(dropped.flatMap((p) => p.changes));
  return { kept: candidates.filter((c) => !out.has(c)), dropped };
}

/** The index records that take changes back to the base: a new path removed, any other put back as it was. */
function revertRecords(changes: readonly Change[]): Buffer {
  return Buffer.concat(changes.flatMap((c) => [
    Buffer.from(c.oldMode === '000000' ? `0 ${c.oldSha}\t` : `${c.oldMode} ${c.oldSha}\t`, 'latin1'),
    c.bytes,
    Buffer.from([0]),
  ]));
}

/** Files, lines added and removed, and binary files, counted in the bytes of a patch; a binary file counts no lines. */
function countedIn(patch: Buffer): { files: number; added: number; removed: number; binary: number } {
  const counts = { files: 0, added: 0, removed: 0, binary: 0 };
  for (const file of patchFiles(patch)) {
    counts.files += 1;
    if (file.added === '-') counts.binary += 1;
    else {
      counts.added += Number(file.added);
      counts.removed += Number(file.removed);
    }
  }
  return counts;
}

const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const MODES_GONE: ReadonlySet<string> = new Set([...FILE_MODES, LINK, SUBMODULE]);

/**
 * The first header line of a patch that names a mode other than a regular
 * file's, so that `git apply` might create a symbolic link or a submodule, or
 * turn a file into one. It reads the bytes with no git, since a patch is
 * applied where nothing seals it. Git takes any octal mode whose type bits say
 * link (`0120000` and `120755` as well as `120000`), so a mode is allowed only
 * as one of the two a regular file has. Deleting a link or a submodule may name
 * another, as the capture carries those deletions.
 *
 * Only a header starts a line this way: a hunk's lines start with a space,
 * `+`, `-` or a backslash, and a binary patch's with a letter and then base85,
 * which has no space.
 */
export function linkInPatch(patch: Buffer): string | undefined {
  for (const line of patch.toString('latin1').split('\n')) {
    let mode: string | undefined;
    let allowed = FILE_MODES;
    const named = /^(old mode|new mode|new file mode|deleted file mode) (.*)$/.exec(line);
    if (named) {
      mode = named[2];
      if (named[1] === 'deleted file mode') allowed = MODES_GONE;
    } else if (line.startsWith('index ')) {
      const space = line.indexOf(' ', 'index '.length);
      if (space !== -1) mode = line.slice(space + 1);
    }
    if (mode !== undefined && !allowed.has(mode)) return line;
  }
  return undefined;
}

/**
 * One file the sealed scripts wrote into scratch, read as Ordewell's own: a
 * link there is never followed, so nothing outside scratch is read in its
 * place, and nothing past `max` bytes is read at all.
 */
function readOwn(scratch: string, name: string, max: number): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(path.join(scratch, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw new Refusal(`the capture left no ${name.split('.').pop()} Ordewell could read (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Refusal(`the capture's ${name.split('.').pop()} is not a file`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      chunks.push(chunk.subarray(0, read));
      if (total > max) throw new Refusal(`the capture's ${name.split('.').pop()} is larger than the ${byteSize(max)} Ordewell reads`);
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

/** Git's own words on why a script stopped, its last lines. */
function failure(step: string, outcome: ToolOutcome): string {
  const said = outcome.output.trim();
  return `${step}: ${said.length > 1500 ? `…${said.slice(-1500)}` : said || 'it failed with no output'}`;
}

const SHA = /^[0-9a-f]{40,64}$/;

function shaIn(buffer: Buffer, what: string): string {
  const sha = buffer.toString('latin1').trim();
  if (!SHA.test(sha)) throw new Refusal(`the capture's ${what} is not a git object name`);
  return sha;
}

/** What a capture leaves out before git sees it. */
export interface PatchCaptureOptions {
  /**
   * The paths Ordewell linked into the worktree, relative to its root: kept
   * out of the patch as they are kept out of a landing commit
   * (`IsolationTaskRepo.linked`), since `.gitignore` does not match every one.
   */
  linked?: readonly string[];
}

/** The capture itself, with the shell held: nothing of the task's runs between its two scripts. */
async function captureHeld(runs: OwnSealedRuns, opts: PatchCaptureOptions, signal?: AbortSignal): Promise<PatchCaptureResult> {
  if (runs.worktrees.length === 0) return { kind: 'refused', reason: 'this task has no worktree of its own, so it changed nothing a patch could carry.' };
  if (runs.worktrees.length > 1) return { kind: 'refused', reason: 'this task works across several repositories, and a saved patch is one repository\'s changes.' };
  // Native writes are withheld and an unsealed command writes only scratch,
  // so until a sealed run the worktree is what Ordewell checked out (ADR-0046).
  if (!runs.touched) return { kind: 'empty', reason: 'no command of this task has run sealed, so its worktree holds only what Ordewell checked out.', flags: [] };
  const [worktree] = runs.worktrees;
  const scratch = runs.scratch;
  // Unguessable, so nothing a sealed run left in scratch stands where the capture writes.
  const tag = `ordewell-patch-${randomBytes(8).toString('hex')}`;
  const stem = path.join(scratch, tag);
  const own = (suffix: string, max = LISTING_BYTES) => readOwn(scratch, `${tag}.${suffix}`, max);
  try {
    const stage = await runs.run(stageScript(stem, opts.linked ?? []), worktree);
    if (signal?.aborted) return { kind: 'refused', reason: 'the attempt ended while its changes were being captured.' };
    if (!stage.success) return { kind: 'refused', reason: failure('git could not stage the worktree\'s changes', stage) };

    const base = shaIn(own('base', 1024), 'base');
    const changes = parseRaw(own('raw'));
    if (changes.length === 0) return { kind: 'empty', reason: 'the worktree has no changes from the commit it was cut from.', flags: [] };
    const sizes = new Map(sizesOf(changes, own('sizes').toString('latin1')).map((size, i) => [changes[i], size]));
    // A link would hand the builder a path into wherever it points, and a sealed
    // run cannot record a submodule's commit, so neither is ever carried.
    const excluded = changes.filter((c) => c.status !== 'D' && (c.newMode === LINK || c.newMode === SUBMODULE));
    const candidates = changes.filter((c) => !excluded.includes(c));
    const { kept, dropped } = withinCaps(candidates, partsOf(candidates, sizes, renamesOf(own('renames').toString('latin1'))));
    const indexed = splitNul(own('files')).map((name) => name.toString('utf8'));
    const clash = caseClash(kept, indexed, changes);
    if (clash) return { kind: 'refused', reason: clash };
    const flags = [...flag('excluded', excluded.map((c) => c.name)), ...flag('dropped', dropped.map((p) => `${p.name} (${byteSize(p.size)})`))];
    if (kept.length === 0) return { kind: 'empty', reason: 'none of the worktree\'s changes is one a patch carries.', flags };

    fs.writeFileSync(`${stem}.revert`, revertRecords([...excluded, ...dropped.flatMap((p) => p.changes)]), { flag: 'wx', mode: 0o600 });
    const exported = await runs.run(exportScript(stem), worktree);
    if (signal?.aborted) return { kind: 'refused', reason: 'the attempt ended while its changes were being captured.' };
    if (!exported.success) return { kind: 'refused', reason: failure('git could not write or replay the patch', exported) };

    const tree = shaIn(own('tree', 1024), 'tree');
    if (shaIn(own('replayed', 1024), 'replayed tree') !== tree) {
      return { kind: 'refused', reason: 'the patch did not replay to the same tree at its base, so it would not carry the worktree\'s changes whole.' };
    }
    const carried = parseRaw(own('kept'));
    const hashes = own('hashes').toString('latin1').split('\n').filter((line) => line !== '');
    if (hashes.length !== carried.length) throw new Refusal('Ordewell could not compare the patch with the worktree\'s files');
    const normalized = carried.filter((c, i) => c.newSha !== hashes[i]).map((c) => c.name);
    const patch = own('patch', PATCH_LIMITS.patchBytes);
    // Nothing git wrote beside the patch vouches for it: a process the task's commands left behind can rewrite any of those files while the scripts run.
    const link = linkInPatch(patch);
    if (link !== undefined) {
      return { kind: 'refused', reason: `the patch holds a link or a submodule (${JSON.stringify(link.slice(0, 80))}), which a capture leaves out, so something other than git wrote it.` };
    }
    return {
      kind: 'saved',
      patch,
      stats: { base, ...countedIn(patch), bytes: patch.length, sha256: createHash('sha256').update(patch).digest('hex'), flags: [...flags, ...flag('normalized', normalized)] },
    };
  } catch (err) {
    if (err instanceof Refusal) return { kind: 'refused', reason: `${err.message}.` };
    throw err;
  } finally {
    fs.rmSync(`${stem}.d`, { recursive: true, force: true });
    for (const suffix of ['base', 'raw', 'files', 'sizes', 'renames', 'revert', 'kept', 'hashes', 'patch', 'tree', 'replayed']) fs.rmSync(`${stem}.${suffix}`, { force: true });
  }
}

/**
 * Capture what a read-only task changed in its worktree as a patch
 * (ADR-0050), inside its seal, with its shell held for as long as that takes.
 */
export async function capturePatch(shell: TaskShell, opts: PatchCaptureOptions = {}, signal?: AbortSignal): Promise<PatchCaptureResult> {
  if (!shell.hold) return { kind: 'refused', reason: 'this task\'s shell cannot run Ordewell\'s capture.' };
  return shell.hold((runs) => captureHeld(runs, opts, signal), signal);
}

/** A saved patch as the artifact the attempt's handoff names (ADR-0050). */
export function patchArtifact(stats: PatchStats, at: { path: string; attempt: number }): HandoffPatch {
  const { base, files, added, removed, binary, bytes, sha256, flags } = stats;
  return { kind: 'patch', path: at.path, attempt: at.attempt, base, files, added, removed, binary, bytes, sha256, ...(flags.length ? { flags } : {}) };
}

/** A capture's flags as the lines a reply ends with. */
function flagLines(flags: readonly PatchFlag[]): string[] {
  return flags.map((f) => `- ${patchFlagText(f)}`);
}

/** What `save_patch` answers: what was saved and what it leaves out, or why nothing was. */
export function patchReply(result: PatchCaptureResult, saved: HandoffPatch | undefined, earlier: HandoffPatch | undefined): { text: string; isError?: true } {
  const kept = earlier ? ' The patch you saved earlier stays.' : '';
  switch (result.kind) {
    case 'refused':
      return { text: `Nothing saved: ${result.reason}${kept}`, isError: true };
    case 'empty':
      return { text: [`Nothing saved: ${result.reason}${kept}`, ...flagLines(result.flags)].join('\n') };
    case 'saved': {
      const { files, added, removed, bytes, base, flags } = result.stats;
      return {
        text: [
          `Saved ${files} file${files === 1 ? '' : 's'}, +${added} -${removed}, ${byteSize(bytes)}, as a patch against commit ${base.slice(0, 12)}${saved ? `: ${saved.path}` : ''}. It is named in your handoff as a patch artifact, so you need not list it, and nothing of it lands. Saving again replaces it with what your worktree holds then.`,
          ...(flags.length ? ['', 'Not as your worktree has it:', ...flagLines(flags)] : []),
        ].join('\n'),
      };
    }
  }
}

/**
 * One path the three-way merge could not settle. A binary file has no
 * conflict markers. A patch that deletes or adds a file the worktree has
 * changed is not a conflict git leaves behind: it applies none of the patch.
 */
export interface PatchConflict {
  path: string;
  binary: boolean;
}

/** What an apply found about where it was made. */
interface AppliedAt {
  /** Whether the worktree's HEAD is the commit the patch was taken against. */
  sameBase: boolean;
  head: string;
  files: number;
}

/** How an apply ended: merged whole, merged with conflicts left in the worktree, or applied nothing. */
export type PatchApplyResult =
  | ({ kind: 'applied' } & AppliedAt)
  | ({ kind: 'conflicted'; conflicts: PatchConflict[] } & AppliedAt)
  | { kind: 'refused'; reason: string };

// A change task's worktree is the user's own repository, so git's fsmonitor hook is not run for it.
const APPLY_GIT = ['--no-pager', '-c', 'core.fsmonitor=false'];

/** The paths the index holds unmerged, sorted. */
async function unmergedPaths(invoker: GitInvoker, worktree: string): Promise<string[]> {
  const listing = await git(invoker, worktree, [...APPLY_GIT, 'ls-files', '-u', '-z']);
  const paths = listing.split('\0').flatMap((record) => /^\d{6} [0-9a-f]+ [123]\t([\s\S]+)$/.exec(record)?.[1] ?? []);
  return [...new Set(paths)].sort();
}

/**
 * Apply a saved patch (ADR-0050) in the root of a change task's own worktree
 * as a three-way merge, `git apply --3way`: at the commit the patch was taken
 * against it reproduces the explorer's tree, and at a later one it merges
 * with what has landed since. What came of it is read from the index, never
 * from `--check`, which says yes to a patch that then conflicts.
 *
 * An unresolved conflict of the task's own, or a file of the patch's that the
 * task changed and has not staged, would make the result unreadable, so
 * either applies nothing. So does a patch that is not the file that was saved,
 * or that would create a link or a submodule.
 */
export async function applyPatch(invoker: GitInvoker, worktree: string, patch: Buffer, saved: Pick<HandoffPatch, 'base' | 'files' | 'bytes' | 'sha256'>): Promise<PatchApplyResult> {
  const refused = (reason: string): PatchApplyResult => ({ kind: 'refused', reason });
  if (patch.length !== saved.bytes) {
    return refused(`the patch is ${byteSize(patch.length)} where its artifact says ${byteSize(saved.bytes)}, so it was cut short or changed after it was saved.`);
  }
  if (createHash('sha256').update(patch).digest('hex') !== saved.sha256) {
    return refused('the patch is not the file that was saved: its hash is not the one its artifact records, so it was changed after it was saved.');
  }
  // Applying is not sealed, and git creates whatever link a header names; a saved patch holds none, so one here was not written by the capture.
  const link = linkInPatch(patch);
  if (link !== undefined) {
    return refused(`the patch holds a link or a submodule (${JSON.stringify(link.slice(0, 80))}), which a saved patch never does, so it is not one that was saved.`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-apply-'));
  try {
    const toplevel = (await git(invoker, worktree, [...APPLY_GIT, 'rev-parse', '--show-toplevel'])).trim();
    if (fs.realpathSync(toplevel) !== fs.realpathSync(worktree)) return refused(`${worktree} is not the root of a worktree of its own.`);
    const head = (await git(invoker, worktree, [...APPLY_GIT, 'rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!(await tryGit(invoker, worktree, [...APPLY_GIT, 'cat-file', '-e', `${saved.base}^{commit}`])).ok) {
      return refused(`the commit the patch was taken against (${saved.base.slice(0, 12)}) is not in this repository, so there is nothing to merge it from.`);
    }
    const before = await unmergedPaths(invoker, worktree);
    if (before.length > 0) return refused(`your worktree still has unresolved conflicts (${listed(before.slice(0, 10))}${before.length > 10 ? `, +${before.length - 10} more` : ''}). Resolve them and git add them, or undo them, then apply the patch.`);

    const file = path.join(dir, 'saved.patch');
    fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 });
    // --3way implies --index. The whitespace policy is pinned so a repository's apply.whitespace=error cannot refuse a patch whole.
    const applied = await tryGit(invoker, worktree, [...APPLY_GIT, 'apply', '--3way', '--whitespace=nowarn', file]);
    const conflicted = await unmergedPaths(invoker, worktree);
    const at: AppliedAt = { sameBase: head === saved.base, head, files: saved.files };
    if (conflicted.length > 0) {
      const binary = new Set(patchFiles(patch).filter((f) => f.added === '-').map((f) => f.path));
      return { kind: 'conflicted', ...at, conflicts: conflicted.map((name) => ({ path: name, binary: binary.has(name) })) };
    }
    if (!applied.ok) {
      // Git narrates the files it merged before the one it could not; only its errors say why nothing was applied.
      const lines = applied.stderr.trim().split('\n');
      const errors = lines.filter((line) => line.startsWith('error:'));
      const said = (errors.length > 0 ? errors : lines).join('\n');
      const staged = /does not match index/.test(said) ? ' Stage (git add) or commit your changes to those files, then apply again.' : '';
      return refused(`git applied none of it: ${said.length > 1500 ? `…${said.slice(-1500)}` : said || 'it failed with no output'}.${staged}`);
    }
    return { kind: 'applied', ...at };
  } catch (err) {
    return refused(`git could not apply the patch (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What to do with one conflicted path, for the task that has to settle it. */
function resolution(c: PatchConflict): string {
  return c.binary
    ? `binary, so the file holds no markers: \`git checkout --ours -- ${c.path}\` keeps your version, \`--theirs\` takes the patch's`
    : 'the file holds conflict markers, your side above the `=======` and the patch\'s below';
}

/** What `apply_patch` answers: what merged and what did not, and what is left to do. */
export function applyReply(result: PatchApplyResult, from: string, saved: HandoffPatch): McpToolReply {
  if (result.kind === 'refused') return { text: `Nothing applied: ${result.reason} The patch is the file ${saved.path}, if you would rather apply part of it by hand.`, isError: true };
  const counts = `${saved.files} file${saved.files === 1 ? '' : 's'}, +${saved.added} -${saved.removed}`;
  const where = result.sameBase
    ? 'Your worktree is at the commit the patch was taken against.'
    : `Your worktree is at commit ${result.head.slice(0, 12)}, not ${saved.base.slice(0, 12)}, the commit the patch was taken against: whatever its author ran, it ran there, so run your checks here.`;
  const flags = saved.flags?.length ? ['', 'Not as its author\'s worktree had it:', ...saved.flags.map((f) => `- ${patchFlagText(f)}`)] : [];
  const care = 'The patch is another task\'s work, as much a claim as its report: read what it changed before you rely on it.';
  if (result.kind === 'applied') {
    return { text: [`Applied ${from}'s patch (${counts}) cleanly. Its changes are in your worktree, staged, and land with your task's.`, where, ...flags, '', care].join('\n') };
  }
  const { conflicts } = result;
  return {
    text: [
      `Applied ${from}'s patch (${counts}) with ${conflicts.length} conflicted path${conflicts.length === 1 ? '' : 's'}. The rest of it is in your worktree, staged. Settle each conflicted path, then \`git add\` it:`,
      ...conflicts.map((c) => `- ${c.path}: ${resolution(c)}`),
      where,
      ...flags,
      '',
      care,
    ].join('\n'),
  };
}

/** Where an `apply_patch` call comes from and what it may reach. */
export interface ApplyPatchSite {
  callerId: string;
  plan: readonly Task[];
  /** The session's task logs, the handoffs and the patch files the handoffs name. */
  log: TaskLogReader;
  /** The root of each repository worktree the calling task works in. */
  worktrees: readonly string[];
  /** A read-only task lands nothing, so it has no worktree of its own to apply a patch into. */
  readOnly: boolean;
  git: GitInvoker;
}

/**
 * A task's `apply_patch` call (ADR-0050): the patch of a task it may read, as
 * `read_task` scopes that, applied into its own worktree. The patch is found
 * the way the planner's `task_diff` finds it, by the artifact the attempt's
 * handoff names; a patch file that is gone, or cut short, applies nothing.
 */
export async function applySavedPatch(args: ApplyPatchArgs, site: ApplyPatchSite): Promise<McpToolReply> {
  const refuse = (text: string): McpToolReply => ({ text: `Nothing applied: ${text}`, isError: true });
  if (site.readOnly) return refuse('a read-only task lands nothing and has no worktree of its own to apply a patch into. It keeps its own prototype with save_patch.');
  if (site.worktrees.length === 0) return refuse('this task has no worktree of its own, and Ordewell applies a patch only into one.');
  if (site.worktrees.length > 1) return refuse('this task works across several repositories, and a saved patch is one repository\'s changes.');

  const target = resolveTaskRef(site.plan, String(args.task));
  if (!target) return refuse(`${JSON.stringify(String(args.task))} names no task in the plan: give its "#order", its id or its title.`);
  const named = (id: string) => titledTaskRefOf(site.plan, id) ?? id;
  const name = named(target.id);
  const readable = readableTaskIds(site.plan, site.callerId);
  if (!readable.has(target.id)) {
    const allowed = flattenTasks(site.plan).filter((t) => readable.has(t.id)).map((t) => named(t.id));
    return refuse(`${name} is not a task this one may read. It may read itself, the tasks it depends on, directly or not, and its loop's other end: ${listed(allowed)}.`);
  }

  const attempts = site.log.attempts(target.id);
  if (args.attempt !== undefined && !attempts.includes(args.attempt)) {
    return refuse(`${name} has no saved attempt ${args.attempt}: ${attempts.length > 0 ? `its saved attempts are ${listed(attempts.map(String))}` : 'it has none'}.`);
  }
  const attempt = args.attempt ?? attempts.at(-1);
  const patchOf = (n: number) => savedPatchOf(loggedHandoff(site.log.events(target.id, n)));
  const logged = attempt === undefined ? undefined : loggedHandoff(site.log.events(target.id, attempt));
  // A forked session has the plan's digest, the latest attempt's, and none of the logs behind it, as read_task has.
  const saved = savedPatchOf(logged ?? (attempt === attempts.at(-1) ? target.handoff : undefined));
  if (!saved) {
    const saving = attempts.filter((n) => patchOf(n));
    return refuse(`${name} saved no patch${attempt === undefined ? '' : ` in attempt ${attempt}`}${saving.length > 0 ? `; its attempts that did are ${listed(saving.map(String))}, and apply_patch takes an attempt` : ''}.`);
  }
  const bytes = site.log.patch?.(target.id, saved.attempt);
  if (!bytes) return refuse(`the patch ${name} saved in attempt ${saved.attempt} is no longer in this session's task logs.`);
  return applyReply(await applyPatch(site.git, site.worktrees[0], bytes, saved), name, saved);
}
