// Request bodies and the limits in front of MetaCode: with a web server that
// accepts at most 1 MB per request (nginx's default client_max_body_size, in
// front of MetaCode and of the account storage), a long AI Coding run, sharing
// a large project and the account sync still work — big work is sent in
// pieces, and a piece that's still too large doesn't stop the rest or get sent
// over and over. Also: Analyze CSV's compact edge list (and a script that
// exits early can't crash the server), and respondents' own "too large"
// message. Real Chromium; stand-ins for Supabase and the AI service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');
const { mockSupabase } = require('./helpers/account-mocks');
const { bodyLimitProxy } = require('./helpers/body-limit-proxy');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const noBrowser = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';
const MB = 1024 * 1024;
const KEY = 'sb_publishable_request_size_0123456789';
const chats = [];             // what the AI service received: { system: length of the system message, user }
let tmp, sb, sbFront, emis, server, front, direct, browser, mod, ctx, page;
const consoleErrors = [];

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-size-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  sb.addUser('owner@example.org', 'password-owner');
  sbFront = bodyLimitProxy(sb.url, 1 * MB, { cors: true });
  await sbFront.start();
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'coder-model' }] }));
      const j = JSON.parse(body || '{}');
      const sys = (j.messages || []).find(m => m.role === 'system');
      chats.push({ system: sys ? String(sys.content).length : 0, user: String(((j.messages || []).find(m => m.role === 'user') || {}).content || '').slice(0, 40) });
      res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: '{"codings":{"d1":{"code":"pos","confidence":0.9,"reasoning":"ok"}}}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sbFront.url, SUPABASE_PUBLISHABLE_KEY: KEY, STRIPE_SECRET_KEY: '', ACCOUNT_PLAN_OVERRIDES: 'owner@example.org=ultra',
    EMIS_BASE_URL: 'http://127.0.0.1:' + emis.address().port + '/v1', EMIS_API_KEY: 'emis-request-size-test-0123456789', EMIS_TRANSPORT: 'node',
    EMIS_MODELS_FILE: path.join(tmp, 'none.json'), EMIS_MODEL: 'coder-model',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    COLLAB_DATA_DIR: path.join(tmp, 'collab'), PUBLIC_URL: '', DESKTOP_RELEASES_REPO: 'off'
  }));
  mod = require('../server');
  server = await mod.start(0);
  direct = 'http://127.0.0.1:' + server.address().port;
  front = bodyLimitProxy(direct, 1 * MB);
  await front.start();
  if (noBrowser) return;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
  ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  await page.goto(front.url + '/app.html#dashboard');
  await page.click('#acct-slot .acct-signin');
  await page.fill('.acct-form [name=email]', 'owner@example.org');
  await page.fill('.acct-form [name=password]', 'password-owner');
  await page.click('.acct-form .acct-primary');
  await page.waitForSelector('#acct-slot .acct-plan-badge');
});
test.after(async () => {
  if (browser) await browser.close();
  if (front) await front.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (sbFront) await sbFront.close();
  if (sb) await sb.close();
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const until = async (fn, what, ms) => { const end = Date.now() + (ms || 60000); for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 200)); } };
const text = n => ('Post ' + n + ' ').padEnd(1200, 'lorem ipsum dolor sit amet ');
// A codebook with long descriptions: its prompt (~6 KB) goes with every post
const codebook = [{ id: 'd1', name: 'Stance', description: 'Overall stance. '.repeat(120), codes: [{ id: 'pos', label: 'Positive', description: 'Supportive of the policy. '.repeat(100) }, { id: 'neg', label: 'Negative', description: 'Against the policy. '.repeat(100) }] }];

test('AI Coding: a run far over 1 MB is sent in batches the web server accepts, the codebook prompt once per batch; every post is coded', { skip: noBrowser, timeout: 180000 }, async () => {
  const N = 700;
  await page.evaluate(([n, cb, sample]) => {
    App.setState({ project: { name: 'Big run', description: '' }, codebook: cb, posts: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, text: sample.replace('Post 0 ', 'Post ' + i + ' '), humanCodes: {}, aiCodes: {} })) });
    App.navigate('ai-coding');
  }, [N, codebook, text(0)]);
  await page.waitForSelector('#run-btn');
  chats.length = 0;
  await page.click('#run-btn');
  await until(() => page.evaluate(n => App.getState().posts.filter(p => p.aiCodes && p.aiCodes.d1).length === n, N), 'every post coded', 150000);
  const batches = front.passed.filter(r => r.path === '/api/ai/batch');
  assert.equal(front.refused.filter(r => r.path === '/api/ai/batch').length, 0, 'nothing refused as too large');
  assert.ok(batches.length >= 4, 'sent as several batches (' + batches.length + ')');
  assert.ok(batches.every(b => b.bytes <= 600 * 1024), 'each batch well under 1 MB: ' + batches.map(b => b.bytes).join(', '));
  assert.ok(batches.reduce((a, b) => a + b.bytes, 0) < 2 * MB, 'the codebook prompt isn\'t repeated for every post (all of it: ' + batches.reduce((a, b) => a + b.bytes, 0) + ' bytes)');
  assert.equal(chats.length, N);
  assert.ok(chats.every(c => c.system > 5000), 'every request still had the codebook as its system message');
  await until(() => page.evaluate(() => /✓ Done — 700 posts coded/.test(document.getElementById('status-msg').textContent)), 'the run says it\'s done');
});

