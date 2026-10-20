import { describe, it, expect } from 'vitest';
import { commandLine, scriptBodyText, timeLimitText } from '../ScriptTask';

/**
 * A script task's body as a reader is shown it (ADR-0035): the approval card
 * puts it in front of the user as the consent, so each command must read as
 * exactly what runs.
 */
describe('commandLine', () => {
  it('quotes a word only where it needs to be', () => {
    expect(commandLine(['git', 'push', 'origin', 'feature/login'])).toBe('git push origin feature/login');
    expect(commandLine(['git', 'commit', '-m', "it's done"])).toBe("git commit -m 'it'\\''s done'");
    expect(commandLine(['printf', ''])).toBe("printf ''");
  });

  it('writes a line break or an invisible character as its escape, so one command is never two lines or reads reordered', () => {
    expect(commandLine(['echo', 'a\nrm -rf ~'])).toBe("echo $'a\\nrm -rf ~'");
    // A right-to-left override would make the rest of the word display backwards.
    expect(commandLine(['git', 'tag', 'v1‮2'])).toBe("git tag $'v1\\u202E2'");
    expect(commandLine(['echo', 'tab\there'])).toBe("echo $'tab\\there'");
  });
});

describe('scriptBodyText', () => {
  it('shows each command on a line of its own, then the time limit', () => {
    expect(scriptBodyText({ commands: [['git', 'push'], ['git', 'push', '--tags']], timeoutMs: 600_000 })).toBe('git push\ngit push --tags\n\nTime limit: 10 minutes.');
  });

  it('shows a script as written, but for a character a reader cannot see', () => {
    expect(scriptBodyText({ script: 'set -e\r\nfor f in *; do\n\techo "$f"\ndone‮', timeoutMs: 90_000 }))
      .toBe('set -e\r\nfor f in *; do\n\techo "$f"\ndone<U+202E>\n\nTime limit: 90 seconds.');
  });
});

describe('timeLimitText', () => {
  it('says a limit in the largest whole unit', () => {
    expect(timeLimitText(3_600_000)).toBe('1 hour');
    expect(timeLimitText(90_000)).toBe('90 seconds');
    expect(timeLimitText(1_500)).toBe('1500 milliseconds');
  });
});
