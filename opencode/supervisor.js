// ── Running MetaCode's OpenCode service ───────────────────────────────────────
// MetaCode's AI goes through its OpenCode service (opencode/server.mjs, see
// docs/opencode-service.md). On a server pm2 runs both apps
// (ecosystem.config.cjs sets OPENCODE_SERVICE_MANAGED=off for MetaCode).
// Started any other way (npm start, node server.js), MetaCode starts the
// service itself, as a child process, when nothing answers at its address:
//
//   OPENCODE_SERVICE_MANAGED=auto  (default) only at the default address (no
//                                  OPENCODE_SERVICE_URL), and only when GET /health
//                                  doesn't answer within 1 s
//   OPENCODE_SERVICE_MANAGED=on    also at an OPENCODE_SERVICE_URL on this machine
//   OPENCODE_SERVICE_MANAGED=off   never (pm2 or something else runs it)
//
// The child's output goes to MetaCode's log with "[opencode]" in front. If it
// stops unexpectedly it is started again after 1 s, 2 s, 4 s… up to 60 s, and
// the last error it printed says why (state().problem). It is stopped with
// MetaCode: SIGTERM, then SIGKILL after 5 s.
//
// A service that already answers is used, not started again, unless GET /health
// shows it isn't this copy's: another program (no service:'metacode-opencode'),
// or another MetaCode's (its "home" isn't shared.homeId of this data folder).
// Then no child is started either, and state().problem says to pick a free port.
//
// createSupervisor(options) → { start(target), stop(), state(), whenReady(ms) }
// options (all optional; the tests use them): script, nodePath, log,
// healthTimeoutMs, readyTimeoutMs, minBackoffMs, maxBackoffMs, killAfterMs,
// stableAfterMs, onReady(state).

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { redact } = require('../lib/log');
const { REPO_DIR, isLoopback, homeId, serviceSettings } = require('./shared');

const SERVICE_SCRIPT = path.join(__dirname, 'server.mjs');
const RECENT_LINES = 40;

const PACKAGES_MISSING = 'The AI service couldn\'t start: its packages aren\'t installed. Run "npm install" and restart MetaCode.';

// GET <origin>/health, straight to the address (never through a proxy).
// → { answered: true, status, service, pid, home } or { answered: false }
function checkHealth(origin, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get(origin + '/health', { timeout: timeoutMs, headers: { Accept: 'application/json' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (body.length < 4096) body += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch (e) { j = null; }
          finish({ answered: true, status: res.statusCode, service: j && typeof j.service === 'string' ? j.service : null, pid: j && Number.isInteger(j.pid) ? j.pid : null,
            home: j && typeof j.home === 'string' ? j.home : null });
        });
        res.on('error', () => finish({ answered: true, status: res.statusCode, service: null, pid: null, home: null }));
      });
    } catch (e) { finish({ answered: false }); return; }
    req.on('timeout', () => { req.destroy(); finish({ answered: false }); });
    req.on('error', () => finish({ answered: false }));
  });
}

