#!/usr/bin/env node
/**
 * Drive the webview harness with a real `ConversationViewHost` (ADR-0017) and
 * capture screenshots of every state packages/vscode/src/views/chat draws,
 * asserting the DOM at each one:
 *
 *   - a reply streams in place as message text, settles, then loses its cursor
 *   - thinking and a command row stay collapsed by default while streaming
 *   - a command row's preview is exactly 3 lines, with a "+N lines" hint
 *   - "building plan" becomes a plan marker chip once the plan commits
 *   - a subagent card is collapsed by default; the header's one expand-all
 *     toggle opens it (and every other block) at once — there is no
 *     per-block control
 *   - the approval card shows Allow/Deny while pending, then settles
 *   - the token line is pinned below the conversation, not inside it
 *   - a retracted attempt's text never reaches the screen
 *   - a prompt typed while a turn is live is held, with its own × unsend;
 *     Esc takes it back, and Esc Esc (nothing queued) arms then stops the turn
 *   - held prompts stack above the composer, each with Send now; with a draft
 *     typed mid-turn the composer has one button and a key hint
 *   - the task log (/tasklog) stacks its pending messages the same way, one in
 *     each state, Send now on all but the forced one, × only on the queued one
 *   - a plan's task cards carry their own fill, distinct from the plan behind
 *     them, with the expanded card and its subtasks each a step apart
 *
 * Runs at 420px (the sidebar width) and 900px, under both a dark and a light
 * VS Code theme (bench/live/webview-harness.mjs's `?theme=`) — the full state
 * tour at 420/dark, a representative subset at the other three combinations.
 *
 * Usage:
 *   node bench/live/webview-harness.mjs &
 *   node bench/live/webview-screenshot.mjs [--out DIR]
 */
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from './load-playwright.mjs';
import { createDriver } from './host-driver.mjs';
import { MAIN_SCENARIO, RELOAD_FIXTURE, RELOAD_PLAN, TASK_CARDS_PLAN, TASK_LOG_PENDING } from './scenarios.mjs';
import { replayTaskLog } from '../../packages/core/dist/plan-utils.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', 'bench/live/screenshots');
const BASE = arg('url', 'http://127.0.0.1:3798');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures.push(msg);
};

const executablePath = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function send(page, msg) {
  await page.evaluate((m) => window.__send(m), msg);
}
async function sendAll(page, msgs) {
  if (msgs.length) await page.evaluate((arr) => arr.forEach((m) => window.__send(m)), msgs);
}

/**
 * Walk up from `selector` to the nearest element with a real background, and
 * blend a translucent foreground over it — this codebase's muted text
 * (`--text-muted`, `color-mix(in srgb, ... transparent)`) is exactly the kind
 * of low-contrast choice worth checking, and Chrome serializes it as
 * `color(srgb r g b / a)` rather than `rgb()`, so both need parsing.
 */
async function contrastRatio(page, selector) {
  return page.evaluate((sel) => {
    const toRgba = (s) => {
      const rgb = s.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = 1] = rgb[1].split(',').map((n) => parseFloat(n));
        return [r, g, b, a];
      }
      const fn = s.match(/color\(srgb\s+([^)]+)\)/);
      if (fn) {
        const parts = fn[1].split('/');
        const [r, g, b] = parts[0].trim().split(/\s+/).map((n) => parseFloat(n) * 255);
        const a = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
        return [r, g, b, a];
      }
      return null;
    };
    const blend = ([r, g, b, a], [br, bg, bb]) => [
      r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a),
    ];
    const luminance = ([r, g, b]) => {
      const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const el = document.querySelector(sel);
    if (!el) return null;
    const fg = toRgba(getComputedStyle(el).color);
    // Badges and tints are translucent, so composite every background up to
    // the first opaque one rather than reading the nearest as if it were solid.
    const layers = [];
    let node = el;
    while (node && !(layers.length && layers[layers.length - 1][3] >= 1)) {
      const rgba = toRgba(getComputedStyle(node).backgroundColor);
      if (rgba && rgba[3] > 0) layers.push(rgba);
      node = node.parentElement;
    }
    if (!fg || !layers.length || fg[3] === 0) return null;
    const bg = layers.reverse().reduce((under, layer) => blend(layer, under), [255, 255, 255]);
    const blended = fg[3] < 1 ? blend(fg, bg) : fg;
    const [l1, l2] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
  }, selector);
}

