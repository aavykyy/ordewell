import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { landingMessage, messageArgs, quotedMessageArgs } from '../landingMessage';

describe('landingMessage', () => {
  const stated = { title: 'Add greeting', commit: { subject: 'Greet the user on start', body: 'The banner was empty.\nNow it says hi.' } };

  it('writes the stated subject and body on the work and its landing merge', () => {
    expect(landingMessage('work', stated)).toBe('Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
    expect(landingMessage('merge', stated)).toBe('Merge: Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
  });

  it('names the task in a repair merge by its subject alone', () => {
    expect(landingMessage('repair-merge', stated)).toBe('Merge: Greet the user on start (resolve conflicts with integration)');
  });

  it('falls back to the first line of the title when no commit was stated', () => {
    const untitled = { title: '  Add greeting  \nand more' };
    expect(landingMessage('work', untitled)).toBe('Add greeting');
    expect(landingMessage('merge', untitled)).toBe('Merge: Add greeting');
    expect(landingMessage('repair-merge', untitled)).toBe('Merge: Add greeting (resolve conflicts with integration)');
  });
});

describe('messageArgs', () => {
  it('passes each paragraph as its own -m, keeping the lines inside one', () => {
    expect(messageArgs('Subject\n\nLine one\nLine two\n\n\nTrailer: x')).toEqual(['-m', 'Subject', '-m', 'Line one\nLine two', '-m', 'Trailer: x']);
  });
});

describe.skipIf(process.platform === 'win32')('quotedMessageArgs', () => {
  it('reads back as the same arguments in a POSIX shell, quotes and all', () => {
    const message = "Merge: Fix the user's \"greeting\" $HOME `id`\n\nBody; with & and \\ too";
    const read = execFileSync('sh', ['-c', `set -- ${quotedMessageArgs(message)}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
    expect(read.split('\0').slice(0, -1)).toEqual(['-m', "Merge: Fix the user's \"greeting\" $HOME `id`", '-m', 'Body; with & and \\ too']);
  });
});
