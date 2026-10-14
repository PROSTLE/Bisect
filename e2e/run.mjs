// End-to-end verification for bisect.
//
//   npm run build --prefix web     (the API serves the built UI)
//   npm run e2e                     (from the repo root)
//
// Starts its own API on an EMPTY throwaway in-memory database, creates the owner account through the
// first-run setup screen, builds an incident scenario through the public API (scenario.mjs), then
// drives Chrome through every control. After each UI action it checks the *API* to confirm the
// action really happened. Set CHROME_PATH if Chrome/Edge is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PASSWORD, buildScenario } from './scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 4555);
const BASE = `http://localhost:${PORT}`;
const ART = path.join(here, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found — set CHROME_PATH');
  return found;
}

// ---- server ---------------------------------------------------------------------------------
const serverDir = path.resolve(here, '../server');
if (!fs.existsSync(path.resolve(here, '../web/dist/index.html'))) {
  console.error('web/dist is missing — run `npm run build --prefix web` first');
  process.exit(2);
}
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: serverDir,
  env: { ...process.env, DATABASE_URL: 'memory', PORT: String(PORT), NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stopServer = () => server.kill();
process.on('exit', stopServer);

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {}
  if (i > 120) {
    console.error('server did not start:\n' + serverLog);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 500));
}

// ---- helpers --------------------------------------------------------------------------------
async function api(token, p, opts = {}) {
  const res = await fetch(`${BASE}/api${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (email, password = PASSWORD) => (await api(null, '/auth/login', { method: 'POST', body: { email, password } })).body.token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, msg, timeout = 8000) {
  const t = Date.now();
  let last;
  while (Date.now() - t < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`${msg} (timed out; last: ${JSON.stringify(last)?.slice(0, 200)})`);
}
const xp = (text, tag = '*') => `xpath/.//${tag}[contains(normalize-space(.), ${JSON.stringify(text)})]`;
async function click(page, text, tag = 'button', within = null) {
  const root = within ? await page.$(within) : page;
  const el = await until(async () => (await root.$$(xp(text, tag)))[0], `"${text}" ${tag} not found`);
  await el.click();
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, text, timeout) => until(async () => (await bodyText(page)).includes(text), `text "${text}" never appeared`, timeout);

const results = [];
let current;
async function step(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ ok: false, name, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message}`);
    const file = path.join(ART, `fail-${results.length}.png`);
    await current?.screenshot({ path: file, fullPage: true }).catch(() => {});
  }
}

// ---- state filled in once the scenario exists -------------------------------------------------
const OWNER = { name: 'Olivia Owner', email: 'owner@bisect.test', password: 'owner-password-123' };
const tokens = {};
let projects, pid, focus, overview, INC, scenario;
const rank = (s) => (s.link?.relation === 'confirmed' ? 2 : s.link?.relation === 'ruled_out' ? -1 : 0);
const ranked = async () => {
  const r = (await api(tokens.engineer, `/incidents/${focus.id}/suspects`)).body;
  return { ...r, all: [...r.suspects, ...r.changes].sort((a, b) => rank(b) - rank(a) || b.score - a.score) };
};
const name = (s) => (s.type === 'deployment' ? `Deploy #${s.deployment.number}` : `${s.change.kind === 'config' ? 'Config change' : 'Commit'} ${s.change.sha.slice(0, 7)}`);

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const errors = [];
async function newPage(token) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() >= 500 && errors.push(`HTTP ${r.status()} ${r.url()}`));
  if (token) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('bisect.token', t), token);
  }
  return page;
}

console.log(`\nbisect e2e — ${BASE}\n`);
const page = await newPage(null);
current = page;

// ---- first run --------------------------------------------------------------------------------
await step('empty database: the app asks for an owner account (no demo data, no demo accounts)', async () => {
  assert((await api(null, '/auth/setup')).body.needed === true, 'API says setup is not needed');
  assert((await api(null, '/users')).status === 401, 'user list should require sign-in');
  assert((await api(null, '/auth/demo')).status === 404, 'demo endpoint still exists');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form[aria-label="Create the owner account"]');
});

