import { describe, it, expect } from 'vitest';
import { compareVersions, parseVersion } from '../version';

describe('parseVersion', () => {
  it('reads a dotted numeric version, with or without a v prefix or suffix', () => {
    expect(parseVersion('2.1.304')).toEqual([2, 1, 304]);
    expect(parseVersion('v1.18.34')).toEqual([1, 18, 34]);
    expect(parseVersion(' 2.0.32 ')).toEqual([2, 0, 32]);
    expect(parseVersion('2.0.32-beta.1')).toEqual([2, 0, 32]);
  });

  it('refuses what it cannot read', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('2.x.1')).toBeNull();
  });
});

describe('compareVersions', () => {
  it.each([
    ['2.1.304', '2.1.304', 0],
    ['2.1.304', '2.1.305', -1],
    ['2.1.305', '2.1.304', 1],
    ['2.1', '2.1.0', 0],
    ['2.1.9', '2.1.10', -1],
    ['1.18.34', '2.0.32', -1],
    ['2.2.0', '2.1.304', 1],
    ['2.1.304-beta.1', '2.1.304', -1],
    ['2.1.304', '2.1.304+build.7', 0],
  ])('%s against %s is %i', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it('sorts a version it cannot read as the oldest', () => {
    expect(compareVersions('latest', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', 'latest')).toBe(1);
    expect(compareVersions('latest', 'unknown')).toBe(0);
  });
});
