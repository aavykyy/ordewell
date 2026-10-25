import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { HandoffArtifact, HandoffDigest, HandoffEvidence } from '../models/Handoff';
import { cleanEnv } from './gitExec';

/** Resolve claims at the read, never on acceptance or in the saved handoff (ADR-0047). */
export function resolveHandoffReferences<H extends HandoffDigest>(handoff: H, workspace: string): H {
  const checked = new Map<string, HandoffEvidence>();
  const contained = (candidate: string): string | undefined => {
    try {
      const root = fs.realpathSync(workspace);
      const resolved = fs.realpathSync(path.resolve(root, candidate));
      const relative = path.relative(root, resolved);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? resolved : undefined;
    } catch {
      return undefined;
    }
  };
  const resolve = (ref: HandoffEvidence): HandoffEvidence => {
    if (ref.kind !== 'file' && ref.kind !== 'commit') return ref;
    const key = JSON.stringify(ref);
    const known = checked.get(key);
    if (known) return known;
    let resolved = false;
    if (ref.kind === 'file') {
      const file = contained(ref.path);
      if (file) {
        try { resolved = fs.statSync(file).isFile(); } catch { /* The tree may go between resolving and checking. */ }
      }
    } else if (/^[0-9a-fA-F]{4,64}$/.test(ref.sha)) {
      const repo = contained(ref.repo ?? '.');
      // A group root is not a repository; do not let git discover an ancestor outside it.
      if (repo && fs.existsSync(path.join(repo, '.git'))) {
        const result = spawnSync('git', ['--no-optional-locks', '--no-replace-objects', 'cat-file', '-t', ref.sha], {
          cwd: repo, encoding: 'utf8', timeout: 1000,
          env: { ...cleanEnv(), GIT_NO_LAZY_FETCH: '1' }, windowsHide: true,
        });
        resolved = result.status === 0 && result.stdout.trim() === 'commit';
      }
    }
    const result = { ...ref, resolved };
    checked.set(key, result);
    return result;
  };
  return {
    ...handoff,
    findings: handoff.findings.map((f) => ({ ...f, ...(f.evidence ? { evidence: f.evidence.map(resolve) } : {}) })),
    // A saved patch is Ordewell's own record, not a claim about a tree (ADR-0050).
    ...(handoff.artifacts ? { artifacts: handoff.artifacts.map((a): HandoffArtifact => (a.kind === 'patch' ? a : resolve(a))) } : {}),
  };
}