test('AI Coding: when a later batch of a run fails (a web server in front answers 502), each post is counted once and tried again', { skip: noBrowser, timeout: 180000 }, async () => {
  const N = 400;
  let batches = 0;
  await page.route('**/api/ai/batch', route => (++batches === 2 ? route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' }) : route.continue()));
  try {
    await page.evaluate(([n, cb]) => {
      App.setState({ project: { name: 'Run with a hiccup', description: '' }, codebook: cb, posts: Array.from({ length: n }, (_, i) => ({ id: 'h' + i, text: 'Post ' + i, humanCodes: {}, aiCodes: {} })) });
      App.navigate('ai-coding');
    }, [N, codebook]);
    await page.waitForSelector('#run-btn');
    await page.click('#run-btn');
    await until(() => page.evaluate(() => /Done|Nothing was coded|Stopped/.test(document.getElementById('status-msg').textContent)), 'the run ends', 150000);
    assert.equal(await page.evaluate(() => document.getElementById('status-msg').textContent), '✓ Done — 400 posts coded.');
    assert.equal(await page.evaluate(() => document.getElementById('progress-label').textContent), '400 / 400');
    assert.equal(batches, 3, 'the batch that failed was sent again');
  } finally { await page.unroute('**/api/ai/batch'); }
});

test('sharing a project far over 1 MB: the first part fits, the rest follows as changes; nothing is refused', { skip: noBrowser, timeout: 180000 }, async () => {
  const N = 2500;
  await page.evaluate(([n, sample]) => {
    App.setState({ project: { name: 'Big share', description: '' }, codebook: [], posts: Array.from({ length: n }, (_, i) => ({ id: 's' + i, text: sample.replace('Post 0 ', 'Post ' + i + ' '), humanCodes: {}, aiCodes: {} })) });
    App.navigate('dashboard');
  }, [N, text(0)]);
  await page.click('#cl-share-btn');
  await page.click('#cl-go');
  await page.waitForSelector('#cl-emails', { timeout: 120000 });
  const id = await page.evaluate(() => Collab.link().id);
  assert.equal((await mod.collab.store.get(id)).data.posts.length, N, 'every post is on the server once the dialog says it\'s shared');
  assert.equal(await page.evaluate(() => Collab.status().pending), 0);
  assert.equal(front.refused.filter(r => /^\/api\/collab/.test(r.path)).length, 0);
  const sends = front.passed.filter(r => r.method === 'POST' && /^\/api\/collab\/projects/.test(r.path));
  assert.ok(sends.length >= 4 && sends.every(s => s.bytes < 700 * 1024), 'in pieces: ' + sends.map(s => s.bytes).join(', '));
  assert.deepEqual(await page.evaluate(() => App.getState().posts.length), N, 'the open project is unchanged');
  await page.click('#modal-foot .btn-primary');
});

test('the account sync: an item the account storage refuses as too large stays in this browser, isn\'t sent over and over, and doesn\'t hold up the others', { skip: noBrowser, timeout: 120000 }, async () => {
  // The open project (several MB) is over the 1 MB in front of the account storage; a small saved project isn't
  await page.evaluate(() => LocalDB.put('projects', { id: 'pr_smallone1', name: 'Small one', description: '', createdAt: new Date().toISOString(), savedAt: new Date().toISOString(), revision: 1, data: { project: { name: 'Small one' }, posts: [], codebook: [] } }));
  await page.evaluate(() => CloudSync.syncNow());
  await until(() => sb.rows.some(r => r.kind === 'projects' && r.id === 'pr_smallone1'), 'the small project reaches the account');
  await until(() => sbFront.refused.length > 0, 'the open project was refused once');
  await until(() => page.evaluate(() => [...document.querySelectorAll('.notif-stack > *')].some(n => /too large to save to your account/.test(n.textContent))), 'the browser says so');
  await new Promise(r => setTimeout(r, 3000));
  const before = sbFront.refused.length;
  for (let i = 0; i < 3; i++) { await page.evaluate(() => CloudSync.syncNow()); await new Promise(r => setTimeout(r, 500)); }
  assert.equal(sbFront.refused.length, before, 'the same version isn\'t sent again');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.notif-stack > *')].filter(n => /too large to save to your account/.test(n.textContent)).length), 1, 'said once');
  const quiet = sbFront.passed.length + sbFront.refused.length;
  await new Promise(r => setTimeout(r, 8000));
  assert.equal(sbFront.passed.length + sbFront.refused.length, quiet, 'left alone, the browser doesn\'t keep syncing it every few seconds');
  assert.deepEqual(await page.evaluate(() => [CloudSync.status().pending, CloudSync.status().tooLarge]), [0, 1], 'counted as too large, not as waiting');
});

test('the web server in front of MetaCode refused nothing all along (the console\'s only 413s are the account storage\'s)', { skip: noBrowser }, async () => {
  assert.deepEqual(front.refused, []);
  assert.equal(consoleErrors.filter(e => /413/.test(e)).length, sbFront.refused.length, 'one console line per refusal by the account storage');
  assert.deepEqual(consoleErrors.filter(e => /pageerror/.test(e)), []);
});

test('a shared part too large for the web server stays in this browser, and someone else\'s change to it is a conflict, not an overwrite', { skip: noBrowser, timeout: 120000 }, async () => {
  // (the "Big share" project shared above is still open and linked)
  const id = await page.evaluate(() => Collab.link().id);
  const BIG = Math.round(1.65 * MB);
  await page.evaluate(n => { const s = App.getState(); s.posts.find(p => p.id === 's0').text = 'x'.repeat(n); s.posts.find(p => p.id === 's1').text = 'small edit'; App.save(); }, BIG);
  await until(() => front.refused.some(r => /\/changes$/.test(r.path)), 'the large part refused');
  await until(() => page.evaluate(() => [...document.querySelectorAll('.notif-stack > *')].some(n => /too large to send to the shared project/.test(n.textContent))), 'the browser says so');
  await until(async () => (await mod.collab.store.get(id)).data.posts.find(p => p.id === 's1').text === 'small edit', 'the small change was shared anyway');
  assert.equal((await mod.collab.store.get(id)).data.posts.find(p => p.id === 's0').text.length, text(0).length, 'the server still has the old version');
  const refused = front.refused.length;
  await page.evaluate(() => Collab.flush());
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(front.refused.length, refused, 'the same version isn\'t sent over and over');
  // Someone else (here: the same account, through the API) codes s0 from the server's version
  const token = sb.issue(sb.users.get('owner@example.org')).access_token;
  const g = await (await fetch(direct + '/api/collab/projects/' + id, { headers: { Authorization: 'Bearer ' + token } })).json();
  const theirs = Object.assign({}, g.data.posts.find(p => p.id === 's0'), { humanCodes: { d1: 'pos' } });
  const r = await fetch(direct + '/api/collab/projects/' + id + '/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ changes: [{ key: 'post:s0', baseRev: g.revs['post:s0'], value: theirs }] }) });
  assert.equal(r.status, 200);
  await until(() => page.evaluate(() => Collab.status().conflicts === 1), 'a conflict to resolve');
  assert.equal(await page.evaluate(() => App.getState().posts.find(p => p.id === 's0').text.length), BIG, 'the large local version is still here');
  assert.ok(await page.evaluate(() => !!document.getElementById('cl-conflicts')), 'the conflict dialog is open');
  await page.click('#cl-all-theirs');
  await until(() => page.evaluate(() => Collab.status().conflicts === 0), 'resolved');
  assert.deepEqual(await page.evaluate(() => App.getState().posts.find(p => p.id === 's0').humanCodes), { d1: 'pos' });
});

test('Analyze CSV\'s compact edge list is read; a script that ends before reading its input can\'t crash the server', { timeout: 120000 }, async () => {
  const token = sb.issue(sb.users.get('owner@example.org')).access_token;
  const rows = Array.from({ length: 40000 }, (_, i) => ['n' + (i % 200), 'n' + ((i * 7 + 1) % 200), 1]);
  const r = await fetch(direct + '/api/network/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ edgeRows: rows, labels: {}, directed: false }) });
  const j = await r.json();
  if (r.status === 200) assert.ok(j.nodes || j.summary || j.centrality, 'analysed');
  else assert.match(j.error.message, /networkx|Python/i, 'Python without NetworkX says so (and the edges were read: not "No edges provided")');
  assert.equal((await fetch(direct + '/api/health')).status, 200, 'the server is still up');
});

test('respondents whose answers are too long get their own message, not the survey editor\'s', async () => {
  const r = await fetch(direct + '/api/public/surveys/abcd1234/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { q1: 'x'.repeat(1.2 * MB) } }) });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error.message, /These answers are too long to send/);
});