async function assertMark(page, mark) {
  switch (mark) {
    case 'empty':
      check(await page.locator('.empty-state').count() === 1, 'empty: no-conversation state shown before anything streams');
      break;
    case 'reply-streaming':
      check(await page.locator('.chat-msg-user').count() === 1, 'reply-streaming: the user bubble rendered first');
      check((await page.locator('.chat-msg-planner.streaming .chat-msg-content').innerText()).includes('Which'), 'reply-streaming: reply text streams in place as message text');
      check(await page.locator('.chat-msg-planner.streaming .chat-msg-cursor').count() === 1, 'reply-streaming: the streaming cursor is shown');
      check(await page.locator('.send-btn.processing').count() === 1, 'reply-streaming: the stop control lives in the chat input');
      break;
    case 'reply-settled': {
      const text = await page.locator('.chat-msg-planner').last().innerText();
      check(text.includes('Which store: SQLite or Postgres?'), 'reply-settled: the settled message replaces the streamed text');
      check(await page.locator('.chat-msg-planner.streaming').count() === 0, 'reply-settled: no bubble is still marked streaming');
      check(await page.locator('.send-btn.processing').count() === 0, 'reply-settled: input back to send state');
      break;
    }
    case 'thinking-collapsed':
      check(await page.locator('.activity-think').count() === 1, 'thinking-collapsed: a thinking block renders');
      check(await page.locator('.activity-think.expanded').count() === 0, 'thinking-collapsed: collapsed by default');
      break;
    case 'command-row': {
      const preview = await page.locator('.cmd-row-preview').innerText();
      check(preview.split('\n').length === 3, `command-row: preview is exactly 3 lines (got ${preview.split('\n').length})`);
      check((await page.locator('.cmd-row-more').innerText()).includes('+3 line'), 'command-row: hidden-line count shown');
      check(await page.locator('.cmd-row.expanded').count() === 0, 'command-row: collapsed by default');
      break;
    }
    case 'building-plan':
      check((await page.locator('.plan-revision-chip').innerText()) === 'Building plan…', 'building-plan: chip reads "Building plan…"');
      check(await page.locator('.plan-revision-chip').isDisabled(), 'building-plan: chip is not clickable while building');
      break;
    case 'plan-marker':
      check((await page.locator('.plan-revision-chip').innerText()).includes('Plan generated'), 'plan-marker: chip settles to "Plan generated"');
      check((await page.locator('.plan-revision-chip').innerText()).includes('2 tasks'), 'plan-marker: task count shown');
      check(await page.locator('.plan-dock .task-card').count() === 2, 'plan-marker: the plan dock shows both task cards');
      break;
    case 'subagent-collapsed':
      check(await page.locator('.subagent-card').count() === 2, 'subagent-collapsed: both subagents rendered');
      check(await page.locator('.subagent-card.expanded').count() === 0, 'subagent-collapsed: collapsed by default');
      check((await page.locator('.subagent-card-status').first().innerText()).length > 0, 'subagent-collapsed: status label shown collapsed');
      break;
    case 'approval-pending':
      check(await page.locator('.approval-card.pending .approval-card-allow').count() === 1, 'approval-pending: Allow button shown');
      check(await page.locator('.approval-card.pending .approval-card-deny').count() === 1, 'approval-pending: Deny button shown');
      break;
    case 'approval-settled':
      check(await page.locator('.approval-card.granted').count() === 1, 'approval-settled: card settles to granted');
      check(await page.locator('.approval-card.pending').count() === 0, 'approval-settled: no pending card left for this request');
      check(await page.locator('.approval-card.granted .approval-card-allow').count() === 0, 'approval-settled: settled card has no action buttons');
      break;
    case 'usage-line': {
      const usage = await page.locator('.usage-line').innerText();
      check(usage.includes('ctx 1.6k (<1%)'), 'usage-line: context meter shown');
      check(usage.includes('$0.01'), 'usage-line: reported cost shown');
      check(!/\bin\b|\bout\b|cached/.test(usage), 'usage-line: no token counts drawn');
      check(usage.includes('subagent'), 'usage-line: subagent count shown');
      check(await page.locator('.message-list .usage-line').count() === 0, 'usage-line: pinned outside the scrolling message list');
      break;
    }
    case 'retracted-attempt': {
      const text = await page.locator('.message-list').innerText();
      check(!text.includes('taskOps'), 'retracted-attempt: the retracted JSON attempt never reached the screen');
      check(!text.includes('Split it'), 'retracted-attempt: the retracted prose attempt never reached the screen');
      check(text.includes('Task 3 splits cleanly into 3a and 3b.'), 'retracted-attempt: the settled reply is shown');
      break;
    }
    case 'turn-open':
      check(await page.locator('.send-btn.processing').count() === 1, 'turn-open: input shows the turn is live');
      break;
  }
}

