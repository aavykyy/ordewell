import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { OwnSealedRuns, TaskShell, ToolOutcome } from '../interfaces/IFileSystem';
import { HANDOFF_LIMITS, byteSize, patchFlagText, type HandoffPatch, type PatchFlag } from '../models/Handoff';

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
    'export LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1',
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
 * change with its modes and blobs, every path the index then holds, and the
 * size of each change's part of a patch, one line per `diff --git` section.
 * A linked path is excluded as the landing commit excludes it: by name,
 * whatever it is on disk, unless git already ignores it, since naming an
 * ignored path in an exclude makes `add` refuse.
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
    'rm -f "$O.d/full"',
  ].join('\n');
}

/**
 * Take back what is not carried, write the patch, and replay it on a fresh
 * index at the same base. Beside it: what is carried, with the hash of each
 * file's bytes as the task left them, and its line counts.
 */
function exportScript(stem: string): string {
  return [
    prelude(stem),
    '[ ! -s "$O.revert" ] || git update-index -z --index-info < "$O.revert"',
    'git diff --cached --raw -z --no-renames --no-abbrev --diff-filter=AMT $D HEAD > "$O.kept"',
    'git diff --cached --name-only --no-renames --diff-filter=AMT $D HEAD > "$O.d/names"',
    'git hash-object --no-filters --stdin-paths < "$O.d/names" > "$O.hashes"',
    'git diff --cached --binary --full-index -M $D HEAD > "$O.patch"',
    'git diff --cached --numstat -z -M $D HEAD > "$O.numstat"',
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

/** What fits: a file over its own cap is dropped, then the largest of the rest until the whole fits. */
function withinCaps(candidates: readonly Change[], sizes: ReadonlyMap<Change, number>): { kept: Change[]; dropped: Change[] } {
  const dropped = candidates.filter((c) => sizes.get(c)! > PATCH_LIMITS.fileBytes);
  const rest = candidates.filter((c) => !dropped.includes(c));
  let total = rest.reduce((sum, c) => sum + sizes.get(c)!, 0);
  for (const largest of [...rest].sort((a, b) => sizes.get(b)! - sizes.get(a)!)) {
    if (total <= PATCH_LIMITS.patchBytes) break;
    dropped.push(largest);
    total -= sizes.get(largest)!;
  }
  return { kept: candidates.filter((c) => !dropped.includes(c)), dropped };
}

/** The index records that take changes back to the base: a new path removed, any other put back as it was. */
function revertRecords(changes: readonly Change[]): Buffer {
  return Buffer.concat(changes.flatMap((c) => [
    Buffer.from(c.oldMode === '000000' ? `0 ${c.oldSha}\t` : `${c.oldMode} ${c.oldSha}\t`, 'latin1'),
    c.bytes,
    Buffer.from([0]),
  ]));
}

/** Lines added and removed, and how many files, as `--numstat -z` counts them; a binary file counts no lines. */
function countLines(numstat: Buffer): { files: number; added: number; removed: number; binary: number } {
  const fields = splitNul(numstat);
  const counts = { files: 0, added: 0, removed: 0, binary: 0 };
  for (let i = 0; i < fields.length; i++) {
    const row = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i].toString('latin1'));
    if (!row) throw new Refusal('git counted the patch in a form Ordewell does not read');
    counts.files += 1;
    if (row[1] === '-') counts.binary += 1;
    else {
      counts.added += Number(row[1]);
      counts.removed += Number(row[2]);
    }
    // A rename names its two paths in the fields after its counts.
    if (row[3] === '') i += 2;
  }
  return counts;
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
    const { kept, dropped } = withinCaps(changes.filter((c) => !excluded.includes(c)), sizes);
    const indexed = splitNul(own('files')).map((name) => name.toString('utf8'));
    const clash = caseClash(kept, indexed, changes);
    if (clash) return { kind: 'refused', reason: clash };
    const flags = [...flag('excluded', excluded.map((c) => c.name)), ...flag('dropped', dropped.map((c) => `${c.name} (${byteSize(sizes.get(c)!)})`))];
    if (kept.length === 0) return { kind: 'empty', reason: 'none of the worktree\'s changes is one a patch carries.', flags };

    fs.writeFileSync(`${stem}.revert`, revertRecords([...excluded, ...dropped]), { flag: 'wx', mode: 0o600 });
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
    const counts = countLines(own('numstat'));
    return {
      kind: 'saved',
      patch,
      stats: { base, ...counts, bytes: patch.length, flags: [...flags, ...flag('normalized', normalized)] },
    };
  } catch (err) {
    if (err instanceof Refusal) return { kind: 'refused', reason: `${err.message}.` };
    throw err;
  } finally {
    fs.rmSync(`${stem}.d`, { recursive: true, force: true });
    for (const suffix of ['base', 'raw', 'files', 'sizes', 'revert', 'kept', 'hashes', 'patch', 'numstat', 'tree', 'replayed']) fs.rmSync(`${stem}.${suffix}`, { force: true });
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
  const { base, files, added, removed, binary, bytes, flags } = stats;
  return { kind: 'patch', path: at.path, attempt: at.attempt, base, files, added, removed, binary, bytes, ...(flags.length ? { flags } : {}) };
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
