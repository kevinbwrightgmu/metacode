#!/usr/bin/env node
// Starts a portable MetaCode (scripts/build-portable.js) on the system it's for and checks it: the server
// answers with the app, its service worker and the AI Model Store (local-only, its catalog, this device's
// hardware); the data goes where it should; started again while it runs, it opens the running one and exits;
// stopped, it takes its AI service with it. Used by .github/workflows/portable.yml on each system.
//   node scripts/smoke-portable.js <folder> [--launcher <file>] [--data <dir>] [--port <n>] [--timeout <s>]
//   --launcher  default metacode.sh, or MetaCode.cmd on Windows (relative to the folder, or a path)
//   --data      where the data should go (default <folder>/data); given to the launcher as METACODE_DATA_DIR
//               unless --data-default (the launcher picks it, as a .deb's or an AppImage's does)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const a = process.argv.slice(2);
const opt = { folder: null, launcher: null, data: null, dataDefault: false, port: 3456, timeout: 180 };
for (let i = 0; i < a.length; i++) {
  if (a[i] === '--launcher') opt.launcher = a[++i];
  else if (a[i] === '--data') opt.data = a[++i];
  else if (a[i] === '--data-default') opt.dataDefault = true;
  else if (a[i] === '--port') opt.port = Number(a[++i]);
  else if (a[i] === '--timeout') opt.timeout = Number(a[++i]);
  else opt.folder = path.resolve(a[i]);
}
if (!opt.folder) { console.error('usage: node scripts/smoke-portable.js <folder> [--launcher <file>] [--data <dir>]'); process.exit(2); }
const win = process.platform === 'win32';
const launcher = path.resolve(opt.folder, opt.launcher || (win ? 'MetaCode.cmd' : 'metacode.sh'));
const dataDir = path.resolve(opt.data || path.join(opt.folder, 'data'));
const base = 'http://127.0.0.1:' + opt.port;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(ok, what, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + what + (!ok && detail ? ' — ' + String(detail).slice(0, 400) : ''));
  if (!ok) failures++;
}
async function get(p) {
  try {
    // (the Store waits up to 20 s for ollama.com before it answers from its copy; emulated, all of it is slower)
    const res = await fetch(base + p, { signal: AbortSignal.timeout(Math.max(30, opt.timeout / 6) * 1000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, text, json };
  } catch (e) { return { status: 0, text: String(e && e.message), json: null }; }
}

// The launcher, as a person would start it: MetaCode's own settings from the launcher alone
function launch(extra) {
  const env = Object.assign({}, process.env);
  for (const k of ['AI_MODE', 'METACODE_PROFILE', 'METACODE_HOST', 'METACODE_DATA_DIR', 'METACODE_OPEN_BROWSER', 'METACODE_NO_BROWSER', 'METACODE_ENV_FILE']) delete env[k];
  Object.assign(env, { PORT: String(opt.port) }, opt.data && !opt.dataDefault ? { METACODE_DATA_DIR: dataDir } : {}, extra);
  const ext = path.extname(launcher).toLowerCase();
  const child = win
    ? spawn(ext === '.exe' ? launcher : 'cmd.exe', ext === '.exe' ? [] : ['/d', '/c', launcher], { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawn(launcher, [], { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  child.exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.on('error', e => { out += '\n[spawn error] ' + e.message; });
  return child;
}
// Everything the bundle started: its process tree (POSIX: its process group), on Windows every node.exe
// running from the folder (MetaCode.exe hands over to a window of its own)
function stop(child) {
  if (win) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
    const ps = "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('" + opt.folder.replace(/'/g, "''") + "', 'OrdinalIgnoreCase') } | Stop-Process -Force";
    try { execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch (e) { /* none */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
  }
}
async function answers(child) {
  const deadline = Date.now() + opt.timeout * 1000;
  while (Date.now() < deadline) {
    const h = await get('/api/health');
    if (h.status === 200) return h;
    if (child.exitCode !== null && path.extname(launcher).toLowerCase() !== '.exe') return null;
    await sleep(1000);
  }
  return null;
}

(async () => {
  console.log('MetaCode portable: ' + opt.folder + '\n  launcher ' + launcher + '\n  data ' + dataDir + '\n  ' + os.type() + ' ' + os.release() + ' ' + process.arch);
  const t0 = Date.now();
  const first = launch({ METACODE_NO_BROWSER: '1' });
  try {
    const health = await answers(first);
    check(!!health, 'the server answers', first.output());
    if (!health) throw new Error('not started');
    console.log('        (after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s; Node ' + (health.json && health.json.node) + ')');
    const app = await get('/app.html');
    check(app.status === 200 && /MetaCode/.test(app.text), 'the app (/app.html)', app.status);
    const sw = await get('/sw.js');
    check(sw.status === 200 && /const PWA = /.test(sw.text), 'the service worker (/sw.js)', sw.status);
    const vendor = await get('/vendor/VENDOR.json');
    check(vendor.status === 200 && vendor.json, 'the libraries are local (/vendor/)', vendor.status);
    const status = await get('/api/local-ai/status');
    check(status.json && status.json.mode === 'local-only', 'AI Model Store: AI_MODE=local-only', status.text);
    check(status.json && status.json.manage && status.json.manage.allowed === true, 'AI Model Store: this computer may manage models', status.text);
    const catalog = await get('/api/local-ai/catalog');
    const models = catalog.json && catalog.json.models;
    check(Array.isArray(models) && models.length >= 100, 'AI Model Store: the catalog (' + (models ? models.length : 0) + ' models, ' + (catalog.json && catalog.json.source) + ')', catalog.text);
    const hw = await get('/api/local-ai/hardware');
    check(hw.json && hw.json.memory && hw.json.memory.total > 0 && hw.json.cpu && hw.json.cpu.threads > 0, 'AI Model Store: this device (' + (hw.json ? [hw.json.os && hw.json.os.name, hw.json.arch, Math.round(((hw.json.memory && hw.json.memory.total) || 0) / 1e9) + ' GB'].join(', ') : '?') + ')', hw.text);
    const rec = await get('/api/local-ai/recommendations');
    check(rec.status === 200 && rec.json && Array.isArray(rec.json.tiers), 'AI Model Store: recommendations', rec.text);
    // (what the Store's advice rests on, read each system's own way)
    const h = hw.json || {};
    check(h.disk && typeof h.disk.free === 'number' && h.disk.free > 0, 'AI Model Store: the free disk space (' + (h.disk && typeof h.disk.free === 'number' ? Math.round(h.disk.free / 1e9) + ' GB at ' + h.disk.path : '?') + ')', JSON.stringify(h.disk));
    if (process.platform === 'darwin') {
      let version = null;
      try { version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(); } catch (e) { /* none */ }
      check(!!version && h.os && h.os.name === 'macOS ' + version, 'AI Model Store: the macOS version (' + (h.os && h.os.name) + '; sw_vers says ' + version + ')', JSON.stringify(h.os));
      check(h.memory && typeof h.memory.available === 'number' && h.memory.available > 0 && h.memory.available <= h.memory.total, 'AI Model Store: the memory available, from vm_stat (' + Math.round(((h.memory && h.memory.available) || 0) / 1e9) + ' GB)', JSON.stringify(h.memory));
      // Apple silicon, also for the Intel build under Rosetta: its GPU (Metal) runs the models
      let arm = false;
      try { arm = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1'; } catch (e) { /* an Intel Mac */ }
      if (arm) {
        check(h.appleSilicon === true && (h.gpus || []).some(g => g.vendor === 'apple' && g.shared && g.usable), 'AI Model Store: Apple silicon and its GPU' + (h.arch === 'x64' ? ' (MetaCode under Rosetta)' : ''), JSON.stringify({ appleSilicon: h.appleSilicon, arch: h.arch, gpus: h.gpus }));
        const picks = ((rec.json && rec.json.tiers) || []).flatMap(t => t.models || []);
        check(picks.length > 0 && picks.every(p => p.runsOn === 'gpu'), 'AI Model Store: recommended models run on the GPU (' + picks.length + ')', JSON.stringify(picks.slice(0, 3)));
      }
    }
    let kept = [];
    try { kept = fs.readdirSync(dataDir); } catch (e) { /* none */ }
    check(kept.length > 0, 'the data is in ' + dataDir + ' (' + kept.join(', ') + ')');

    // Started again while it runs (as a second double-click would): opens the running one and exits
    const second = launch({});
    const code = await Promise.race([second.exited, sleep(Math.max(60, opt.timeout) * 1000).then(() => 'timeout')]);
    const exeLauncher = path.extname(launcher).toLowerCase() === '.exe';
    if (!exeLauncher) check(code === 0 && /already running/.test(second.output()), 'a second start opens the one that runs, and exits', 'exit ' + code + ': ' + second.output());
    if (code === 'timeout') stop(second);
  } catch (e) {
    if (e.message !== 'not started') check(false, 'the checks ran', e.stack);
  } finally {
    stop(first);
    let down = false;
    for (let i = 0; i < 30 && !down; i++) { down = (await get('/api/health')).status === 0; if (!down) await sleep(1000); }
    check(down, 'stopped');
    {
      // (its AI service went with it: nothing answers at the AI service's address)
      await sleep(2000);
      let aiUp = false;
      try { aiUp = (await fetch('http://127.0.0.1:4097/health', { signal: AbortSignal.timeout(3000) })).status > 0; } catch (e) { aiUp = false; }
      check(!aiUp, 'its AI service stopped too');
    }
  }
  console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