async function expandAllRoundTrip(page) {
  check(await page.locator('.detail-toggle').count() === 1, 'header: one expand-all control, no per-block controls');
  await page.locator('.detail-toggle').click();
  check(await page.locator('.activity-think.expanded').count() >= 1, 'expand-all: thinking opens');
  check(await page.locator('.cmd-row.expanded').count() >= 1, 'expand-all: command rows open');
  check(await page.locator('.subagent-card.expanded').count() === 2, 'expand-all: every subagent opens together, not one at a time');
  await page.screenshot({ path: path.join(OUT, 'expand-all.png') });
  await page.locator('.detail-toggle').click();
  check(await page.locator('.activity-think.expanded').count() === 0, 'expand-all: collapses back as one toggle');
}

const PENDING_CONTRAST = ['.pending-message-text', '.pending-message-state', '.send-key-hint'];

async function checkContrast(page, label, selectors) {
  for (const sel of selectors) {
    const ratio = await contrastRatio(page, sel);
    if (ratio === null) continue;
    check(ratio >= 4.5, `contrast ${label} ${sel}: ${ratio.toFixed(2)}:1 (WCAG AA text needs 4.5:1)`);
  }
}

/**
 * Held prompts above the composer with a draft typed mid-turn, the first
 * hovered so its actions show. Posted straight to the page and cleared after,
 * so the host-driven tour that follows sees no difference.
 */
async function pendingPlanner(page, label, file) {
  await send(page, { type: 'heldPrompts', prompts: ['also cover caching', 'and keep the public routes stable: no breaking changes to the API'] });
  await page.fill('.chat-input-row textarea', 'use Postgres, not SQLite');
  await page.hover('.pending-message >> nth=0');
  await page.waitForTimeout(200); // the actions fade in
  check(await page.locator('.pending-messages .pending-message').count() === 2, `pending-planner ${label}: both held prompts stacked`);
  check(await page.locator('.message-list .pending-messages').count() === 0, `pending-planner ${label}: the stack sits outside the conversation`);
  check(await page.evaluate(() => document.querySelector('.pending-messages')?.nextElementSibling?.classList.contains('chat-input')), `pending-planner ${label}: directly above the composer`);
  check(await page.locator('.pending-message-now').count() === 2, `pending-planner ${label}: Send now on each`);
  check(await page.locator('.pending-message-remove').count() === 1, `pending-planner ${label}: only the newest carries the ×`);
  check(await page.locator('.chat-input-row button').count() === 1, `pending-planner ${label}: one button in the composer`);
  check((await page.locator('.send-key-hint').innerText()).includes('send now'), `pending-planner ${label}: the key hint names send now`);
  await checkContrast(page, `pending-planner ${label}`, PENDING_CONTRAST);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.mouse.move(0, 0);
  await page.fill('.chat-input-row textarea', '');
  await send(page, { type: 'heldPrompts', prompts: [] });
}

