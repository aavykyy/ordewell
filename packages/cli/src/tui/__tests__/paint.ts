import { graphemes } from '../ansi';

/**
 * What a terminal would actually draw, read back from a painted string.
 *
 * A test that asserts an escape is somewhere in a row cannot tell "research is
 * cyan" from "the line opened cyan and lost it before the word". These helpers
 * interpret the SGR state at each visible character, so a regression pins the
 * colour the reader sees rather than the byte sequence that may or may not
 * still be in force.
 */
export interface Ink {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

export interface PaintedCell {
  char: string;
  ink: Ink;
}

export interface PaintedRun {
  text: string;
  ink: Ink;
}

const blank = (): Ink => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

const sameInk = (a: Ink, b: Ink): boolean =>
  a.fg === b.fg
  && a.bg === b.bg
  && a.bold === b.bold
  && a.dim === b.dim
  && a.italic === b.italic
  && a.underline === b.underline
  && a.strike === b.strike
  && a.inverse === b.inverse;

const FOREGROUND: Record<number, string> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'grey', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow', 94: 'bright-blue',
  95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
};

const BACKGROUND: Record<number, string> = {
  40: 'black', 41: 'red', 42: 'green', 43: 'yellow', 44: 'blue', 45: 'magenta', 46: 'cyan', 47: 'white',
  100: 'bright-black', 101: 'bright-red', 102: 'bright-green', 103: 'bright-yellow', 104: 'bright-blue',
  105: 'bright-magenta', 106: 'bright-cyan', 107: 'bright-white',
};

/** Apply one SGR parameter list to `ink`, in place. Unsupported codes are ignored. */
function applySgr(params: string, ink: Ink): void {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(ink, blank());
    else if (code === 1) ink.bold = true;
    else if (code === 2) ink.dim = true;
    else if (code === 3) ink.italic = true;
    else if (code === 4) ink.underline = true;
    else if (code === 7) ink.inverse = true;
    else if (code === 9) ink.strike = true;
    else if (code === 22) { ink.bold = false; ink.dim = false; }
    else if (code === 23) ink.italic = false;
    else if (code === 24) ink.underline = false;
    else if (code === 27) ink.inverse = false;
    else if (code === 29) ink.strike = false;
    else if (code === 38 || code === 48) {
      const extended = codes[i + 1];
      if (extended === 5) {
        const slot = codes[i + 2];
        const value = `${code};5;${slot}`;
        if (code === 38) ink.fg = value; else ink.bg = value;
        i += 2;
      } else if (extended === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
        const value = `${code};2;${r};${g};${b}`;
        if (code === 38) ink.fg = value; else ink.bg = value;
        i += 4;
      }
    } else if (code === 39) ink.fg = null;
    else if (code === 49) ink.bg = null;
    else if (FOREGROUND[code]) ink.fg = FOREGROUND[code];
    else if (BACKGROUND[code]) ink.bg = BACKGROUND[code];
  }
}

// eslint-disable-next-line no-control-regex
const SGR = /^\x1b\[([0-9;]*)m/;
// eslint-disable-next-line no-control-regex
const CSI = /^\x1b\[[0-?]*[ -/]*[@-~]/;

/** Every visible character in `line`, with the style it is drawn in. */
export function cells(line: string): PaintedCell[] {
  const out: PaintedCell[] = [];
  const ink = blank();
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const rest = line.slice(i);
      const sgr = SGR.exec(rest);
      if (sgr) {
        applySgr(sgr[1], ink);
        i += sgr[0].length;
        continue;
      }
      const csi = CSI.exec(rest);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const [char] = graphemes(line.slice(i));
    out.push({ char, ink: { ...ink } });
    i += char.length;
  }
  return out;
}

/** The visible text, with every escape dropped. */
export function visible(line: string): string {
  return cells(line).map((cell) => cell.char).join('');
}

/** Adjacent characters that share one style, as the terminal would draw them. */
export function runs(line: string): PaintedRun[] {
  const out: PaintedRun[] = [];
  for (const cell of cells(line)) {
    const last = out.at(-1);
    if (last && sameInk(last.ink, cell.ink)) last.text += cell.char;
    else out.push({ text: cell.char, ink: cell.ink });
  }
  return out;
}

/**
 * The style of every character of the first occurrence of `text` in the
 * visible line. Mixed styles are an error: a needle like `research` must be
 * one colour, so a test cannot pass because the escape appears somewhere in
 * the middle of it.
 */
export function inkOf(line: string, text: string): Ink {
  const painted = cells(line);
  for (let start = 0; start < painted.length; start++) {
    let joined = '';
    for (let end = start; end < painted.length; end++) {
      joined += painted[end].char;
      if (joined === text) {
        const first = painted[start].ink;
        if (painted.slice(start, end + 1).some((cell) => !sameInk(cell.ink, first))) {
          throw new Error(`"${text}" is painted in more than one style: ${JSON.stringify(runs(line))}`);
        }
        return first;
      }
      if (!text.startsWith(joined)) break;
    }
  }
  throw new Error(`"${text}" is not in the visible line: ${JSON.stringify(visible(line))}`);
}
