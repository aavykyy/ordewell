import { isIP } from 'node:net';
import { dialectFor, lex, lexAll, type Segment } from './shellLexer';
import { unwrap } from './commandRunners';
import type { ShellDialect } from './researchShell';
import { blockedAddressReason } from './egressGuard';

interface WebCommand {
  urls: URL[];
  urlTexts?: string[];
  perInvocation?: boolean;
  reason?: string;
  /** The command sends data or writes something; a fetch tool would not do the same job. */
  effect?: boolean;
}

// Runner-neutral on purpose: the planner's fetch tool is Ordewell's `fetch` for
// some runners and a native tool for others, and a name that is hidden from the
// model it is shown to only misleads it.
export const READ_REFUSAL_HINT = 'Fetch the page with your web fetch tool instead.';
export const EFFECT_REFUSAL_HINT = 'This sends data or changes something, so the planner should not do it itself: add it to the plan as an ops task (and, if it writes files, a change task).';

const CURL_EFFECT = new Set(['d', 'F', 'T', 'O', 'D', 'c', 'J', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--form', '--form-string',
  '--json', '--upload-file', '--remote-name', '--remote-name-all', '--dump-header', '--cookie-jar', '--create-dirs', '--output-dir', '--remote-header-name']);
const WGET_EFFECT = new Set(['P', 'r', 'm', 'N', 'c', 'a', 'o', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--output-file', '--append-output',
  '--directory-prefix', '--recursive', '--mirror', '--timestamping', '--continue', '--save-headers', '--content-disposition', '--input-file', '--warc-file', '--save-cookies']);

const CURL_SWITCHES = new Set(['s', 'S', 'f', 'i', 'I', 'v', 'L', 'q', 'G',
  '--silent', '--show-error', '--fail', '--include', '--head', '--verbose', '--location', '--disable', '--get', '--compressed', '--version']);
const CURL_VALUES = new Set(['A', 'm', 'o', 'w', '--user-agent', '--max-time', '--connect-timeout', '--output', '--write-out', '--noproxy']);
const CURL_SENSITIVE = new Set(['d', 'F', 'u', 'H', 'b', 'e', 'X', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '--form', '--form-string', '--user', '--header', '--cookie', '--referer', '--request']);
const WGET_SWITCHES = new Set(['q', 'S', 'v', '--quiet', '--server-response', '--verbose', '--no-verbose', '--spider', '--no-config', '--no-hsts', '--no-proxy', '--no-netrc', '--version']);
const WGET_VALUES = new Set(['O', 'U', 'T', '--output-document', '--user-agent', '--timeout', '--connect-timeout', '--read-timeout', '--max-redirect']);

