import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pad, stripAnsi, style, truncate, width } from '../ansi';
import { inkOf, visible } from './paint';

let saved: { enabled: boolean; attributes: boolean };

beforeEach(() => {
  saved = { enabled: style.enabled, attributes: style.attributes };
  style.enabled = true;
  style.attributes = true;
});

afterEach(() => {
  Object.assign(style, saved);
});

describe('truncate keeps the paint of the text it keeps', () => {
  it('keeps a colour through the cut instead of dropping every escape', () => {
    const cut = truncate(style.cyan('research findings'), 8);

    expect(visible(cut)).toBe('researc…');
    expect(inkOf(cut, 'researc')).toMatchObject({ fg: 'cyan' });
  });

  it('keeps a style that opens partway through the text', () => {
    const cut = truncate(`id ${style.green('ok')} then more`, 5);

    expect(visible(cut)).toBe('id o…');
    expect(inkOf(cut, 'id')).toMatchObject({ fg: null });
    expect(inkOf(cut, 'o')).toMatchObject({ fg: 'green' });
  });

  it('keeps nested colour changes, and the outer colour resumes after the cut', () => {
    const line = style.grey(`${style.cyan('research')} · opencode`);
    const cut = truncate(line, 15);

    expect(visible(cut)).toBe('research · ope…');
    expect(inkOf(cut, 'research')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(cut, ' · ope')).toMatchObject({ fg: 'grey' });
  });

  it('closes what it leaves open, so text appended after it is unpainted', () => {
    const cut = truncate(style.cyan('abcdefgh'), 5) + 'tail';

    expect(inkOf(cut, 'abcd')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(cut, 'tail')).toMatchObject({ fg: null });
  });

  it('keeps bold when bold is what the text carried', () => {
    const cut = truncate(style.bold('a bold sentence'), 6);

    expect(visible(cut)).toBe('a bol…');
    expect(inkOf(cut, 'a bol')).toMatchObject({ bold: true });
  });
});

describe('truncate keeps glyph and width limits while painted', () => {
  it('never splits a wide glyph and keeps the retained ones painted', () => {
    const cut = truncate(style.cyan('日本語です'), 5);

    expect(width(cut)).toBeLessThanOrEqual(5);
    expect(visible(cut)).toBe('日本…');
    expect(inkOf(cut, '日本')).toMatchObject({ fg: 'cyan' });
  });

  it('never cuts inside a ZWJ sequence', () => {
    const family = '👨‍👩‍👧';
    const cut = truncate(style.magenta(family.repeat(3)), 5);

    expect(visible(cut)).toBe(`${family}${family}…`);
    expect(inkOf(cut, family)).toMatchObject({ fg: 'magenta' });
  });
});

describe('pad keeps the paint of a string it has to cut', () => {
  it('truncates a painted string without dropping its colour', () => {
    const padded = pad(style.cyan('research findings'), 8);

    expect(width(padded)).toBe(8);
    expect(visible(padded)).toBe('researc…');
    expect(inkOf(padded, 'researc')).toMatchObject({ fg: 'cyan' });
  });

  it('leaves text appended after the padded value unpainted', () => {
    const line = pad(style.cyan('ab'), 5) + 'tail';

    expect(inkOf(line, 'ab')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(line, 'tail')).toMatchObject({ fg: null });
  });
});

describe('a nested style does not end the one around it', () => {
  it('restores the outer grey after an inner cyan reset', () => {
    const line = style.grey(`${style.cyan('research')} · opencode · DeepSeek V4.1 Flash`);

    expect(inkOf(line, 'research')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(line, ' · opencode · DeepSeek V4.1 Flash')).toMatchObject({ fg: 'grey' });
  });

  it('restores bold after an inner colour reset', () => {
    const line = style.bold(`before ${style.cyan('middle')} after`);

    expect(inkOf(line, 'before')).toMatchObject({ bold: true });
    expect(inkOf(line, 'after')).toMatchObject({ bold: true });
  });
});

describe('with colour or attributes off', () => {
  it('adds no escapes to a cut when colour is disabled', () => {
    style.enabled = false;

    expect(truncate(style.cyan('abcdefgh'), 5)).toBe('abcd…');
    expect(pad(style.cyan('abcdefgh'), 5)).toBe('abcd…');
    expect(stripAnsi(truncate(style.cyan('abcdefgh'), 5))).toBe('abcd…');
  });

  it('keeps inverse through a cut while colour is disabled, since it marks the caret', () => {
    style.enabled = false;

    const cut = truncate(style.inverse('abcdefgh'), 5);

    expect(visible(cut)).toBe('abcd…');
    expect(inkOf(cut, 'abcd')).toMatchObject({ inverse: true });
  });

  it('adds no attribute when attributes are disabled', () => {
    style.enabled = false;
    style.attributes = false;

    expect(truncate(style.inverse('abcdefgh'), 5)).toBe('abcd…');
    expect(pad(style.inverse('abcdefgh'), 5)).toBe('abcd…');
  });
});