// Why the child stopped, from the last lines it printed: [{ text, err (from stderr) }]
function describeExit(code, signal, lines, script, port) {
  const text = lines.map(l => l.text).join('\n');
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|MODULE_NOT_FOUND|can't start: the package \S+ isn't installed/.test(text)) {
    // node can't find the service's own file or one next to it (an incomplete update), or one of its packages
    // (server.mjs says the last in one line of its own)
    const missing = /Cannot find module '([^']+)'/.exec(text);
    if (missing && !/Cannot find package/.test(text) && path.isAbsolute(missing[1])) {
      const file = path.relative(REPO_DIR, missing[1]).split(path.sep).join('/');
      return 'The AI service couldn\'t start: ' + (missing[1] === script ? file + ' is missing' : 'one of its files is missing (' + file + ')') + '. Update MetaCode (git pull) and restart it.';
    }
    return PACKAGES_MISSING;
  }
  if (/EADDRINUSE|is in use|already in use/i.test(text)) {
    return 'The AI service couldn\'t start: port ' + port + ' is in use by another program (or another copy of the service). Set OPENCODE_SERVICE_PORT to a free port in .env, ' +
      'or OPENCODE_SERVICE_MANAGED=off when pm2 runs the service.';
  }
  // SIGKILL can't be caught, so nothing it printed says why
  if (signal === 'SIGKILL') return 'The AI service was stopped by signal SIGKILL (killed from outside, for example by the system\'s out-of-memory killer).';
  // Only its errors (stderr), never its ordinary lines such as the access log; without
  // stack frames, Node's version line and native frames. The last error-like line, else the last one.
  const errors = lines.filter(l => l.err && /\S/.test(l.text) && !/^\s+at |^Node\.js v\d|^\s*\d+: 0x/.test(l.text)).map(l => l.text).reverse();
  const last = errors.find(l => /\b(?:\w*Error|FATAL ERROR|unexpected failure|couldn't start)\b/i.test(l)) || errors[0];
  return 'The AI service stopped unexpectedly (' + (signal ? 'signal ' + signal : 'exit code ' + code) + ')' + (last ? ': ' + redact(last.trim(), 300).replace(/\.?$/, '.') : '.');
}

function createSupervisor(options) {
  const o = Object.assign({
    script: SERVICE_SCRIPT, nodePath: process.execPath, log: console,
    healthTimeoutMs: 1000, readyTimeoutMs: 60000, minBackoffMs: 1000, maxBackoffMs: 60000,
    killAfterMs: 5000, stableAfterMs: 30000, onReady: null
  }, options || {});
  const log = o.log;

  let target = null;          // { origin, host, port, token, dataDir, home }
  let mode = 'off';
  let managed = false;        // MetaCode runs the service (now or after a restart)
  let external = false;       // another service already answered at the address
  let child = null;
  let ready = false;
  let startedAt = null;
  let restarts = 0;
  let failures = 0;           // unexpected exits in a row (for the backoff)
  let lastExit = null;
  let problem = null;
  let restartTimer = null;
  let readyTimer = null;
  let generation = 0;         // start()/stop() bump it, so late callbacks of an older run do nothing
  let recent = [];
  let muted = false;          // a child that keeps failing the same way: its output isn't repeated in the log
  let waiters = [];
  let exitHook = null;
  let stopping = Promise.resolve();   // the last stop()'s kill, until the child has exited

  const scrub = line => {
    let s = String(line);
    if (target && target.token) s = s.split(target.token).join('[redacted]');
    return redact(s, 2000);
  };

  function settleWaiters(value) {
    const w = waiters;
    waiters = [];
    w.forEach(fn => fn(value));
  }

  function remember(line) {
    recent.push(line);
    if (recent.length > RECENT_LINES) recent.shift();
  }

  function pipeLines(stream, err, write) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => {
      const clean = scrub(line);
      remember({ text: clean, err });
      if (!muted) write('[opencode] ' + clean);
    });
    rl.on('error', () => {});
  }

  function spawnChild() {
    const gen = generation;
    recent = [];
    ready = false;
    const env = Object.assign({}, process.env, {
      OPENCODE_SERVICE_TOKEN: target.token,
      OPENCODE_SERVICE_HOST: target.host,
      OPENCODE_SERVICE_PORT: String(target.port),
      OPENCODE_SERVICE_DATA_DIR: target.dataDir
    });
    let p;
    try {
      p = spawn(o.nodePath, [o.script], { env, cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      onExit(gen, null, null, e);
      return;
    }
    child = p;
    startedAt = Date.now();
    if (!exitHook) {
      // MetaCode exiting without close() (process.exit, an uncaught error): don't leave the service behind
      exitHook = () => { if (child) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } };
      process.on('exit', exitHook);
    }
    pipeLines(p.stdout, false, line => log.log(line));
    pipeLines(p.stderr, true, line => log.error(line));
    p.on('error', err => { if (child === p) onExit(gen, null, null, err); });
    p.on('exit', (code, signal) => { if (child === p) onExit(gen, code, signal, null); });
    watchReady(gen, p);
  }

  // Polls GET /health until the child answers. After readyTimeoutMs that's a problem,
  // but it keeps watching (more slowly), so a child that answers late is still ready.
  function watchReady(gen, p) {
    const deadline = Date.now() + o.readyTimeoutMs;
    let late = false;
    const tick = async () => {
      readyTimer = null;
      if (gen !== generation || child !== p) return;
      const h = await checkHealth(target.origin, Math.min(1000, o.healthTimeoutMs));
      if (gen !== generation || child !== p) return;
      if (h.answered && h.status === 200) {
        ready = true;
        problem = null;
        muted = false;
        log.log('[opencode] The AI service is running (pid ' + p.pid + ') at ' + target.origin.replace(/^https?:\/\//, '') + '.');
        settleWaiters(true);
        if (typeof o.onReady === 'function') { try { o.onReady(state()); } catch (e) { /* the caller's problem */ } }
        return;
      }
      if (!late && Date.now() > deadline) {
        late = true;
        problem = 'The AI service was started but hasn\'t answered for ' + Math.round(o.readyTimeoutMs / 1000) + ' seconds.';
        log.warn('[opencode] ' + problem);
        settleWaiters(false);
      }
      readyTimer = setTimeout(tick, late ? 2000 : 200);
    };
    readyTimer = setTimeout(tick, 100);
  }

  // The problem when what answers GET /health isn't this copy's service, else null
  function notOurs(h) {
    if (h.service !== 'metacode-opencode') {
      return 'Another program, not MetaCode\'s AI service, answers at ' + target.origin.replace(/^https?:\/\//, '') + '. Set OPENCODE_SERVICE_PORT in .env to a free port and restart MetaCode.';
    }
    if (h.home && h.home !== target.home) {
      return 'Another MetaCode\'s AI service (from a different folder) is using port ' + target.port + '. Set OPENCODE_SERVICE_PORT in .env to a free port and restart MetaCode.';
    }
    return null;   // this copy's (or an older service that doesn't say its "home")
  }

  function onExit(gen, code, signal, err) {
    if (gen !== generation) return;
    const uptime = startedAt ? Date.now() - startedAt : 0;
    child = null;
    ready = false;
    clearTimeout(readyTimer);
    readyTimer = null;
    if (!managed) return;                        // stopped on purpose
    lastExit = { code, signal: signal || null, at: new Date().toISOString() };
    const before = problem;
    problem = err ? 'The AI service couldn\'t be started: ' + redact(err.message, 200) : describeExit(code, signal, recent, o.script, target.port);
    failures = uptime >= o.stableAfterMs ? 1 : failures + 1;
    const delay = Math.min(o.maxBackoffMs, o.minBackoffMs * 2 ** Math.min(failures - 1, 16));
    const again = muted && problem === before;
    muted = failures >= 2 && problem === before;
    log.warn('[opencode] ' + problem + ' Starting it again in ' + (delay >= 1000 ? Math.round(delay / 100) / 10 + ' s' : delay + ' ms') + '.' +
      (muted && !again ? ' (What it prints is left out of the log while it keeps failing this way.)' : ''));
    settleWaiters(false);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (gen !== generation || !managed) return;
      // Something else may have taken over the address meanwhile (pm2 started the service)
      const h = await checkHealth(target.origin, o.healthTimeoutMs);
      if (gen !== generation || !managed) return;
      if (h.answered && h.service === 'metacode-opencode') {
        managed = false;
        external = true;
        problem = notOurs(h);
        if (problem) log.warn('[opencode] ' + problem);
        else log.log('[opencode] Another copy of the AI service answers at ' + target.origin.replace(/^https?:\/\//, '') + ' now; MetaCode uses it and stops starting its own.');
        return;
      }
      restarts++;
      spawnChild();
    }, delay);
  }

  // target: { mode: 'auto'|'on'|'off', url (the service's …/v1 address), custom (OPENCODE_SERVICE_URL was set), token,
  //           dataDir (OPENCODE_SERVICE_DATA_DIR, resolved; default: as the service reads it from this process's env) }
  async function start(t) {
    await stop();
    const gen = ++generation;
    mode = t && t.mode ? t.mode : 'off';
    external = false;
    problem = null;
    lastExit = null;
    restarts = 0;
    failures = 0;
    muted = false;
    if (mode === 'off') return state();
    let url;
    try { url = new URL(t.url); } catch (e) { url = null; }
    if (!url || url.protocol !== 'http:') {
      if (mode === 'on' && url) log.warn('[opencode] OPENCODE_SERVICE_MANAGED=on, but MetaCode can only start the service at an http:// address on this machine.');
      return state();
    }
    if (mode === 'auto' && t.custom) return state();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isLoopback(host)) {
      if (mode === 'on') log.warn('[opencode] OPENCODE_SERVICE_MANAGED=on, but OPENCODE_SERVICE_URL isn\'t on this machine, so MetaCode doesn\'t start the service.');
      return state();
    }
    const port = Number(url.port) || 80;
    const dataDir = t.dataDir || serviceSettings(process.env).dataDir;
    target = { origin: url.origin, host, port, token: t.token || '', dataDir, home: homeId(dataDir) };
    const h = await checkHealth(target.origin, o.healthTimeoutMs);
    if (gen !== generation) return state();
    if (h.answered) {
      external = true;
      problem = notOurs(h);
      if (problem) log.warn('[opencode] ' + problem);
      return state();
    }
    if (!target.token) {
      problem = 'The AI service can\'t be started without its access token (see OPENCODE_SERVICE_TOKEN / OPENCODE_SERVICE_DATA_DIR).';
      log.warn('[opencode] ' + problem);
      return state();
    }
    managed = true;
    spawnChild();
    return state();
  }

  // Stops the child (if MetaCode runs one): SIGTERM, then SIGKILL after killAfterMs
  function stop() {
    generation++;
    managed = false;
    clearTimeout(restartTimer);
    restartTimer = null;
    clearTimeout(readyTimer);
    readyTimer = null;
    settleWaiters(false);
    const c = child;
    child = null;
    ready = false;
    if (exitHook) { process.removeListener('exit', exitHook); exitHook = null; }
    // No child (any more): the kill an earlier stop() started, so a second stop() also waits for it
    if (!c || c.exitCode !== null || c.signalCode !== null) return stopping;
    return (stopping = new Promise(resolve => {
      const killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, o.killAfterMs);
      c.once('exit', () => { clearTimeout(killTimer); resolve(); });
      try { c.kill('SIGTERM'); } catch (e) { clearTimeout(killTimer); resolve(); }
    }));
  }

  // Resolves true once the child answers GET /health, false if it stops or timeoutMs passes
  function whenReady(timeoutMs) {
    if (ready) return Promise.resolve(true);
    if (!managed) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer = null;
      const fn = v => { clearTimeout(timer); resolve(v); };
      waiters.push(fn);
      if (timeoutMs) timer = setTimeout(() => { waiters = waiters.filter(x => x !== fn); resolve(false); }, timeoutMs);
    });
  }

  // managed: MetaCode runs the service (starting: not answering yet); external: another copy answered
  function state() {
    return {
      mode, managed, external, running: !!child, ready, starting: managed && !ready,
      pid: child ? child.pid : null, startedAt: child && startedAt ? new Date(startedAt).toISOString() : null,
      restarts, lastExit, problem,
      host: target ? target.host : null, port: target ? target.port : null
    };
  }

  return { start, stop, whenReady, state };
}

module.exports = { createSupervisor, checkHealth, describeExit, PACKAGES_MISSING, SERVICE_SCRIPT };
