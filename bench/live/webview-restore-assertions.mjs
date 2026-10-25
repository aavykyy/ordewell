#!/usr/bin/env node
/**
 * Chat reliability verification against the webview harness: a real
 * `ConversationViewHost` (ADR-0017) driving `restoreChat`/reload edge cases
 * the main screenshot tour (webview-screenshot.mjs) doesn't cover — a legacy
 * transcript with no plan marker, a reload that interrupts a live turn, a
 * restore that must clear a stuck local "stopped" flag, and the watchdog's
 * silent-turn recovery.
 *
 * Usage:
 *   node bench/live/webview-harness.mjs &
 *   node bench/live/webview-restore-assertions.mjs
 */
import path from 'node:path';
import { chromium } from './load-playwright.mjs';
import { createDriver } from './host-driver.mjs';
import { RELOAD_FIXTURE, RELOAD_PLAN } from './scenarios.mjs';

const BASE = 'http://127.0.0.1:3798';
let failures = 0;
const ok = (cond, name) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 1400 } });
await page.goto(BASE);
await page.waitForSelector('.chat-container');

// Each section below makes its own driver (a fresh session); the bridge
// always answers through whichever one is current, the way a real host would
// answer whatever session the webview is currently talking to.
let currentDriver = createDriver();
await page.exposeFunction('__toHost', async (msg) => {
  if (!currentDriver.reply(msg)) return;
  currentDriver.host.flush();
  await sendAll(currentDriver.take());
});

async function send(msg) {
  await page.evaluate((m) => window.__send(m), msg);
}
async function sendAll(msgs) {
  if (msgs.length) await page.evaluate((arr) => arr.forEach((m) => window.__send(m)), msgs);
}
const bodyText = () => page.evaluate(() => document.querySelector('.message-list')?.innerText ?? '');
// The input itself stays live during a turn (ADR-0017 Q1) — typing queues a
// message rather than being blocked — so "locked/unlocked" here means the
// disabled attribute, tied only to `conversationBusy`. Whether a turn is
// live is instead the stop button, `.send-btn.processing`.
const inputDisabled = () => page.evaluate(() => document.querySelector('.chat-input-row textarea')?.disabled ?? null);
const turnActive = () => page.evaluate(() => document.querySelector('.send-btn.processing') !== null);

console.log('1) restoreChat rebuilds the conversation from a saved transcript (R1)');
{
  const driver = createDriver();
  currentDriver = driver;
  await send({ type: 'restoreChat' });
  driver.host.reload(RELOAD_FIXTURE);
  await sendAll(driver.take());
  await send({ type: 'planUpdated', plan: RELOAD_PLAN });
  await page.waitForTimeout(200);
  const text = await bodyText();
  ok(text.includes('add a parser'), 'restored user goal visible');
  ok(text.includes('Which formats do you need?'), 'restored planner reply visible');
  ok(text.includes('Anything else you want tweaked?'), 'post-plan planner reply visible');
  ok(await page.locator('.plan-revision-chip').count() === 1, 'plan marker restored');
  ok(await inputDisabled() === false, 'input enabled after restore');
}

console.log('2) a legacy transcript (no plan_generated marker) still populates the plan dock, with no chip to anchor');
{
  const driver = createDriver();
  currentDriver = driver;
  await send({ type: 'restoreChat' });
  driver.host.reload({
    conversationHistory: [
      { role: 'user', content: 'legacy goal', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'legacy planner reply', timestamp: '2026-01-01T00:00:01.000Z' },
    ],
    researchLog: [],
    plannerUsage: { totals: {} },
  });
  await sendAll(driver.take());
  await send({ type: 'planUpdated', plan: RELOAD_PLAN });
  await page.waitForTimeout(150);
  const text = await bodyText();
  ok(text.includes('legacy goal') && text.includes('legacy planner reply'), 'legacy transcript rendered without error');
  ok(await page.locator('.plan-revision-chip').count() === 0, 'no plan chip: nothing in the transcript to anchor one to');
  ok(await page.locator('.plan-dock .task-card').count() === 1, 'the plan dock still shows the task, from planUpdated alone');
}

console.log('3) a reload mid-turn drops the stale stream and unlocks the input');
{
  const driver = createDriver();
  currentDriver = driver;
  driver.host.receive({ type: 'planner_turn_started', turnId: 'stale-1', prompt: 'about to be interrupted' });
  driver.host.receive({ type: 'planner_text_delta', turnId: 'stale-1', segmentId: 's1', text: 'still streaming when the reload lands' });
  driver.host.flush();
  await sendAll(driver.take());
  await page.waitForTimeout(80);
  ok(await turnActive() === true, 'the stale turn shows as live while it streams');

  await send({ type: 'restoreChat' });
  driver.host.reload(RELOAD_FIXTURE);
  await sendAll(driver.take());
  await page.waitForTimeout(150);
  const text = await bodyText();
  ok(!text.includes('still streaming when the reload lands'), 'the interrupted turn\'s stale text is gone, not merged into the reload');
  ok(text.includes('add a parser'), 'the reloaded transcript is what is shown instead');
  ok(await turnActive() === false, 'the turn shows as closed: the reload stopped it, not left it open');
}

