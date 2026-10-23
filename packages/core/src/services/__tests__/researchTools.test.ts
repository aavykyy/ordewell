import { describe, it, expect } from 'vitest';
import { SchemaType } from '@google/generative-ai';
import { RESEARCH_TOOLS, toOpenAiTools, toGeminiToolDeclarations, subagentToolSpecs, SPAWN_RESEARCH_AGENT } from '../researchTools';

describe('researchTools', () => {
  it('exposes the same tool set to both providers', () => {
    const canonical = [...RESEARCH_TOOLS.map((t) => t.name), SPAWN_RESEARCH_AGENT].sort();
    const openai = toOpenAiTools().map((t) => t.function.name).sort();
    const gemini = toGeminiToolDeclarations().map((t) => t.name).sort();
    expect(openai).toEqual(canonical);
    expect(gemini).toEqual(canonical);
  });

  it('projects OpenAI tools as JSON-schema functions', () => {
    const readFile = toOpenAiTools().find((t) => t.function.name === 'read_file')!;
    expect(readFile.type).toBe('function');
    expect(readFile.function.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('spawn tool takes a single self-contained prompt (opencode-style, one agent per call)', () => {
    const spawn = toOpenAiTools().find((t) => t.function.name === SPAWN_RESEARCH_AGENT)!;
    expect(spawn.function.parameters).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    });
  });

  it('subagent toolset keeps the read-only and web tools but never recurses', () => {
    const names = subagentToolSpecs().map((t) => t.name);
    expect(names).toEqual(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir', 'bash', 'fetch', 'web_search']);
    expect(names).not.toContain('spawn_research_agent');
  });

  it('projects Gemini declarations using SchemaType enums', () => {
    const readFiles = toGeminiToolDeclarations().find((t) => t.name === 'read_files')!;
    const params = readFiles.parameters!;
    expect(params.type).toBe(SchemaType.OBJECT);
    expect(params.properties!.paths.type).toBe(SchemaType.ARRAY);
    expect(params.properties!.paths.items!.type).toBe(SchemaType.STRING);
  });

  it('withholds the spawn tool from a provider that cannot run subagents, keeping its reads', () => {
    const names = (declarations: ReturnType<typeof toGeminiToolDeclarations>) => declarations.map((d) => d.name);
    expect(names(toGeminiToolDeclarations())).toContain(SPAWN_RESEARCH_AGENT);
    expect(names(toGeminiToolDeclarations(false, false))).not.toContain(SPAWN_RESEARCH_AGENT);
    expect(names(toGeminiToolDeclarations(true, false))).not.toContain(SPAWN_RESEARCH_AGENT);
    expect(names(toGeminiToolDeclarations(true, false))).toEqual(expect.arrayContaining(['read_file', 'task_query', 'run_plan']));
  });
});

describe('planner task read tool projections', () => {
  it('offers the same attempt, kind and diff parameters to both API planners', () => {
    const openai = toOpenAiTools(true);
    const gemini = toGeminiToolDeclarations(true);
    for (const name of ['task_query', 'task_output', 'task_diff']) {
      const a = openai.find((t) => t.function.name === name)!.function.parameters!;
      const b = gemini.find((t) => t.name === name)!.parameters!;
      expect(Object.keys(a.properties as object)).toEqual(Object.keys(b.properties!));
      expect(a.required ?? []).toEqual(b.required ?? []);
    }
    const a = openai.find((t) => t.function.name === 'task_output')!.function.parameters!;
    expect(a.properties).toMatchObject({ attempt: { type: 'integer', minimum: 1 }, kinds: { items: { enum: expect.arrayContaining(['tool_call', 'tool_result', 'text', 'error', 'approval_requested', 'usage']) } } });
    const b = gemini.find((t) => t.name === 'task_output')!.parameters!;
    expect(b.properties!.kinds.items!.enum).toContain('usage');
  });
});
