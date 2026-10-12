/**
 * Whether two messages say the same thing. Claude Code words a usage limit
 * alike in its assistant message and in the `result` of the failed turn, but
 * for whitespace and a final period.
 */
export function sameMessage(a: string, b: string): boolean {
  const bare = (value: string) => value.trim().replace(/\.+$/, '').trimEnd();
  return bare(a) !== '' && bare(a) === bare(b);
}
