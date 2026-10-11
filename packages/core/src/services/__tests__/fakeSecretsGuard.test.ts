import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_SHAPES } from '../outboundSecrets';
import { fakeSecret, type FakeSecretKind } from './fakeSecret';

const REPO_ROOT = join(__dirname, '../../../../..');
// A PEM header alone is not a secret and is legitimate test input.
const SHAPES = TOKEN_SHAPES.filter((shape) => !shape.source.startsWith('-----BEGIN'));

describe('fake secret fixtures', () => {
  it('no tracked file other than outboundSecrets.ts holds a literal token', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((file) => file && !/(?:package-lock\.json|outboundSecrets\.ts)$/.test(file));

    const offenders: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf8');
      } catch {
        continue;
      }
      if (SHAPES.some((shape) => shape.test(text))) offenders.push(file);
    }

    expect(offenders, 'build fake secrets with fakeSecret() instead of a literal').toEqual([]);
  });

  it('every fakeSecret() kind is still recognised as a token shape', () => {
    const kinds: FakeSecretKind[] = ['github', 'githubFineGrained', 'google', 'gitlab', 'stripeLive', 'stripeRestricted', 'huggingFace', 'npm', 'aws', 'slack', 'jwt'];
    for (const kind of kinds) expect(SHAPES.some((shape) => shape.test(fakeSecret(kind))), kind).toBe(true);
  });
});
