/**
 * A dotted numeric version, compared the way a harness reports it: `2.1.304`.
 * A missing component counts as zero, so `2.1` and `2.1.0` are the same
 * version, and a `v` prefix is not part of it. A prerelease (`2.1.304-beta`)
 * sorts before the release it names, so a build the live checks did not cover
 * is never mistaken for the checked one.
 */
interface Version {
  numbers: number[];
  /** Everything after the first `-`, without the build suffix; null for a release. */
  prerelease: string | null;
}

function parse(version: string): Version | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(version.trim());
  if (!match) return null;
  return { numbers: match[1].split('.').map(Number), prerelease: match[2] ?? null };
}

/** The numeric components of a version, or null when it cannot be read. */
export function parseVersion(version: string): number[] | null {
  return parse(version)?.numbers ?? null;
}

/** Negative, zero or positive as `a` is older than, the same as, or newer than `b`; an unreadable version sorts oldest. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < length; i++) {
    const one = left.numbers[i] ?? 0;
    const other = right.numbers[i] ?? 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}