await step('setup form creates the owner (admin) and signs them in', async () => {
  const inputs = await page.$$('form[aria-label="Create the owner account"] input');
  await inputs[0].type(OWNER.name);
  await inputs[1].type(OWNER.email);
  await inputs[2].type(OWNER.password);
  await inputs[3].type(OWNER.password);
  await click(page, 'Create owner account');
  await waitText(page, 'No projects yet');
  tokens.owner = await login(OWNER.email, OWNER.password);
  const me = (await api(tokens.owner, '/auth/me')).body.user;
  assert(me.role === 'admin' && me.name === OWNER.name, `owner is ${me.role} ${me.name}`);
});

await step('setup is closed once an owner exists', async () => {
  assert((await api(null, '/auth/setup')).body.needed === false, 'setup still open');
  const again = await api(null, '/auth/setup', { method: 'POST', body: { name: 'Mallory', email: 'm@x.test', password: 'mallory-password' } });
  assert(again.status === 409, `second setup returned ${again.status}`);
});

await step('scenario is built through the public API (users, projects, events, metrics, edits)', async () => {
  scenario = await buildScenario(api, tokens.owner);
  tokens.admin = tokens.owner;
  tokens.engineer = scenario.people.riley.token; // engineer driving the browser
  tokens.viewer = scenario.people.val.token; // viewer
  tokens.sam = scenario.people.sam.token;
  projects = (await api(tokens.owner, '/projects')).body.projects;
  pid = scenario.project.id;
  overview = (await api(tokens.engineer, `/projects/${pid}/overview`)).body;
  focus = overview.focus;
  assert(focus?.id === scenario.focusId, 'focus incident is not the alert we raised');
  INC = `INC-${String(focus.number).padStart(3, '0')}`;
});

await step('sign-in form signs an engineer in and opens the failing project', async () => {
  await page.click('button[aria-label="Sign out"]');
  await page.waitForSelector('form[aria-label="Sign in"]');
  const inputs = await page.$$('form[aria-label="Sign in"] input');
  await inputs[0].type(scenario.people.riley.email);
  await inputs[1].type(PASSWORD);
  await click(page, 'Sign in', 'button', 'form[aria-label="Sign in"]');
  await page.waitForSelector('.hero', { timeout: 15000 });
  assert(page.url().includes(pid), `landed on ${page.url()}`);
});

await step('a wrong password is refused', async () => {
  const r = await api(null, '/auth/login', { method: 'POST', body: { email: scenario.people.riley.email, password: 'not-the-password' } });
  assert(r.status === 401, `got ${r.status}`);
});

// ---- overview hero --------------------------------------------------------------------------
await step('hero headline: error rate and top suspect come from the API', async () => {
  const r = await ranked();
  const top = r.all[0];
  const h1 = await until(async () => {
    const t = await page.$eval('.hero h1', (e) => e.textContent);
    return t.includes('broke it') ? t : null;
  }, 'verdict never rendered');
  assert(h1.includes(name(top)), `h1 "${h1}" does not name ${name(top)}`);
  assert(h1.includes(`1 in ${Math.max(2, Math.round(100 / r.signal.latest))}`), `h1 "${h1}" does not reflect error rate ${r.signal.latest}%`);
  const conf = await page.$eval('.confidence-value', (e) => e.textContent);
  assert(conf.includes(String(Math.round(top.score * 100))), `confidence ${conf} ≠ ${Math.round(top.score * 100)}`);
});

await step('hero footer: commander, rollback owner, channel, runbook from the incident', async () => {
  const foot = await page.$eval('.hero-foot', (e) => e.textContent);
  for (const v of [focus.commander_name, focus.rollback_owner_name, focus.channel]) assert(foot.includes(v), `footer lacks ${v}`);
  assert(foot.includes('data fresh'), 'no freshness indicator');
});

