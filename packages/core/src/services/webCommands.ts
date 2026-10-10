import { isIP } from 'node:net';
import { dialectFor, lex, type Segment } from './shellLexer';
import { unwrap } from './commandRunners';
import type { ShellDialect } from './researchShell';
import { blockedAddressReason } from './egressGuard';

interface WebCommand {
  urls: URL[];
  perInvocation?: boolean;
  reason?: string;
}

const CURL_SWITCHES = new Set(['s', 'S', 'f', 'i', 'I', 'v', 'L', 'q', 'G',
  '--silent', '--show-error', '--fail', '--include', '--head', '--verbose', '--location', '--disable', '--get', '--compressed', '--version']);
const CURL_VALUES = new Set(['A', 'm', 'o', 'w', '--user-agent', '--max-time', '--connect-timeout', '--output', '--write-out', '--noproxy']);
const CURL_SENSITIVE = new Set(['d', 'F', 'u', 'H', 'b', 'e', 'X', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '--form', '--form-string', '--user', '--header', '--cookie', '--referer', '--request']);
const WGET_SWITCHES = new Set(['q', 'S', 'v', '--quiet', '--server-response', '--verbose', '--no-verbose', '--spider', '--no-config', '--no-hsts', '--no-proxy', '--no-netrc', '--version']);
const WGET_VALUES = new Set(['O', 'U', 'T', '--output-document', '--user-agent', '--timeout', '--connect-timeout', '--read-timeout', '--max-redirect']);

export function webCommand(seg: Segment): WebCommand | undefined {
  const binary = seg.binary.toLowerCase();
  if (binary !== 'curl' && binary !== 'wget') return undefined;
  const urls: URL[] = [];
  const switches = binary === 'curl' ? CURL_SWITCHES : WGET_SWITCHES;
  const values = binary === 'curl' ? CURL_VALUES : WGET_VALUES;
  let stdout = false;
  let perInvocation = false;
  let redirects = binary === 'wget';
  let getQuery = false;
  let queryData = false;
  const refused = (flag: string): WebCommand => ({ urls, reason: `"${binary} ${flag}" is not known to be a read-only web command. Use the Ordewell fetch tool instead.` });
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
        if (reason) return { urls, reason: `Blocked host: ${reason}. Use the Ordewell fetch tool instead.` };
      }
      if (url.username || url.password) perInvocation = true;
      urls.push(url);
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
        if (flag === 'L' || flag === '--location') redirects = true;
        if (flag === 'G' || flag === '--get') getQuery = true;
        continue;
      }
      const sensitive = binary === 'curl' && CURL_SENSITIVE.has(flag);
      if (!values.has(flag) && !sensitive) return refused(arg);
      const attached = long ? (arg.includes('=') ? arg.slice(flag.length + 1) : undefined) : flags.slice(j + 1).join('') || undefined;
      const value = attached ?? seg.args[++i];
      if (value === undefined) return refused(arg);
      if (flag === '--noproxy' && value !== '*') return refused(arg);
      if (binary === 'wget' && flag === '--max-redirect') redirects = value !== '0';
      if (sensitive) {
        if (flag === '--data-urlencode' && !value.includes('@')) queryData = true;
        else if (!((flag === 'X' || flag === '--request') && (value === 'GET' || value === 'HEAD'))) perInvocation = true;
      }
      if (binary === 'wget' && (flag === 'O' || flag === '--output-document')) {
        if (value !== '-') return refused(arg);
        stdout = true;
      }
      if ((flag === 'o' || flag === '--output') && value !== '/dev/null') return refused(arg);
      if ((flag === 'w' || flag === '--write-out') && (value.startsWith('@') || value.includes('%output{'))) return refused(arg);
      break;
    }
  }
  if (urls.length === 0) return refused('without a literal HTTP(S) URL');
  if (binary === 'wget' && !stdout && !seg.args.includes('--spider')) return refused('without stdout or --spider');
  return { urls, ...(perInvocation || redirects || (queryData && !getQuery) ? { perInvocation: true } : {}) };
}

export function disableWebCommandStartup(command: string, dialect?: ShellDialect): string {
  const syntax = dialectFor(dialect);
  const edits: Array<{ end: number; flags: string }> = [];
  for (const original of lex(command, [], syntax).segments) {
    const { seg } = unwrap(original, syntax);
    const binary = seg.binary.toLowerCase();
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