async function pendingTaskLog(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 640 } });
  await page.goto(`${BASE}/tasklog?theme=${theme}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  const view = replayTaskLog(TASK_LOG_PENDING);
  await send(page, {
    type: 'init',
    blocks: view.blocks,
    status: {
      taskId: 't2', order: 2, title: 'Add a JSON parser', runner: 'claude-code', planStatus: 'in_progress',
      awaitingApproval: 0, working: true, queued: view.queued, attempts: [1], attempt: 1, continuable: false,
    },
  });
  await page.fill('.task-log-input', 'and log every parse error');
  await page.hover('.pending-message >> nth=1');
  await page.waitForTimeout(200);
  const states = await page.locator('.pending-message-state').allInnerTexts();
  check(JSON.stringify(states) === JSON.stringify(['sending now…', 'waiting for the current step', 'queued']), `tasklog ${label}: each pending message says where it stands (${states.join(' | ')})`);
  check(await page.locator('.pending-message-now').count() === 2, `tasklog ${label}: Send now on the handed-over and queued ones, not the forced one`);
  check(await page.locator('.pending-message-remove').count() === 1, `tasklog ${label}: × only on the one still queued`);
  check(await page.getByText(/^Queued \(/).count() === 0, `tasklog ${label}: no Queued (n) heading`);
  check(await page.locator('.task-log-composer button').count() === 1, `tasklog ${label}: one button in the composer`);
  check((await page.locator('.send-key-hint').innerText()).includes('send now'), `tasklog ${label}: the key hint names send now`);
  await checkContrast(page, `tasklog ${label}`, PENDING_CONTRAST);
  await page.screenshot({ path: path.join(OUT, `tasklog-pending-${width}-${theme}.png`) });
  await page.close();
}

const CARD_CONTRAST = [
  '.task-card.expanded .task-description', '.task-card.expanded .task-order', '.task-card.expanded .task-type-badge',
  '.task-card.expanded .task-status-badge', '.subtask-card .task-status-badge', '.subtask-title-text',
  '.task-card:not(.expanded) .task-status-badge.status-pending', '.task-card:not(.expanded) .task-status-badge.status-completed',
  '.task-card:not(.expanded) .task-status-badge.status-failed', '.task-message-box .send-key-hint',
  '.task-card.expanded .task-deps', '.task-card.expanded .task-log-open-btn', '.task-card.expanded .task-dep-badge.dep-in',
  '.task-card.expanded .task-dep-badge.dep-out', '.subtask-prompt', '.subtask-order', '.task-card.user .task-type-badge',
];

/** The fill an element actually shows, translucent layers composited as in contrastRatio. */
function fillOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  }, selector);
}

async function taskCards(width, theme) {
  const label = `${width}/${theme}`;
  const page = await browser.newPage({ viewport: { width, height: 1300 } });
  await page.goto(`${BASE}/?theme=${theme}`);
  await page.waitForSelector('.chat-container');
  await sendAll(page, MAIN_SCENARIO.filter((s) => s.post?.type?.startsWith('set')).map((s) => s.post));
  await send(page, { type: 'planUpdated', plan: TASK_CARDS_PLAN });
  await page.locator('.setup-panel-toggle-label').click(); // the plan, not the settings, is the subject here
  // As if dragged all the way up: the empty conversation above has nothing to show.
  await page.evaluate(() => { const body = document.querySelector('.plan-dock-body'); if (body) body.style.maxHeight = 'none'; });
  await page.locator('.plan-dock .task-card-header').first().click();
  await page.locator('.subtask-card-header').first().click();
  await page.hover('.plan-dock .task-card >> nth=2');
  await page.evaluate(() => document.querySelector('.plan-dock-body')?.scrollTo(0, 0));
  await page.waitForTimeout(250); // the card transitions settle
  check(await page.locator('.plan-dock .task-card').count() === 4, `task-cards ${label}: all four cards shown`);
  check(await page.locator('.task-card.expanded .subtask-card').count() === 2, `task-cards ${label}: the expanded card shows its subtasks`);
  const [dock, rest, hover, expanded, subtask] = await Promise.all([
    fillOf(page, '.plan-dock-body'), fillOf(page, '.task-card:not(.expanded):not(:hover)'),
    fillOf(page, '.task-card:hover'), fillOf(page, '.task-card.expanded'), fillOf(page, '.subtask-card'),
  ]);
  console.log(`    fills: dock ${dock} · card ${rest} · hover ${hover} · expanded ${expanded} · subtask ${subtask}`);
  check(rest !== dock, `task-cards ${label}: a resting card is filled apart from the plan behind it`);
  check(expanded !== rest && hover !== rest, `task-cards ${label}: hover and expanded are a step beyond the resting card`);
  check(subtask !== expanded, `task-cards ${label}: a subtask separates from its expanded parent`);
  await checkContrast(page, `task-cards ${label}`, CARD_CONTRAST);
  await page.screenshot({ path: path.join(OUT, `task-cards-${width}-${theme}.png`) });
  await page.close();
}

async function queuedPromptAndEscape(page) {
  // Someone typing a follow-up while a turn streams is watching it, i.e. at
  // the bottom already — App's own scroll-pin only follows new content while
  // `userPinnedToBottomRef` is true, which a scripted mid-conversation jump
  // (rather than a real user's scroll) may otherwise leave unset.
  await page.evaluate(() => document.querySelector('.message-list')?.scrollTo(0, 1e6));
  await page.waitForTimeout(60); // let the scroll listener record the pin before typing races it
  await page.evaluate(() => window.__typeUser('add caching too'));
  // The scroll-into-view on a newly queued prompt is `behavior: 'smooth'`;
  // a short wait here would screenshot mid-animation with the bubble still
  // clipped below the fold.
  await page.waitForTimeout(500);
  check(await page.locator('.pending-message').count() === 1, 'queued-prompt: held while the turn is live');
  check((await page.locator('.pending-message-text').innerText()) === 'add caching too', 'queued-prompt: shows the held text');
  check(await page.locator('.pending-message-remove').count() === 1, 'queued-prompt: the newest carries the × unsend');
  await page.screenshot({ path: path.join(OUT, 'queued-prompt.png') });

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  check(await page.locator('.pending-message').count() === 0, 'esc-unsend: Esc takes back the queued prompt');
  check(await page.locator('.chat-input-row textarea').inputValue() === 'add caching too', 'esc-unsend: the text lands back in the input');

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  check(await page.locator('.stop-hint').count() === 1, 'esc-arm: first Esc (nothing queued) arms the stop hint');
  await page.screenshot({ path: path.join(OUT, 'esc-armed.png') });

  await page.evaluate(() => window.__pressEscape());
  await page.waitForTimeout(60);
  const posted = await page.evaluate(() => window.__posted.some((m) => m.type === 'stopResearch'));
  check(posted, 'esc-esc: second Esc sends stopResearch');
  check(await page.locator('.send-btn.processing').count() === 0, 'esc-esc: the turn stops on screen');
  check(await page.locator('.stop-hint').count() === 0, 'esc-esc: the stop hint clears once stopped');
}

async function reloadScenario(page) {
  const driver = createDriver();
  await page.evaluate(() => window.__posted.length = 0);
  await send(page, { type: 'restoreChat' });
  driver.host.reload(RELOAD_FIXTURE);
  await sendAll(page, driver.take());
  await send(page, { type: 'planUpdated', plan: RELOAD_PLAN });
  await page.waitForTimeout(60);

  const text = await page.locator('.message-list').innerText();
  check(text.includes('add a parser'), 'reload: the user goal is restored');
  check(text.includes('Which formats do you need?'), 'reload: the planner reply before the plan is restored');
  check(text.includes('Anything else you want tweaked?'), 'reload: the planner reply after the plan is restored');
  check(await page.locator('.plan-revision-chip').count() === 1, 'reload: the plan marker is restored');
  check(await page.locator('.cmd-row').count() === 1, 'reload: a tool row survives reload (R1)');
  check(await page.locator('.subagent-card').count() === 1, 'reload: a subagent (with its digest) survives reload (R1)');
  check(await page.locator('.subagent-card-digest').innerText() === 'No parser exists yet.', 'reload: the subagent digest is shown even collapsed');
  check(await page.locator('.activity-think').count() === 0, 'reload: thinking is deliberately NOT reconstructed (R1)');
  check(await page.locator('.usage-line').count() === 1, 'reload: the token line survives reload (R1)');
  check(await page.locator('.plan-dock .task-card').count() === 1, 'reload: the plan dock repopulates from the reload');

  // Anchor position: the plan marker sits before the trailing planner message.
  const order = await page.evaluate(() => [...document.querySelectorAll('.message-list .conversation > *')]
    .map((el) => (el.classList.contains('plan-revision-chip-row') ? 'plan' : el.className.includes('chat-msg-planner') ? 'planner' : el.className)));
  const planIdx = order.indexOf('plan');
  check(planIdx > 0 && planIdx < order.length - 1, `reload: plan marker anchored before the trailing message (order: ${order.join(',')})`);

  await page.screenshot({ path: path.join(OUT, 'reload-from-transcript.png') });
}

const COMBOS = [
  { width: 420, theme: 'dark', primary: true },
  { width: 900, theme: 'dark' },
  { width: 420, theme: 'light' },
  { width: 900, theme: 'light' },
];
const REPRESENTATIVE = new Set(['plan-marker', 'approval-pending', 'usage-line', 'subagent-collapsed']);
const CONTRAST_SELECTORS = ['.chat-msg-content', '.cmd-row-head', '.usage-line-measures', '.approval-card-subject', '.plan-revision-chip'];

for (const combo of COMBOS) {
  console.log(`\n== ${combo.width}px, ${combo.theme} theme ${combo.primary ? '(primary)' : ''} ==`);
  const page = await browser.newPage({ viewport: { width: combo.width, height: 1400 } });
  const driver = createDriver();
  await page.goto(`${BASE}/?theme=${combo.theme}`);
  await page.exposeFunction('__toHost', async (msg) => {
    if (!driver.reply(msg)) return;
    driver.host.flush();
    await sendAll(page, driver.take());
  });
  await page.waitForSelector('.chat-container');

  const suffix = combo.primary ? '' : `-${combo.width}-${combo.theme}`;

  for (const s of MAIN_SCENARIO) {
    if (s.post) {
      await send(page, s.post);
    } else if (s.drive) {
      s.drive(driver.host);
      driver.host.flush();
      await sendAll(page, driver.take());
    } else if (s.mark) {
      const shouldShoot = combo.primary || REPRESENTATIVE.has(s.mark);
      if (shouldShoot) {
        await page.waitForTimeout(30);
        await page.screenshot({ path: path.join(OUT, `${s.mark}${suffix}.png`) });
      }
      if (combo.primary) await assertMark(page, s.mark);
      if (s.mark === 'subagent-collapsed' && combo.primary) await expandAllRoundTrip(page);
      if (s.mark === 'turn-open') {
        await pendingPlanner(page, `${combo.width}/${combo.theme}`, `pending-planner-${combo.width}-${combo.theme}.png`);
        if (combo.primary) await queuedPromptAndEscape(page);
      }
    }
  }

  if (combo.primary) await reloadScenario(page);

  for (const sel of CONTRAST_SELECTORS) {
    const ratio = await contrastRatio(page, sel);
    if (ratio === null) continue; // not present in every combo (e.g. after Esc closed the turn)
    check(ratio >= 4.5, `contrast ${combo.width}/${combo.theme} ${sel}: ${ratio.toFixed(2)}:1 (WCAG AA text needs 4.5:1)`);
  }

  await page.close();
}

for (const combo of COMBOS) {
  console.log(`\n== task log, ${combo.width}px, ${combo.theme} theme ==`);
  await pendingTaskLog(combo.width, combo.theme);
}

for (const combo of COMBOS) {
  console.log(`\n== task cards, ${combo.width}px, ${combo.theme} theme ==`);
  await taskCards(combo.width, combo.theme);
}

await browser.close();
console.log(`\nscreenshots: ${OUT}/`);
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log('all visual assertions passed');
