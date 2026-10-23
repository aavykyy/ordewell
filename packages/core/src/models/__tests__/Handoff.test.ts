import { describe, it, expect } from 'vitest';
import { handoffPreviewLines, handoffReferenceText, handoffWakeLines, readableTaskIds, commitMessage, severityLabel, storedHandoff, worstSeverity, type HandoffDigest } from '../Handoff';
import { createTask } from '../Task';

describe('the tasks a task may read (ADR-0047)', () => {
  // setup ← build ← check ⇄ fix (the check's loop body), docs beside them, and a subtask under build.
  const plan = [
    createTask({ id: 'setup', order: 1 }),
    createTask({ id: 'build', order: 2, dependencies: ['setup'], subtasks: [createTask({ id: 'build.1', order: 1, dependencies: ['setup'] })] }),
    createTask({ id: 'check', order: 3, dependencies: ['build'], loop: { body: ['fix'], maxRounds: 3 } }),
    createTask({ id: 'fix', order: 4, dependencies: ['check'] }),
    createTask({ id: 'docs', order: 5 }),
  ];

  it('is the task itself and its dependencies, followed all the way back', () => {
    expect([...readableTaskIds(plan, 'check')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('reaches a loop\'s other end both ways: a check its body, and a body task its check', () => {
    expect(readableTaskIds(plan, 'check').has('fix')).toBe(true);
    expect([...readableTaskIds(plan, 'fix')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('leaves out a task the graph never gave it, a subtask\'s own dependencies counted', () => {
    expect([...readableTaskIds(plan, 'docs')]).toEqual(['docs']);
    expect([...readableTaskIds(plan, 'build.1')].sort()).toEqual(['build.1', 'setup']);
  });
});

describe('a handoff as a surface words it', () => {
  it('labels a severity, and names the worst one a row can show', () => {
    expect(severityLabel('blocker')).toBe('Blocker');
    expect(severityLabel('info')).toBe('Info');
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([{ severity: 'info' }, { severity: 'major' }, { severity: 'minor' }])).toBe('major');
    expect(worstSeverity([{ severity: 'minor' }, { severity: 'blocker' }, { severity: 'major' }])).toBe('blocker');
  });

  it('renders every reference kind as a reader would copy it', () => {
    expect(handoffReferenceText({ kind: 'file', path: 'src/a.ts', line: 3 })).toBe('src/a.ts:3 (unresolved)');
    expect(handoffReferenceText({ kind: 'file', path: 'src/a.ts' })).toBe('src/a.ts (unresolved)');
    expect(handoffReferenceText({ kind: 'commit', sha: 'abc123', repo: 'api' })).toBe('commit abc123 in api (unresolved)');
    expect(handoffReferenceText({ kind: 'task', task: 't2', finding: 'F1' }, (id) => (id === 't2' ? '#2' : undefined))).toBe('task #2 F1');
    expect(handoffReferenceText({ kind: 'url', url: 'https://example.com/pr/1' })).toBe('https://example.com/pr/1');
  });
});

describe('a handoff a headless surface prints (ADR-0047)', () => {
  const handoff: HandoffDigest = {
    summary: 'The cache key omits the tenant.',
    findings: [
      { id: 'F1', severity: 'blocker', title: 'The cache key omits the tenant', detail: 'A second tenant reads the first one\'s entry.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 42 }] },
      { id: 'F2', severity: 'major', title: 'No regression test' },
    ],
    findingCount: 4,
    artifacts: [{ kind: 'file', path: 'src/cache.ts', line: 42 }, { kind: 'url', url: 'https://example.com/pr/7' }],
  };

  it('gives the summary, each finding\'s title line, the ones the digest left out and the artifacts', () => {
    expect(handoffPreviewLines(handoff)).toEqual([
      'The cache key omits the tenant.',
      'F1 [blocker] The cache key omits the tenant',
      'F2 [major] No regression test',
      '+2 more findings, in the attempt\'s log',
      'Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
    ]);
  });

  it('stops at a finding budget and counts the rest from the whole handoff', () => {
    expect(handoffPreviewLines(handoff, { maxFindings: 1 })).toEqual([
      'The cache key omits the tenant.',
      'F1 [blocker] The cache key omits the tenant',
      '+3 more findings, in the attempt\'s log',
      'Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
    ]);
  });

  it('gives a wake-up the top findings whole, detail and evidence included', () => {
    expect(handoffWakeLines(handoff).slice(0, 6)).toEqual([
      'The cache key omits the tenant.',
      '',
      'Findings:',
      '- F1 [blocker] The cache key omits the tenant',
      '  A second tenant reads the first one\'s entry.',
      '  Evidence: src/cache.ts:42 (unresolved)',
    ]);
    expect(handoffWakeLines(handoff)).toContain('+2 more findings; read with task_output.');
  });
});

describe('the commit a done call states', () => {
  const done = (body: string) => storedHandoff({ status: 'done', summary: '', commit: { subject: 'Add the check', body } })?.commit;

  it('drops attribution trailers wherever they stand, and keeps the prose around them', () => {
    expect(done([
      'Users ran stale builds for weeks.',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'The check runs once a day.',
      'Signed-off-by: A Dev <dev@example.com>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n'))).toEqual({ subject: 'Add the check', body: 'Users ran stale builds for weeks.\nThe check runs once a day.' });
  });

  it('drops a closing paragraph of trailers, and keeps a line of prose that only looks like one', () => {
    expect(done('Why: the old check ran on every start.\n\nFixes: #12\nRefs: #9')).toEqual({ subject: 'Add the check', body: 'Why: the old check ran on every start.' });
  });

  it('keeps no body when only trailers were in it', () => {
    expect(done('Co-authored-by: Someone <a@b.c>\n')).toEqual({ subject: 'Add the check' });
  });
});

describe('the commit message a landed task\'s work is committed with', () => {
  const none: HandoffDigest = { summary: 'Done.', findings: [], findingCount: 0 };

  it('is the subject, a blank line and the body, or the subject alone', () => {
    expect(commitMessage({ ...none, commit: { subject: 'Add the check', body: 'Users ran stale builds.\nNobody told them.' } })).toBe('Add the check\n\nUsers ran stale builds.\nNobody told them.');
    expect(commitMessage({ ...none, commit: { subject: 'Add the check' } })).toBe('Add the check');
  });

  it('is none for a handoff that states no commit, or no handoff', () => {
    expect(commitMessage(none)).toBeUndefined();
    expect(commitMessage(undefined)).toBeUndefined();
  });
});
