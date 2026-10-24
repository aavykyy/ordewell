import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSetup } from '../setup';

const KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'] as const;

describe('ordewell setup', () => {
  let home = '';
  let realHome: string | undefined;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    realHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-setup-'));
    process.env.HOME = home;
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function written(): string {
    return fs.readFileSync(path.join(home, '.ordewell', '.env'), 'utf8');
  }

  it('keeps an OpenAI key under its own name', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-secret';
    handleSetup([]);

    expect(written()).toContain('OPENAI_API_KEY=sk-openai-secret');
    expect(written()).not.toContain('OPENROUTER_API_KEY=sk-openai-secret');
  });

  it('keeps an OpenRouter key under its own name', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    handleSetup([]);

    expect(written()).toContain('OPENROUTER_API_KEY=sk-or-secret');
  });
});