console.log('4) restoreChat clears a stuck local "stopped" flag (App\'s own stoppedRef/sessionClearedRef)');
{
  // Drive a turn to completion so /new has something to confirm over, then
  // fire it through the real UI path (no confirm dialog while idle).
  const driver = createDriver();
  currentDriver = driver;
  driver.host.receive({ type: 'planner_turn_started', turnId: 'before-new', prompt: 'turn before /new' });
  driver.host.receive({ type: 'planner_message', content: 'turn done', timestamp: '2026-01-01T00:00:00.000Z', turnId: 'before-new' });
  driver.host.receive({ type: 'planner_turn_ended', turnId: 'before-new', outcome: 'message' });
  driver.host.flush();
  await sendAll(driver.take());
  await page.evaluate(() => window.__typeUser('/new'));
  await page.waitForTimeout(100);

  const driver2 = createDriver();
  currentDriver = driver2;
  await send({ type: 'restoreChat' });
  driver2.host.reload(RELOAD_FIXTURE);
  await sendAll(driver2.take());
  await send({ type: 'planUpdated', plan: RELOAD_PLAN });
  await page.waitForTimeout(200);
  const text = await bodyText();
  ok(text.includes('add a parser'), 'timeline restored after /new\'s local stop-gate');
  ok(await page.locator('.plan-revision-chip').count() === 1, 'plan marker renders after restore (stop-gate cleared)');
}

console.log('5) a reload rebuilds every run of activity collapsed, whatever was open before it (ADR-0017 X1)');
{
  const driver = createDriver();
  currentDriver = driver;
  const args = '{"path":"src/old.ts"}';
  driver.host.receive({ type: 'planner_turn_started', turnId: 'open-1', prompt: 'read the old file' });
  driver.host.receive({ type: 'research_step', tool: 'read_file', args, toolCallId: 'c-old', turnId: 'open-1' });
  driver.host.flush();
  await sendAll(driver.take());
  await page.waitForTimeout(60);
  const group = page.locator('.activity-group-toggle').last();
  ok(await group.innerText() === 'Reading a file', 'a live run says what it is still doing');
  await group.click();
  await page.locator('.cmd-row-toggle').last().click();
  driver.host.receive({
    type: 'research_step_done', turnId: 'open-1',
    step: { id: 'rs-old', tool: 'read_file', args, result: 'old body', timestamp: '2026-01-01T00:00:00.000Z', success: true, outcome: 'success', toolCallId: 'c-old' },
  });
  driver.host.flush();
  await sendAll(driver.take());
  await page.waitForTimeout(60);
  ok(await group.innerText() === 'Read a file', 'the run recounts as its call settles');
  ok(await page.locator('.cmd-row.expanded .cmd-row-output').innerText() === 'old body', 'the row opened while pending stays open as it settles');

  await send({ type: 'restoreChat' });
  driver.host.reload(RELOAD_FIXTURE);
  await sendAll(driver.take());
  await page.waitForTimeout(150);
  const expanded = await page.locator('.activity-group-toggle').evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')));
  ok(expanded.length === 2 && expanded.every((v) => v === 'false'), `the reloaded runs are all collapsed (${expanded.join(',')})`);
  ok(await page.locator('.cmd-row, .subagent-card').count() === 0, 'nothing of a collapsed run is drawn');
  const summaries = await page.locator('.activity-group-toggle').allInnerTexts();
  ok(JSON.stringify(summaries) === JSON.stringify(['Delegated to an agent', 'Read a file']), `each saved run says what it did (${summaries.join(' | ')})`);
}

console.log('6) watchdog re-enables input after silence (fake clock)');
{
  const driver = createDriver();
  currentDriver = driver;
  driver.host.receive({ type: 'planner_turn_started', turnId: 'stall-1', prompt: 'about to stall' });
  driver.host.flush();
  await sendAll(driver.take());
  await page.waitForTimeout(100);
  ok(await turnActive() === true, 'the stalled turn shows as live');

  // Shift Date.now() 130s forward; the watchdog's 5s interval then sees >120s of silence.
  await page.evaluate(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 130_000;
  });
  await page.waitForTimeout(6_000);
  ok(await turnActive() === false, 'watchdog unlocked the turn');
  const text = await bodyText();
  ok(text.includes('stopped responding'), 'watchdog posted a visible notice');
}

await page.screenshot({ path: path.join('bench/live/screenshots', 'stage1-restore.png') });
await browser.close();
console.log(failures === 0 ? '\nall stage-1 assertions passed' : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