await step('sidebar: incident count and event sources match the API', async () => {
  const count = await page.$eval('.nav .count', (e) => Number(e.textContent));
  assert(count === overview.active.length, `badge ${count} ≠ ${overview.active.length} active`);
  const sources = (await api(tokens.engineer, `/projects/${pid}/sources`)).body.sources.map((s) => s.name);
  const txt = await page.$eval('.sources', (e) => e.textContent);
  for (const s of sources) assert(txt.includes(s), `source ${s} missing`);
});

await step('swimlane range tabs re-query /swimlanes', async () => {
  const req = page.waitForResponse((r) => r.url().includes('/swimlanes') && r.status() === 200, { timeout: 8000 });
  await click(page, '1h', 'button', '.seg');
  await req;
  const on = await page.$eval('.seg button.on', (e) => e.textContent);
  assert(on === '1h', `active tab is ${on}`);
  await click(page, '6h', 'button', '.seg');
});

// ---- suspects -------------------------------------------------------------------------------
await step('"Mark as cause" confirms the link; "Clear verdict" removes it', async () => {
  const top = (await ranked()).all[0];
  await click(page, 'Mark as cause', 'button', '.suspect');
  const targetId = top.type === 'deployment' ? top.deployment.id : top.change.id;
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.links.some((l) => l.target_id === targetId && l.relation === 'confirmed'), 'link not confirmed in API');
  await click(page, 'Clear verdict', 'button', '.suspect');
  await until(async () => !(await api(tokens.engineer, `/incidents/${focus.id}`)).body.links.some((l) => l.target_id === targetId), 'link not removed in API');
});

await step('"Not it → next" rules out the top suspect and the hero re-ranks', async () => {
  const before = (await ranked()).all;
  const top = before[0];
  await click(page, 'Not it');
  const targetId = top.type === 'deployment' ? top.deployment.id : top.change.id;
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.links.some((l) => l.target_id === targetId && l.relation === 'ruled_out'), 'not ruled out in API');
  const next = (await ranked()).all.find((s) => s.link?.relation !== 'ruled_out');
  await until(async () => (await page.$eval('.hero h1', (e) => e.textContent)).includes(name(next)), `hero did not move to ${name(next)}`);
  await api(tokens.engineer, `/incidents/${focus.id}/links/${top.type}/${targetId}`, { method: 'DELETE' }); // restore
  await until(async () => (await page.$eval('.hero h1', (e) => e.textContent)).includes(name(top)), 'hero did not return after restoring');
});

