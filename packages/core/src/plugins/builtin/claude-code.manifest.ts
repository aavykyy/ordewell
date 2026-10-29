import type { RunnerManifest } from '../types';
import { claudeConfigDir, parseAnthropicModels, parseClaudeHelp, readClaudeSettingsModels } from './claudeModels';

/**
 * A turn on a signed-out account ends with this line, which the status
 * command's JSON reader cannot parse; the reader matches it on a failed
 * turn's words as the failure fallback. Anchored to the whole phrase: a
 * failure can quote another tool that is not logged in, and that is not this
 * runner's own verdict.
 */
const TURN_NOT_LOGGED_IN = /not logged in\s*·\s*please run \/login/i;

export const CLAUDE_CODE_MANIFEST: RunnerManifest = {
  name: 'claude-code',
  displayName: 'Claude Code',

  runner: { command: 'claude' },

  features: {
    permissionModeValues: {
      'default': 'default',
      'auto': 'auto',
      'acceptEdits': 'acceptEdits',
      'plan': 'default',
      'bypassPermissions': 'bypassPermissions',
      // Legacy aliases used by older tasks
      'build': 'acceptEdits',
    },
  },

  modelDiscovery: {
    method: 'command',
    // Claude Code has no `claude models` subcommand. Discovery tries three
    // sources in order, each falling through to the next on failure:
    //
    // 1. Anthropic Models API (apiDiscovery) — GET /v1/models returns the
    //    authoritative live list of models the user's account can access,
    //    including aliases the --help prose omits (e.g. haiku). Auth works for
    //    both API-key users (ANTHROPIC_API_KEY → X-Api-Key) and OAuth/claude.ai
    //    users (token from ~/.claude/.credentials.json → Authorization: Bearer).
    //    Short aliases (opus, sonnet, haiku, fable) are derived from the full
    //    model IDs, deduplicated by family keeping the latest.
    //
    // 2. `claude --help` prose (discoveryCommands) — the CLI's --model
    //    description lists example aliases. Fragile (uses "e.g.", not
    //    exhaustive) but works offline and needs no auth.
    //
    // 3. canonicalAliases — stable --model contracts (opus/sonnet/haiku/fable)
    //    merged into any successful result to fill gaps, and used as the full
    //    last-resort list when both API and CLI are unavailable.
    //
    // Whichever source answers, the models the user added to Claude's own
    // picker (`modelPicker.options` in its managed or user settings, usually
    // gateway IDs) are appended (settingsModels): the CLI accepts them as
    // `--model` values though no catalog above lists them.
    apiDiscovery: {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'anthropic-version': '2023-06-01' },
      auth: [
        { type: 'env', varName: 'ANTHROPIC_API_KEY', header: 'X-Api-Key' },
        { type: 'file', path: (env) => `${claudeConfigDir(env)}/.credentials.json`, jsonPath: 'claudeAiOauth.accessToken', header: 'Authorization', prefix: 'Bearer ' },
      ],
      parser: parseAnthropicModels,
    },
    discoveryCommands: [
      { command: 'claude', args: ['--help'], parser: parseClaudeHelp },
    ],
    settingsModels: (files) => readClaudeSettingsModels(files),
    canonicalAliases: [
      { modelId: 'opus', modelLabel: 'Opus' },
      { modelId: 'sonnet', modelLabel: 'Sonnet' },
      { modelId: 'haiku', modelLabel: 'Haiku' },
      { modelId: 'fable', modelLabel: 'Fable' },
    ],
    variants: [
      { id: 'adaptive', label: 'Adaptive' },
      { id: 'low', label: 'Low effort' },
      { id: 'medium', label: 'Medium effort' },
      { id: 'high', label: 'High effort' },
      { id: 'xhigh', label: 'Extra high effort' },
      { id: 'max', label: 'Max effort' },
    ],
  },

  auth: {
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    // The reader matches this on a failed turn's own words; the status
    // command's JSON reader cannot parse that line.
    signedOut: TURN_NOT_LOGGED_IN,
    // The status command prints JSON on stdout; an older CLI prints prose
    // instead, which must stay unknown rather than claiming the user is signed
    // out. stderr is read only when stdout is empty: CLI warnings go there,
    // and parsing the two streams as one document would hide a signed-out
    // answer behind any warning beside it. A failed turn's words are never
    // JSON: only the failure phrase is the runner's own verdict there.
    read: ({ stdout, stderr, code, kind, output }) => {
      if (code === 0) return 'signed-in';
      const answer = stdout.trim() || stderr.trim();
      try {
        const parsed: unknown = JSON.parse(answer);
        if (parsed && typeof parsed === 'object' && (parsed as { authMethod?: unknown }).authMethod === 'none') return 'signed-out';
      } catch {
        // Not JSON: nothing here says why the command failed.
      }
      if (kind === 'turn' && TURN_NOT_LOGGED_IN.test(output)) return 'signed-out';
      return null;
    },
  },

  contextFile: 'CLAUDE.md',
  contextFileAltPath: '.claude/CLAUDE.md',

  modes: [
    { id: 'default', label: 'Ask before edits', description: 'Standard mode: asks permission before editing files', cliValue: 'default' },
    { id: 'auto', label: 'Auto', description: 'Claude\'s classifier approves or blocks each action, so routine work proceeds without prompts', cliValue: 'auto', safe: true },
    { id: 'acceptEdits', label: 'Edit automatically', description: 'Edits files without asking, still asks for risky operations', cliValue: 'acceptEdits' },
    { id: 'plan', label: 'Read-only', description: 'Native reads and Ordewell commands; lands nothing', cliValue: 'default', readOnly: true },
    { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skips all permission prompts: use for AI-driven autonomous runs', cliValue: 'bypassPermissions', autonomous: true },
  ],
};
