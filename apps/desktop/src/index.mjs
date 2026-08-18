#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { PortalBrowser } from './browser.mjs';
import { explore } from './explorer.mjs';
import { startRecording } from './recorder.mjs';
import { link, pushSnapshot, readConfig } from './sync.mjs';

const API_BASE = process.env['CONTEXTO_API'] ?? 'https://contextoagent.ai';
const WEB_BASE = process.env['CONTEXTO_WEB'] ?? 'https://contextoagent.ai';

/**
 * `record` writes down which JSON endpoints a portal talks to while a student
 * clicks around it.
 *
 * This is a build-time tool; no student ever runs it. Its output is how a
 * portal adapter gets written without guessing -- run it once against a live
 * Veracross or Mozaik account and the adapter follows from traffic actually
 * observed, rather than from what a vendor's docs claim exists.
 *
 * It runs in two phases on purpose. See the header of browser.mjs: the student
 * authenticates in a browser carrying no debugging transport, so there is no
 * automation signal on the page where Google looks for one. Only afterwards do
 * we reopen the same profile and start reading.
 */
async function ask(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function record([portalId, startUrl, ...flags]) {
  if (!portalId || !startUrl) {
    console.error('Usage: record <portal-id> <start-url> [--raw] [--out <file>]');
    process.exit(1);
  }
  const raw = flags.includes('--raw');
  const outIndex = flags.indexOf('--out');
  const out = outIndex === -1 ? `${portalId}-endpoints.json` : flags[outIndex + 1];

  // ---- Phase 1: the student logs in, unobserved ----
  const login = new PortalBrowser({ portalId, mode: 'login', startUrl });
  await login.launch();
  console.log(`\nProfile: ${login.profileDir}`);
  console.log('\n  A browser window is open at the portal.');
  console.log('  Log in normally — SSO, two-factor, whatever it asks for.');
  await ask('\n  Press Enter once you are logged in. ');
  await login.close();
  console.log('  Login saved.');

  // ---- Phase 2: reopen the authenticated profile and watch it work ----
  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: true });
  await browser.launch();
  const { sessionId } = await browser.openPage(startUrl);
  const recorder = startRecording(browser, sessionId, { raw });
  await recorder.enable();
  await browser.navigate(startUrl, sessionId);

  console.log(`\n  Recording (${browser.product}).`);
  console.log('  Click through the pages you want the agent to read:');
  console.log('  assignments, grades, calendar, announcements.');
  if (raw) console.log('\n  WARNING  --raw writes real response values to disk, not just shapes.');
  await ask('\n  Press Enter when you are done. ');

  const report = recorder.stop();
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\nRecorded ${report.endpoints.length} JSON endpoint(s) -> ${out}`);
  for (const endpoint of report.endpoints.slice(0, 30)) {
    console.log(`  ${String(endpoint.hits).padStart(3)}x  ${endpoint.status}  ${endpoint.method} ${endpoint.url}`);
    if (endpoint.queryParams.length) console.log(`         params: ${endpoint.queryParams.join(', ')}`);
  }

  // Closing gracefully is what persists the session. Killing the process would
  // throw away the login the student just completed.
  await browser.close();
  console.log('\nSession saved — the next run reuses this login.');
}

/**
 * `explore` is the same job without a human driving. The agent walks the portal
 * itself and produces the map; nobody has to click through it first.
 */
async function exploreCommand([portalId, startUrl, ...flags]) {
  if (!portalId || !startUrl) {
    console.error('Usage: explore <portal-id> <start-url> [--budget N] [--raw] [--out <file>]');
    process.exit(1);
  }
  const raw = flags.includes('--raw');
  const budgetIndex = flags.indexOf('--budget');
  const budget = budgetIndex === -1 ? 40 : Number(flags[budgetIndex + 1]);
  const outIndex = flags.indexOf('--out');
  const out = outIndex === -1 ? `${portalId}-map.json` : flags[outIndex + 1];
  const origin = new URL(startUrl).origin;

  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  await browser.launch();
  const { sessionId } = await browser.openPage('about:blank');

  console.log(`Exploring ${origin} (budget ${budget} pages)\n`);
  const map = await explore(browser, sessionId, {
    origin, seed: startUrl, budget, raw,
    onPage: (page) =>
      console.log(`  ${page.url}\n    ${page.title} — ${page.components.length} component(s)`),
  });
  await browser.close();

  writeFileSync(out, JSON.stringify(map, null, 2));
  const components = map.pages.flatMap((p) => p.components);
  const withData = components.filter((c) => c.empty === false);
  console.log(`\nVisited ${map.pagesVisited} page(s), found ${components.length} component(s).`);
  console.log(`${withData.length} returned data; ${components.length - withData.length} were empty.`);
  if (!map.complete) console.log(`Stopped at the budget — ${map.pagesRemaining} page(s) unvisited.`);
  console.log(`Map -> ${out}`);

  if (components.length > 0 && withData.length === 0) {
    console.log('\nEvery component came back empty. Out of term, or not logged in —');
    console.log('run `record` first to establish the session.');
  }
}

/** Link this machine to the student's ContextoAgent account. */
async function linkCommand() {
  const existing = readConfig();
  if (existing.token) {
    console.log(`Already linked as "${existing.deviceName}". Re-linking replaces it.`);
  }
  const device = await link({ apiBase: API_BASE, webBase: WEB_BASE });
  console.log(`\nLinked as "${device.deviceName}".`);
}

/** Explore a portal and push the map to the server in one go. */
async function syncCommand([portalId, startUrl, ...flags]) {
  if (!portalId || !startUrl) {
    console.error('Usage: sync <portal-id> <start-url> [--budget N] [--shapes-only]');
    process.exit(1);
  }
  const config = readConfig();
  if (!config.token) {
    console.error('This machine is not linked yet. Run `link` first.');
    process.exit(1);
  }
  /*
   * Note the inverted default. `record` and `explore` are development tools --
   * their output is a spec someone reads, so shapes are enough and values are
   * a liability. `sync` feeds the student's own agent, which cannot answer
   * "what is due Friday" from `string<date>`. Values are the point here, and
   * the student consented to exactly this when they linked the machine.
   */
  const shapesOnly = flags.includes('--shapes-only');
  const budgetIndex = flags.indexOf('--budget');
  const budget = budgetIndex === -1 ? 40 : Number(flags[budgetIndex + 1]);
  const origin = new URL(startUrl).origin;

  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  await browser.launch();
  const { sessionId } = await browser.openPage('about:blank');
  const map = await explore(browser, sessionId, { origin, seed: startUrl, budget, raw: !shapesOnly });
  await browser.close();

  const { snapshotId } = await pushSnapshot(
    { apiBase: config.apiBase ?? API_BASE, token: config.token },
    { portalId, origin, map, redacted: map.redacted },
  );
  const components = map.pages.flatMap((p) => p.components);
  console.log(`Synced ${map.pagesVisited} page(s), ${components.length} component(s) -> snapshot ${snapshotId}`);
  if (!map.complete) console.log(`Stopped at the budget — ${map.pagesRemaining} page(s) unvisited.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'record') await record(rest);
else if (command === 'explore') await exploreCommand(rest);
else if (command === 'link') await linkCommand();
else if (command === 'sync') await syncCommand(rest);
else {
  console.error('Usage: contexto-desktop <link|record|explore|sync> [args]');
  process.exit(1);
}