await step('"Roll back to #N" records a pending rollback deploy (idempotent)', async () => {
  const top = (await ranked()).all[0];
  assert(top.type === 'deployment' && top.rollback_target, 'top suspect has no rollback target');
  await click(page, `Roll back to #${top.rollback_target.number}`);
  await page.waitForSelector('[role="dialog"]');
  await click(page, 'Request rollback', 'button', '[role="dialog"]');
  const ext = `rollback:${top.deployment.number}->${top.rollback_target.number}:${INC}`;
  const dep = await until(async () => (await api(tokens.engineer, `/projects/${pid}/deployments?limit=50`)).body.deployments.find((d) => d.external_id === ext), 'no rollback deploy in API');
  assert(dep.status === 'pending' && dep.version === top.rollback_target.version, `rollback deploy is ${dep.status} ${dep.version}`);
  await waitText(page, `Rollback #${dep.number}`);
  const again = await api(tokens.engineer, `/incidents/${focus.id}/rollback`, { method: 'POST', body: { from_deployment_id: top.deployment.id, target_deployment_id: top.rollback_target.id } });
  assert(again.status === 200 && again.body.status === 'duplicate', `second request returned ${again.status}/${again.body?.status}`);
  assert((await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident.status === 'mitigating', 'incident not mitigating');
});

await step('"View diff" links to the commit URL recorded for the top suspect', async () => {
  const top = (await ranked()).all[0];
  const head = top.commits.find((c) => c.sha === top.deployment.commit_sha) ?? top.commits[0];
  const href = await page.$eval('.suspect a.btn', (a) => a.getAttribute('href'));
  assert(href === head.url, `href ${href} ≠ ${head.url}`);
});

await step('"Open case" opens the focus incident', async () => {
  await click(page, 'Open case');
  await until(async () => page.url().endsWith(`/incidents/${focus.id}`), `at ${page.url()}`);
  await page.goto(`${BASE}/projects/${pid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hero');
});

// ---- activity feed --------------------------------------------------------------------------
await step('composer posts an update that shows in the feed and the API', async () => {
  const text = `e2e update ${Date.now()}`;
  await page.type('textarea[aria-label="Update"]', text);
  await click(page, 'Post update');
  await waitText(page, text);
  assert((await api(tokens.engineer, `/incidents/${focus.id}`)).body.updates.some((u) => u.body === text), 'comment missing in API');
});

await step('"+ link commit" links a commit as a suspect', async () => {
  const before = (await api(tokens.engineer, `/incidents/${focus.id}`)).body.links.filter((l) => l.target_type === 'change').length;
  await click(page, '+ link commit');
  const btn = await until(async () => (await page.$$('.popover button'))[0], 'commit picker empty');
  await btn.click();
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.links.filter((l) => l.target_type === 'change').length >= Math.max(1, before), 'no change link in API');
});

await step('"Compare" shows both values of the concurrent edit', async () => {
  // The overview shows the latest 8 entries; the incident page has the full history.
  await page.goto(`${BASE}/projects/${pid}/incidents/${focus.id}`, { waitUntil: 'domcontentloaded' });
  await click(page, 'Compare');
  await page.waitForSelector('[role="dialog"]');
  const t = await page.$eval('[role="dialog"]', (e) => e.textContent);
  assert(t.includes('sev1') && t.includes('sev2'), 'compare dialog lacks both values');
  await page.keyboard.press('Escape');
});

await step('"Keep <engineer>\'s instead" applies the rejected value', async () => {
  await click(page, `Keep ${scenario.people.riley.name}'s instead`);
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident.severity === 'sev2', 'severity not sev2 in API');
  await waitText(page, 'value is now current');
});

// ---- search, presence, incident page -------------------------------------------------------
await step('Ctrl+K search finds the incident by number and navigates to it', async () => {
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  await page.waitForSelector('.palette input');
  await page.type('.palette input', INC);
  await until(async () => (await page.$$('.palette-item')).length, 'no search results');
  await page.keyboard.press('Enter');
  await until(async () => page.url().includes(`/incidents/${focus.id}`), `did not navigate (${page.url()})`);
});

await step('presence: the incident page shows who is viewing', async () => {
  await waitText(page, 'viewing now');
  const viewers = (await api(tokens.engineer, `/projects/${pid}/overview`)).body.presence[focus.id] ?? [];
  assert(viewers.some((v) => v.name === scenario.people.riley.name), 'engineer not in presence API');
});

await step('incident edit saves through optimistic concurrency', async () => {
  const before = (await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident.version;
  const input = await page.$('input[placeholder="#inc-…"]');
  await input.click({ clickCount: 3 });
  await input.type('#inc-e2e');
  await click(page, 'Save 1 change');
  await until(async () => {
    const i = (await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident;
    return i.channel === '#inc-e2e' && i.version === before + 1;
  }, 'channel/version not updated in API');
});

await step('a second browser editing the same field triggers the conflict panel; "Save with these choices" resolves it', async () => {
  const other = await newPage(tokens.admin);
  await other.goto(`${BASE}/projects/${pid}/incidents/${focus.id}`, { waitUntil: 'domcontentloaded' });
  await other.waitForSelector('form.card input');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.card input');
  const setTitle = async (p, v) => {
    const el = await p.$('form.card input');
    await el.click({ clickCount: 3 });
    await el.type(v);
  };
  await setTitle(page, 'checkout 5xx spike (engineer)');
  await setTitle(other, 'checkout 5xx spike (owner)');
  await click(other, 'Save 1 change');
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident.title.includes('owner'), 'owner save not applied');
  await click(page, 'Save');
  await waitText(page, 'Edit conflict');
  // keep "Mine" (the default choice) and save on top of the owner's version
  await click(page, 'Save with these choices');
  await until(async () => (await api(tokens.engineer, `/incidents/${focus.id}`)).body.incident.title.includes('engineer'), 'chosen value not saved');
  await other.browserContext().close();
});

await step('theme toggle switches to dark and persists across reloads', async () => {
  await page.click('button[aria-label="Toggle theme"]');
  assert((await page.$eval('html', (e) => e.getAttribute('data-theme'))) === 'dark', 'not dark');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert((await page.$eval('html', (e) => e.getAttribute('data-theme'))) === 'dark', 'dark not persisted');
  await page.click('button[aria-label="Toggle theme"]');
  assert((await page.$eval('html', (e) => e.getAttribute('data-theme'))) === 'light', 'not light again');
});

await step('"Report incident" creates an incident and opens it', async () => {
  const title = `e2e report ${Date.now()}`;
  await click(page, 'Report incident', 'button', '.topbar');
  await page.waitForSelector('[role="dialog"] input');
  await page.type('[role="dialog"] input', title);
  await click(page, 'Report incident', 'button', '[role="dialog"] .modal-actions');
  await until(async () => /\/incidents\/[0-9a-f-]{36}$/.test(page.url()) && !page.url().includes(focus.id), 'did not open the new incident');
  const list = (await api(tokens.engineer, `/projects/${pid}/incidents?status=all&q=${encodeURIComponent(title)}`)).body.incidents;
  assert(list.length === 1, `API has ${list.length} incidents titled ${title}`);
});

// ---- lists & filters ------------------------------------------------------------------------
await step('Deploys: "Conflicting reports" filter + detail modal', async () => {
  await page.goto(`${BASE}/projects/${pid}/deploys`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody tr');
  await page.select('select[aria-label="Data quality"]', 'conflicts');
  const expected = (await api(tokens.engineer, `/projects/${pid}/deployments?limit=200`)).body.deployments.filter((d) => d.conflicts.length > 0).length;
  await until(async () => (await page.$$('tbody tr')).length === expected, `expected ${expected} rows`);
  await (await page.$('tbody tr')).click();
  await page.waitForSelector('[role="dialog"]');
  await waitText(page, 'Conflicting reports');
  await page.keyboard.press('Escape');
});

await step('Deploys: "Incomplete records" filter matches the API', async () => {
  await page.select('select[aria-label="Data quality"]', 'incomplete');
  const expected = (await api(tokens.engineer, `/projects/${pid}/deployments?limit=200`)).body.deployments.filter((d) => d.gaps.length > 0).length;
  await until(async () => (await page.$$('tbody tr')).length === expected, `expected ${expected} rows`);
});

await step('Changes: "Config changes" filter shows only config changes', async () => {
  await page.goto(`${BASE}/projects/${pid}/changes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody tr');
  await page.select('select[aria-label="Kind"]', 'config');
  const expected = (await api(tokens.engineer, `/projects/${pid}/changes?limit=500`)).body.changes.filter((c) => c.kind === 'config').length;
  await until(async () => (await page.$$('tbody tr')).length === expected, `expected ${expected} config rows`);
});

await step('Timeline: "Reported late" filter shows exactly the late events', async () => {
  await page.goto(`${BASE}/projects/${pid}/timeline`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tl-item');
  await page.select('select[aria-label="Filter"]', 'late');
  const expected = (await api(tokens.engineer, `/projects/${pid}/timeline?flags=late&limit=400`)).body.events.length;
  await until(async () => (await page.$$('.tl-item')).length === expected, `expected ${expected} late events`);
});

await step('Recurring: the window selector changes the groups to match the API', async () => {
  await page.goto(`${BASE}/projects/${pid}/recurring`, { waitUntil: 'domcontentloaded' });
  for (const days of [90, 30]) {
    if (days !== 90) await page.select('select[aria-label="Window"]', String(days));
    const n = (await api(tokens.engineer, `/projects/${pid}/recurring?days=${days}`)).body.groups.length;
    await waitText(page, `${n} recurring group${n === 1 ? '' : 's'}`);
  }
});

await step('"Record deploy" form creates a numbered deploy', async () => {
  const before = Math.max(...(await api(tokens.engineer, `/projects/${pid}/deployments?limit=500`)).body.deployments.map((x) => x.number));
  await page.goto(`${BASE}/projects/${pid}/deploys`, { waitUntil: 'domcontentloaded' });
  await click(page, 'Record deploy');
  await page.waitForSelector('[role="dialog"] input');
  await page.type('[role="dialog"] input[placeholder="v2.15.0"]', 'v7.7.7-form');
  await click(page, 'Record', 'button', '[role="dialog"] .modal-actions');
  const d = await until(async () => (await api(tokens.engineer, `/projects/${pid}/deployments?limit=50`)).body.deployments.find((x) => x.version === 'v7.7.7-form'), 'deploy not in API');
  assert(d.number === before + 1, `expected the next number ${before + 1}, got ${d.number}`);
});

await step('"Record change" form records a config change with no deploy', async () => {
  await page.goto(`${BASE}/projects/${pid}/changes`, { waitUntil: 'domcontentloaded' });
  await click(page, 'Record change');
  await page.waitForSelector('[role="dialog"] input');
  const sha = `cafe${Date.now().toString(16)}`;
  await page.type('[role="dialog"] input.mono', sha);
  await page.select('[role="dialog"] select', 'config');
  await page.type('[role="dialog"] textarea', 'flag: disable one-page checkout');
  await click(page, 'Record', 'button', '[role="dialog"] .modal-actions');
  const c = await until(async () => (await api(tokens.engineer, `/projects/${pid}/changes?limit=500`)).body.changes.find((x) => x.sha === sha), 'change not in API');
  assert(c.kind === 'config' && c.deployments.length === 0, `kind ${c.kind}, deployments ${c.deployments.length}`);
});

await step('Incidents: severity filter and search narrow the list exactly like the API', async () => {
  await page.goto(`${BASE}/projects/${pid}/incidents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody tr');
  await page.select('select[aria-label="Status"]', 'all');
  await page.select('select[aria-label="Severity"]', 'sev2');
  let expected = (await api(tokens.engineer, `/projects/${pid}/incidents?status=all&severity=sev2`)).body.incidents.length;
  await until(async () => (await page.$$('tbody tr')).length === expected, `expected ${expected} sev2 rows`);
  await page.type('input[aria-label="Search incidents"]', 'pool');
  expected = (await api(tokens.engineer, `/projects/${pid}/incidents?status=all&severity=sev2&q=pool`)).body.incidents.length;
  await until(async () => (await page.$$('tbody tr')).length === expected || (expected === 0 && (await bodyText(page)).includes('No incidents match')), `expected ${expected} rows`);
});

await step('Timeline: unticking "deployments" hides deploy events', async () => {
  await page.goto(`${BASE}/projects/${pid}/timeline`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tl-item');
  const box = await until(async () => (await page.$$(xp('deployments', 'label')))[0], 'checkbox label missing');
  await box.click();
  await until(async () => page.url().includes('kinds='), 'kinds not in URL');
  await until(async () => (await page.$$eval('.tl-meta .badge.outline', (b) => b.map((x) => x.textContent))).every((t) => t !== 'deployment'), 'deploy events still listed');
});

await step('a project with nothing active shows the all-clear hero', async () => {
  const quiet = projects.find((p) => !p.worst_open_severity);
  assert((await api(tokens.engineer, `/projects/${quiet.id}/overview`)).body.focus === null, 'API says something is active');
  await page.goto(`${BASE}/projects/${quiet.id}`, { waitUntil: 'domcontentloaded' });
  await waitText(page, 'ALL CLEAR');
});

// ---- live updates ---------------------------------------------------------------------------
await step('live: a deploy sent to the ingestion API appears without a reload', async () => {
  await page.goto(`${BASE}/projects/${pid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hero');
  await sleep(1500); // let the SSE stream connect
  const token = (await api(tokens.admin, `/projects/${pid}`)).body.project.ingest_token;
  const r = await api(null, `/projects/${pid}/events`, {
    method: 'POST',
    headers: { 'x-ingest-token': token, 'x-event-source': 'e2e' },
    body: { type: 'deployment', deployment_id: `e2e-${Date.now()}`, status: 'succeeded', version: 'v9.9.9-e2e', environment: 'production', service: 'web' },
  });
  assert(r.status === 201, `ingest returned ${r.status}`);
  await waitText(page, 'v9.9.9-e2e', 10000); // ledger row (no commits → shows the version)
});

// ---- roles ----------------------------------------------------------------------------------
await step('viewer sees no write controls', async () => {
  const v = await newPage(tokens.viewer);
  current = v;
  await v.goto(`${BASE}/projects/${pid}`, { waitUntil: 'domcontentloaded' });
  await v.waitForSelector('.hero');
  await sleep(1500);
  const t = await bodyText(v);
  for (const s of ['Report incident', 'Mark as cause', 'Roll back to', 'Post update']) assert(!t.includes(s), `viewer can see "${s}"`);
  await v.browserContext().close();
  current = page;
});

// ---- admin ----------------------------------------------------------------------------------
const admin = await newPage(tokens.admin);
current = admin;

await step('Integrations: "Show" reveals the real ingest token', async () => {
  await admin.goto(`${BASE}/projects/${pid}/integrations`, { waitUntil: 'domcontentloaded' });
  const token = (await api(tokens.admin, `/projects/${pid}`)).body.project.ingest_token;
  const secrets = await until(async () => {
    const s = await admin.$$('.secret');
    return s.length >= 3 ? s : null;
  }, 'secrets not rendered');
  const showBtn = (await secrets[2].$$(xp('Show', 'button')))[0];
  await showBtn.click();
  const shown = await secrets[2].$eval('code', (c) => c.textContent);
  assert(shown === token, 'shown token differs from API');
});

await step('Integrations: rotating secrets changes the ingest token', async () => {
  const before = (await api(tokens.admin, `/projects/${pid}`)).body.project.ingest_token;
  await admin.goto(`${BASE}/projects/${pid}/integrations`, { waitUntil: 'domcontentloaded' });
  await click(admin, 'Rotate secrets');
  await click(admin, 'Rotate', 'button', '[role="dialog"] .modal-actions');
  await until(async () => (await api(tokens.admin, `/projects/${pid}`)).body.project.ingest_token !== before, 'token unchanged');
});

await step('Integrations: editing the project description saves it', async () => {
  const text = `e2e description ${Date.now()}`;
  const ta = await admin.$('form.card textarea');
  await ta.click({ clickCount: 3 });
  await ta.type(text);
  await click(admin, 'Save', 'button', 'form.card');
  await until(async () => (await api(tokens.admin, `/projects/${pid}`)).body.project.description === text, 'description not saved');
});

await step('Audit log lists entries and expands a before/after diff', async () => {
  await admin.goto(`${BASE}/audit?project_id=${pid}`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('tbody tr.clickable');
  const rows = await admin.$$('tbody tr.clickable');
  const apiCount = (await api(tokens.admin, `/audit?project_id=${pid}&limit=300`)).body.entries.length;
  assert(rows.length === apiCount, `${rows.length} rows vs ${apiCount} in API`);
  await rows[0].click();
  await until(async () => (await admin.$$('tbody tr.clickable[aria-expanded="true"]')).length === 1, 'row did not expand');
});

await step('Users: add a user, then change their role', async () => {
  const email = `e2e${Date.now()}@test.dev`;
  await admin.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' });
  await click(admin, 'Add user');
  await admin.waitForSelector('[role="dialog"] input');
  const inputs = await admin.$$('[role="dialog"] input');
  await inputs[0].type('E2E Person');
  await inputs[1].type(email);
  await inputs[2].type('password1234');
  await click(admin, 'Add user', 'button', '[role="dialog"] .modal-actions');
  const user = await until(async () => (await api(tokens.admin, '/users')).body.users.find((u) => u.email === email), 'user not created');
  await admin.waitForSelector(`select[aria-label="Role for E2E Person"]`);
  await admin.select('select[aria-label="Role for E2E Person"]', 'viewer');
  await until(async () => (await api(tokens.admin, '/users')).body.users.find((u) => u.id === user.id).role === 'viewer', 'role not changed');
});

await step('New project is created, then archived', async () => {
  const pname = `e2e-project-${Date.now()}`;
  await click(admin, 'New project');
  await admin.waitForSelector('[role="dialog"] input');
  await admin.type('[role="dialog"] input', pname);
  await click(admin, 'Create project', 'button', '[role="dialog"]');
  const created = await until(async () => (await api(tokens.admin, '/projects')).body.projects.find((p) => p.name === pname), 'project not created');
  await until(async () => admin.url().includes(`/projects/${created.id}/integrations`), 'did not open the new project');
  await click(admin, 'Archive project');
  await click(admin, 'Archive', 'button', '[role="dialog"] .modal-actions');
  await until(async () => !(await api(tokens.admin, '/projects')).body.projects.some((p) => p.id === created.id), 'project still listed');
});

await step('phone width (390 px): no horizontal scrolling; project switcher and account menu in the top bar', async () => {
  await admin.setViewport({ width: 390, height: 844 });
  await admin.goto(`${BASE}/projects/${pid}`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('.hero');
  await sleep(1000);
  const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `page is ${overflow}px wider than the screen`);
  // the sidebar is collapsed on phones: project switching and the account menu move to the top bar
  const options = await admin.$$eval('select[aria-label="Switch project"] option', (o) => o.length);
  assert(options === (await api(tokens.owner, '/projects')).body.projects.length, `project switcher has ${options} options`);
  await admin.click('button[aria-label="Account menu"]');
  await admin.waitForSelector('[role="dialog"]');
  await waitText(admin, 'Sign out');
  await admin.keyboard.press('Escape');
  await admin.setViewport({ width: 1440, height: 1000 });
});

await step('Users: "Reset password" signs that person out everywhere', async () => {
  await admin.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' });
  const row = await until(async () => (await admin.$$(xp(scenario.people.sam.name, 'tr')))[0], 'Sam row missing');
  const btn = (await row.$$(xp('Reset password', 'button')))[0];
  await btn.click();
  await admin.waitForSelector('[role="dialog"] input');
  await admin.type('[role="dialog"] input', 'a-reset-password-1');
  await click(admin, 'Reset password', 'button', '[role="dialog"] .modal-actions');
  await until(async () => (await api(tokens.sam, '/auth/me')).status === 401, 'the old session still works');
  assert(await login(scenario.people.sam.email, 'a-reset-password-1'), 'new password does not work');
});

await step('Your account: changing my password keeps me signed in and revokes my other sessions', async () => {
  const oldToken = tokens.owner;
  await admin.click('button[aria-label="Your account"]');
  await admin.waitForSelector('form[aria-label="Change password"] input');
  const inputs = await admin.$$('form[aria-label="Change password"] input');
  await inputs[0].type(OWNER.password);
  await inputs[1].type('owner-password-456');
  await inputs[2].type('owner-password-456');
  await click(admin, 'Change password', 'button', 'form[aria-label="Change password"] .modal-actions');
  await until(async () => (await api(oldToken, '/auth/me')).status === 401, 'old session still valid');
  await admin.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' });
  await waitText(admin, 'Users & roles');
  assert(await login(OWNER.email, 'owner-password-456'), 'new password does not work');
});

await step('sign out returns to the sign-in screen', async () => {
  await admin.click('button[aria-label="Sign out"]');
  await admin.waitForSelector('form[aria-label="Sign in"]');
});

await step('no uncaught page errors or 5xx responses during the run', async () => {
  assert(errors.length === 0, errors.join(' | '));
});

await browser.close();
stopServer();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — failures screenshotted to ${ART}` : ''}\n`);
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
