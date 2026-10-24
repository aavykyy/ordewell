import { describe, it, expect, vi } from 'vitest';
import { TASK_TOOLS, type TaskCompleteArgs } from '../tools';

/**
 * What a runner reads when `task_complete` refuses its arguments (ADR-0047).
 * A runner that cut its summary to 380 characters could not tell why a
 * 1600-to-9000-character call was refused; the refusal named the field and the
 * limit but not what arrived, and said nothing about the tool-call markup that
 * had leaked `findings` and `report` into the string.
 */

const taskComplete = TASK_TOOLS.find((t) => t.name === 'task_complete')!;
const context = { signal: new AbortController().signal };

async function call(args: unknown) {
  const handler = { taskComplete: vi.fn(async (_args: TaskCompleteArgs) => ({ text: 'recorded' })) };
  const reply = await taskComplete.call(handler, args, context);
  return { ...reply, handler };
}

describe('task_complete length refusals', () => {
  it('names the received length and the leaked parameters when markup swallowed findings and report', async () => {
    const body = 'x'.repeat(8000);
    const summary = `Short summary.\n${'s'.repeat(370)}</parameter>\n<parameter name="findings">${body}</parameter>\n<parameter name="report">${body}`;

    const { text, isError, handler } = await call({ status: 'done', summary });

    expect(isError).toBe(true);
    expect(text).toContain(`summary is ${summary.length} characters; the limit is 1500`);
    expect(text).toContain('leaked tool-call markup');
    expect(text).toContain('"findings"');
    expect(text).toContain('"report"');
    expect(text).toMatch(/separate arguments/);
    expect(handler.taskComplete).not.toHaveBeenCalled();
  });

  it('names the received length of a plain oversized summary, with no markup hint', async () => {
    const summary = 's'.repeat(1501);

    const { text, isError } = await call({ status: 'done', summary });

    expect(isError).toBe(true);
    expect(text).toContain(`summary is 1501 characters; the limit is 1500`);
    expect(text).not.toMatch(/leaked/i);
  });

  it('accepts a summary of exactly 1500 characters', async () => {
    const summary = 's'.repeat(1500);

    const { isError, handler } = await call({ status: 'done', summary });

    expect(isError).toBeFalsy();
    expect(handler.taskComplete).toHaveBeenCalledTimes(1);
  });

  it('names the received length of an oversized report', async () => {
    const report = 'r'.repeat(20_001);

    const { text, isError } = await call({ status: 'done', summary: 'Short', report });

    expect(isError).toBe(true);
    expect(text).toContain(`report is 20001 characters; the limit is 20000`);
    expect(text).not.toMatch(/leaked/i);
  });

  it("names a finding's field by its path and received length", async () => {
    const title = 't'.repeat(201);

    const { text, isError } = await call({ status: 'done', summary: 'Short', findings: [{ severity: 'major', title }] });

    expect(isError).toBe(true);
    expect(text).toContain(`findings[0].title is 201 characters; the limit is 200`);
  });

  it('counts the items of an oversized list', async () => {
    const artifacts = Array.from({ length: 21 }, (_, i) => ({ kind: 'file', path: `src/${i}.ts` }));

    const { text, isError } = await call({ status: 'done', summary: 'Short', artifacts });

    expect(isError).toBe(true);
    expect(text).toContain(`artifacts is 21 items; the limit is 20`);
  });
});
