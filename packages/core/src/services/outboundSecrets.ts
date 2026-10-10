/**
 * The outbound secret check (ADR-0027): whether text about to leave the
 * machine on the planner's behalf — a URL, a search query — carries a secret.
 * It narrows exfiltration through a URL; it does not close it. A secret that
 * is base64'd, reversed or split across requests passes.
 */

const SENSITIVE_ENV_NAME = /(?:^|_)(?:KEY|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;
/** Below this, a value is too likely to occur in an ordinary URL (`true`, `1`, `dev`) to mean anything. */
const MIN_SECRET_LENGTH = 8;
const MAX_DECODE_ROUNDS = 3;

const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\b(?:hf|npm)_[A-Za-z0-9]{20,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z0-9 ]+-----/,
];

/**
 * `sk-` prefixes most LLM provider keys, and also ordinary slugs
 * (`sk-learn-tutorial`). A key's random tail mixes cases and digits; a slug
 * does not.
 */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{20,}/g;

function looksRandom(tail: string): boolean {
  return /[a-z]/.test(tail) && /[A-Z]/.test(tail) && /\d/.test(tail);
}

/** Decode what decodes: one malformed `%zz` must not hide the rest. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The text as sent and as each layer of percent-encoding would read it. */
function forms(text: string): string[] {
  const seen = [text, text.replace(/\+/g, ' ')];
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = percentDecode(current);
    if (next === current) break;
    seen.push(next, next.replace(/\+/g, ' '));
    current = next;
  }
  return seen;
}

/** The values of environment variables named like a credential. */
export function sensitiveEnvValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && value !== undefined)
    .map(([, value]) => (value ?? '').trim())
    .filter((value) => !isReference(value));
}

function isReference(value: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/.test(value)) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Whether any of `texts`, raw or decoded, contains a held secret or a well-known token. */
export function carriesSecret(texts: readonly string[], held: Iterable<string>): boolean {
  const secrets = [...held].map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET_LENGTH);
  return texts.flatMap(forms).some((text) =>
    secrets.some((secret) => text.includes(secret))
    || TOKEN_SHAPES.some((shape) => shape.test(text))
    || [...text.matchAll(SK_KEY)].some((m) => looksRandom(m[0].slice(3))));
}