export function webCommand(seg: Segment, trustedResolves?: ReadonlySet<string>): WebCommand | undefined {
  const binary = seg.binary.toLowerCase().replace(/\.exe$/, '');
  if (binary === 'wget2') return { urls: [], reason: `wget2 can write persistent databases. ${READ_REFUSAL_HINT}` };
  if (binary !== 'curl' && binary !== 'wget') return undefined;
  const urls: URL[] = [];
  const urlTexts: string[] = [];
  const switches = binary === 'curl' ? CURL_SWITCHES : WGET_SWITCHES;
  const values = binary === 'curl' ? CURL_VALUES : WGET_VALUES;
  let stdout = false;
  let spider = false;
  let perInvocation = false;
  let redirects = binary === 'wget';
  let getQuery = false;
  let queryData = false;
  let effect = false;
  const effectFlags = binary === 'curl' ? CURL_EFFECT : WGET_EFFECT;
  const refused = (flag: string, sends = false): WebCommand => sends
    ? { urls, effect: true, reason: `"${binary} ${flag}" is not a read-only web command. ${EFFECT_REFUSAL_HINT}` }
    : { urls, reason: `"${binary} ${flag}" is not known to be a read-only web command. ${READ_REFUSAL_HINT}` };
  if (seg.expandable || seg.globbed) return refused('with shell expansions or globbing');
  for (let i = 0; i < seg.args.length; i++) {
    const arg = seg.args[i];
    if (arg === '-') return refused(arg);
    if (!arg.startsWith('-')) {
      let url: URL;
      try { url = new URL(arg); } catch { return refused(arg); }
      if (!/^https?:\/\//i.test(arg) || /[\\\s{}]/.test(arg)) return refused(arg);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const withoutHost = arg.replace(url.hostname, '');
      if (/[[\]]/.test(withoutHost)) return refused(arg);
      if (isIP(host)) {
        const reason = blockedAddressReason(host);
        if (reason) return { urls, reason: `Blocked host: ${reason}. ${READ_REFUSAL_HINT}` };
      }
      if (url.username || url.password) perInvocation = true;
      urls.push(url);
      urlTexts.push(arg);
      continue;
    }
    const long = arg.startsWith('--');
    const flags = long ? [arg.split('=')[0]] : [...arg.slice(1)];
    for (let j = 0; j < flags.length; j++) {
      const flag = flags[j];
      if (binary === 'curl' && (flag === 'n' || flag === '--netrc' || flag === '--netrc-optional')) {
        if (arg.includes('=')) return refused(arg);
        perInvocation = true;
        continue;
      }
      if (switches.has(flag)) {
        if (long && arg.includes('=')) return refused(arg);
        if (flag === '--spider') spider = true;
        if (flag === 'L' || flag === '--location') redirects = true;
        if (flag === 'G' || flag === '--get') getQuery = true;
        continue;
      }
      const sensitive = binary === 'curl' && CURL_SENSITIVE.has(flag);
      const sends = effectFlags.has(flag) && !sensitive;
      if (sends && !(binary === 'wget' && (flag === 'O' || flag === '--output-document'))) return refused(arg, true);
      const trustedResolve = binary === 'curl' && flag === '--resolve' && trustedResolves !== undefined;
      if (!values.has(flag) && !sensitive && !trustedResolve) return refused(arg);
      const attached = long ? (arg.includes('=') ? arg.slice(flag.length + 1) : undefined) : flags.slice(j + 1).join('') || undefined;
      const value = attached ?? seg.args[++i];
      if (value === undefined) return refused(arg);
      if (trustedResolve && !trustedResolves?.has(value)) return refused(arg);
      if (flag === '--noproxy' && value !== '*') return refused(arg);
      if (binary === 'wget' && flag === '--max-redirect') redirects = value !== '0';
      if (sensitive) {
        if (flag === '--data-urlencode' && !value.includes('@')) queryData = true;
        else if (!((flag === 'X' || flag === '--request') && (value === 'GET' || value === 'HEAD'))) {
          perInvocation = true;
          effect = true;
        }
      }
      if (binary === 'wget' && (flag === 'O' || flag === '--output-document')) {
        if (value !== '-') return refused(arg, true);
        stdout = true;
      }
      if ((flag === 'o' || flag === '--output') && value !== '/dev/null') return refused(arg, binary === 'curl');
      if ((flag === 'w' || flag === '--write-out') && (value.startsWith('@') || value.includes('%output{'))) return refused(arg);
      break;
    }
  }
  if (urls.length === 0) return refused('without a literal HTTP(S) URL');
  if (binary === 'wget' && !stdout && !spider) return refused('without stdout or --spider');
  return { urls, urlTexts, ...(effect ? { effect } : {}), ...(perInvocation || redirects || (queryData && !getQuery) ? { perInvocation: true } : {}) };
}

export function disableWebCommandStartup(command: string, dialect?: ShellDialect): string {
  const syntax = dialectFor(dialect);
  const edits: Array<{ end: number; flags: string }> = [];
  for (const original of lex(command, [], syntax).segments) {
    const { seg } = unwrap(original, syntax);
    const binary = seg.binary.toLowerCase().replace(/\.exe$/, '');
    if (binary !== 'curl' && binary !== 'wget') continue;
    const ends = original.wordEnds ?? [];
    const end = ends[ends.length - seg.args.length - 1];
    const noProxy = syntax.escape === '^' ? '"*"' : "'*'";
    if (end !== undefined) edits.push({ end, flags: binary === 'curl' ? ` -q --noproxy ${noProxy}` : ' --no-config --no-hsts --no-proxy --no-netrc' });
  }
  for (const { end, flags } of edits.sort((a, b) => b.end - a.end)) {
    command = command.slice(0, end) + flags + command.slice(end);
  }
  return command;
}

export function pinWebCommandAddresses(command: string, addresses: ReadonlyMap<string, string>, dialect?: ShellDialect): { command: string; resolves: ReadonlySet<string> } {
  const syntax = dialectFor(dialect);
  const resolves = new Set<string>();
  const edits: Array<{ end: number; flags: string }> = [];
  for (const original of lex(command, [], syntax).segments) {
    const { seg } = unwrap(original, syntax);
    if (seg.binary.toLowerCase().replace(/\.exe$/, '') !== 'curl') continue;
    const web = webCommand(seg);
    if (!web || web.reason) continue;
    const flags = [...new Set(web.urls.map((url) => url.origin))].flatMap((origin) => {
      const url = new URL(origin);
      if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return [];
      const address = addresses.get(origin);
      if (!address) throw new Error('Missing vetted curl address');
      const value = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}:${isIP(address) === 6 ? `[${address}]` : address}`;
      resolves.add(value);
      return [` --resolve ${syntax.escape === '^' ? `"${value}"` : `'${value}'`}`];
    }).join('');
    const ends = original.wordEnds ?? [];
    const end = ends[ends.length - seg.args.length - (seg.args[0] === '-q' ? 0 : 1)];
    if (end !== undefined && flags) edits.push({ end, flags });
  }
  for (const { end, flags } of edits.sort((a, b) => b.end - a.end)) {
    command = command.slice(0, end) + flags + command.slice(end);
  }
  return { command, resolves };
}

export function wgetVersionCommands(command: string, dialect?: ShellDialect): Array<string | undefined> {
  const syntax = dialectFor(dialect);
  const { segments } = lexAll(command, syntax, !!process.env.CDPATH);
  const quote = (word: string) => syntax.escape === '^' ? `"${word}"` : `'${word.replace(/'/g, "'\\''")}'`;
  return [...new Set(segments.flatMap((original) => {
    const { seg } = unwrap(original, syntax);
    if (seg.binary.toLowerCase().replace(/\.exe$/, '') !== 'wget') return [];
    const executable = seg.binaryPath ?? seg.binary;
    if (!/^(\/|[A-Za-z]:[\\/])/.test(executable)
      && original.cwd === undefined && segments.some((s) => /^(cd|pushd|popd)$/i.test(s.binary))) return [undefined];
    const navigation = (original.cwd ?? []).map((target) => `cd ${quote(target)} && `).join('');
    // Wget2 creates its data directory even for --version, before parsing flags.
    const env = syntax.escape === '^'
      ? 'set "XDG_DATA_HOME=/dev/null" && set "XDG_CONFIG_HOME=/dev/null" && set "LOCALAPPDATA=NUL" && '
      : 'XDG_DATA_HOME=/dev/null XDG_CONFIG_HOME=/dev/null LOCALAPPDATA=NUL ';
    return [`${navigation}${env}${quote(executable)} --no-config --version`];
  }))];
}
