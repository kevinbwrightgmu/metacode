// @ts-check
// ── Code sandbox: runs experiment code in isolation ───────────────────────────
// The only place where code from a Lab experiment (a coding rule written by
// the AI or the user) runs. It never runs in this process: each run starts a
// fresh child process from the scraper's sandbox (scraper/sandbox/
// sandbox-child.js for JavaScript/TypeScript in QuickJS, python-child.js for
// Python in Pyodide), with the same walls as the scraper's custom code:
//   • Node's permission model: the child reads only the engine's own files,
//     can't write, start programs or workers, or load native addons;
//   • code generation from strings switched off, a V8 heap cap, an empty
//     environment (no secrets), stdin/stdout closed;
//   • the code itself runs inside a WebAssembly engine (no Node, no require,
//     no process); the engine's memory is capped;
//   • when the host allows it (AI_LAB_SANDBOX_ISOLATION=auto|namespace), the
//     child also starts in its own user + network namespace (unshare: no
//     network interfaces at all) under prlimit (CPU seconds, no core files,
//     no file writes) — probed once, and reported per run as it really was.
//
// The child's only way out is the IPC channel. Records are pulled from here
// in batches (host call 'input.next', the only one answered); results, logs
// and progress come back as messages, and every limit is enforced again on
// this side: total result size, one result per record, progress rate, log
// lines, the final message's size. Any breach, the time limit, or a cancel
// SIGKILLs the child. Labels (reference, baseline) are never sent.
//
// Python is checked by a static policy (lab-prelude.py, Python's own `ast`)
// inside the sandbox before any user code runs; 'analyze' mode returns only
// those findings. JavaScript/TypeScript policy runs on the server
// (code-policy.js, acorn) before a run reaches this module.
//
// QuickJS's own memory limit doesn't count every allocation (large arrays
// and strings can pass it), so on Linux this side also reads the child's
// resident memory a few times a second and kills it above a cap (engine
// limit + the process's own overhead): that run fails with memory_limit.
//
// Limitation: without the namespace, the child process could open network
// connections if code escaped both the WebAssembly engine and the Python /
// QuickJS lock-down (Node's permission model doesn't cover sockets); without
// prlimit, a Python busy loop in a child orphaned by a server crash runs until
// it is killed (QuickJS stops at its own deadline).

const { fork, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { LabError, invalid } = require('./errors');
const paths = require('../scraper/sandbox/sandbox-paths');
const { logger } = require('../lib/log');

/** @typedef {import('../types/lab-experiments').CodeLanguage} CodeLanguage */
/** @typedef {import('../types/lab-experiments').SandboxInputRecord} SandboxInputRecord */
/** @typedef {import('../types/lab-experiments').SandboxVariable} SandboxVariable */
/** @typedef {import('../types/lab-experiments').SandboxOutcome} SandboxOutcome */
/** @typedef {import('../types/lab-experiments').IsolationReport} IsolationReport */
/** @typedef {import('../types/lab-experiments').PolicyFinding} PolicyFinding */
/** @typedef {import('../types/lab-experiments').RawRecordOutput} RawRecordOutput */
/**
 * What one run is asked to do. `records` are SandboxInputRecords (extra fields
 * are dropped before anything is sent); 'analyze' (Python only) runs the
 * static policy and nothing else.
 * @typedef {{ language: CodeLanguage, code: string, records?: SandboxInputRecord[], variable: SandboxVariable, mode?: 'run' | 'analyze' }} SandboxRunRequest
 */
/** @typedef {{ stream: 'stdout' | 'stderr', level: 'info' | 'warn' | 'error', text: string }} SandboxLogLine */
/**
 * @typedef {object} SandboxHooks
 * @property {AbortSignal} [signal] abort → SIGKILL → failure 'cancelled'
 * @property {(line: SandboxLogLine) => void} [onLog] the code's console / print output, as it comes
 * @property {(p: { done: number, total: number }) => void} [onProgress]
 * @property {(findings: PolicyFinding[]) => void} [onPolicy] Python: the static policy's findings (before any user code ran)
 * @property {(pid: number) => void} [onSpawn] the child's process id (diagnostics, tests)
 */
/**
 * Execution settings (labConfig().execution; env in docs/ai-lab.md).
 * @typedef {{ mode: 'sandbox' | 'off', isolation: 'auto' | 'namespace' | 'process', timeoutMs: number, memoryMb: number, pythonMemoryMb: number, maxOutputKb: number, maxRunning: number }} ExecutionSettings
 */
/** @typedef {{ available: boolean, unshare: string | null, prlimit: string | null, reason: string }} IsolationProbe */
/**
 * How a child is started: the script and its arguments with Node's flags, and
 * the OS wrapper (unshare/prlimit) when it is used.
 * @typedef {{ python: boolean, script: string, args: string[], execArgv: string[], cwd: string, env: Record<string, string>, wrapper: { command: string, args: string[] } | null, cpuSeconds: number | null }} SpawnPlan
 */

const log = logger('ai-lab');

// The policy's version and the standard-library modules a Python coding rule may import (lab-prelude.py
// receives the list) are defined once, in code-policy.js
const { POLICY_VERSION, PYTHON_ALLOWED_MODULES } = require('./code-policy');
/** @type {CodeLanguage[]} */
const LANGUAGES = ['javascript', 'typescript', 'python'];

const JS_PRELUDE = fs.readFileSync(path.join(__dirname, 'sandbox', 'lab-prelude.js'), 'utf8');
const PY_PRELUDE = fs.readFileSync(path.join(__dirname, 'sandbox', 'lab-prelude.py'), 'utf8');

/** @type {ExecutionSettings} */
const DEFAULTS = { mode: 'sandbox', isolation: 'auto', timeoutMs: 15000, memoryMb: 64, pythonMemoryMb: 256, maxOutputKb: 8192, maxRunning: 2 };
/** @type {Record<'timeoutMs' | 'memoryMb' | 'pythonMemoryMb' | 'maxOutputKb' | 'maxRunning', [number, number]>} */
const RANGES = { timeoutMs: [1000, 120000], memoryMb: [16, 512], pythonMemoryMb: [128, 1024], maxOutputKb: [256, 65536], maxRunning: [1, 16] };

const PY_BOOT_ALLOWANCE_MS = 60000;   // Pyodide's start-up, before the run's own limit begins
const JS_GRACE_MS = 2000;             // QuickJS interrupts itself at the limit; the hard kill follows
const PY_BOOT_CPU_SECONDS = 20;       // prlimit headroom for Pyodide's start-up (≈ 4 CPU-seconds measured)
const BATCH_RECORDS = 100;
const BATCH_BYTES = 256 * 1024;
const MAX_CODE_BYTES = 512 * 1024;    // a sanity cap; the policy's own limit (100 KB) is reported as a finding
const MAX_LOG_LINES = 2000;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_DONE_BYTES = 64 * 1024;
const MAX_PROGRESS_PER_SECOND = 20;
const MAX_FINDINGS = 200;
const MAX_WAITING = 100;
const EXIT_WAIT_MS = 3000;
const RSS_CHECK_MS = 200;             // how often the child's resident memory is read (Linux)
const SUBJECT = 'Your coding rule';
const NOT_AVAILABLE = Object.freeze({ name: 'SandboxError', type: 'not_available', message: 'Coding rules have no host services (no network, files or programs).' });
const BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];
/** @type {IsolationProbe} */
const NO_PROBE = Object.freeze({ available: false, unshare: null, prlimit: null, reason: 'not used (AI_LAB_SANDBOX_ISOLATION=process)' });

/**
 * The execution settings from the Lab's config, each checked against its
 * range (the spec defaults when config has none or a value is out of range).
 * @param {object | null | undefined} cfg labConfig()
 * @returns {ExecutionSettings}
 */
function executionSettings(cfg) {
  const c = /** @type {Record<string, any>} */ (cfg && typeof cfg === 'object' ? cfg : {});
  const raw = /** @type {Record<string, any>} */ (c.execution && typeof c.execution === 'object' ? c.execution : {});
  const num = /** @param {keyof typeof RANGES} key */ key => {
    const v = Number(raw[key]);
    const [min, max] = RANGES[key];
    return raw[key] !== undefined && raw[key] !== null && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : DEFAULTS[key];
  };
  return {
    mode: raw.mode === undefined ? DEFAULTS.mode : raw.mode === 'sandbox' ? 'sandbox' : 'off',
    isolation: raw.isolation === 'namespace' || raw.isolation === 'process' ? raw.isolation : 'auto',
    timeoutMs: num('timeoutMs'),
    memoryMb: num('memoryMb'),
    pythonMemoryMb: num('pythonMemoryMb'),
    maxOutputKb: num('maxOutputKb'),
    maxRunning: num('maxRunning')
  };
}

/** @type {Record<string, string>} */
const versions = {};
/** @param {string} pkg */
function packageVersion(pkg) {
  if (!(pkg in versions)) {
    try { versions[pkg] = String(JSON.parse(fs.readFileSync(path.join(paths.packageRoot(pkg), 'package.json'), 'utf8')).version || 'unknown'); } catch (e) { versions[pkg] = 'unknown'; }
  }
  return versions[pkg];
}

/** @param {CodeLanguage} language @returns {{ name: string, version: string }} */
function engineInfo(language) {
  return language === 'python' ? { name: 'Pyodide', version: packageVersion('pyodide') } : { name: 'QuickJS (quickjs-emscripten)', version: packageVersion('quickjs-emscripten') };
}

/** @param {number} timeoutMs @param {boolean} python */
const cpuSeconds = (timeoutMs, python) => Math.ceil(timeoutMs / 1000) + 10 + (python ? PY_BOOT_CPU_SECONDS : 0);

/** @param {number} kb */
const sizeText = kb => kb % 1024 === 0 ? (kb / 1024) + ' MB' : kb + ' KB';

/* ── OS isolation (unshare + prlimit) ──────────────────────────── */

/** @param {string} name @returns {string | null} */
function findBinary(name) {
  for (const dir of BIN_DIRS) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch (e) { /* not here */ }
  }
  return null;
}

/**
 * The wrapper command around a Node child: a new user + network namespace
 * (no interfaces, so no connections, not even to localhost), and with
 * prlimit a CPU-time cap, no core files and no file writes.
 * @param {IsolationProbe} probe
 * @param {number} cpu CPU seconds
 * @param {string[]} nodeArgs Node's flags, the script and its arguments
 * @returns {{ command: string, args: string[] }}
 */
function isolatedCommand(probe, cpu, nodeArgs) {
  const args = ['--user', '--map-root-user', '--net', '--'];
  if (probe.prlimit) args.push(probe.prlimit, '--cpu=' + cpu, '--core=0', '--fsize=0', '--');
  args.push(process.execPath, ...nodeArgs);
  return { command: /** @type {string} */ (probe.unshare), args };
}

// Started under the wrapper: tries to connect out and reports what happened.
const PROBE_SCRIPT = 'let sent=false;const s=require("net").connect({host:"1.1.1.1",port:80});' +
  'const r=c=>{if(sent)return;sent=true;try{s.destroy()}catch(e){}process.send({net:c},()=>process.exit(0))};' +
  's.on("connect",()=>r("connected"));s.on("error",e=>r(String(e&&e.code||"error")));setTimeout(()=>r("timeout"),3000);';

/**
 * @param {string} unshare
 * @param {string | null} prlimit
 * @returns {Promise<{ started: boolean, net: string | null, detail: string }>}
 */
function probeOnce(unshare, prlimit) {
  return new Promise(resolve => {
    const { command, args } = isolatedCommand({ available: false, unshare, prlimit, reason: '' }, 5, ['-e', PROBE_SCRIPT]);
    let stderr = '';
    /** @type {string | null} */
    let net = null;
    let done = false;
    /** @param {boolean} started @param {string} detail */
    const end = (started, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      resolve({ started, net, detail });
    };
    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
    } catch (err) {
      return resolve({ started: false, net: null, detail: String(err && /** @type {Error} */ (err).message) });
    }
    const timer = setTimeout(() => end(net !== null, 'no answer within 8 s'), 8000);
    if (child.stderr) child.stderr.on('data', d => { if (stderr.length < 1000) stderr += d.toString(); });
    child.on('message', msg => { net = msg && typeof msg === 'object' ? String(/** @type {any} */ (msg).net) : 'unknown'; end(true, ''); });
    child.on('error', err => end(false, String(err && err.message)));
    child.on('exit', (code, sig) => end(net !== null, 'exit ' + code + (sig ? ' ' + sig : '') + (stderr ? ': ' + stderr.trim().slice(0, 200) : '')));
  });
}

/** @type {Promise<IsolationProbe> | null} */
let probeCache = null;

/**
 * Whether children can be started in their own network namespace on this
 * host (probed once per server process, then cached). Available only if a
 * wrapped child started and its connection attempt failed for lack of a
 * network (ENETUNREACH / EACCES / EPERM).
 * @returns {Promise<IsolationProbe>}
 */
function probeIsolation() {
  if (!probeCache) {
    probeCache = (async () => {
      if (process.platform !== 'linux') return { available: false, unshare: null, prlimit: null, reason: 'OS network namespaces need Linux' };
      const unshare = findBinary('unshare');
      if (!unshare) return { available: false, unshare: null, prlimit: null, reason: 'unshare isn\'t installed' };
      let prlimit = findBinary('prlimit');
      let r = await probeOnce(unshare, prlimit);
      if (!r.started && prlimit) {
        const plain = await probeOnce(unshare, null);
        if (plain.started) { r = plain; prlimit = null; }
      }
      const available = r.started && ['ENETUNREACH', 'EACCES', 'EPERM'].includes(String(r.net));
      /** @type {IsolationProbe} */
      const probe = available
        ? { available, unshare, prlimit, reason: prlimit ? 'unshare + prlimit' : 'unshare (prlimit isn\'t installed: no CPU-time cap)' }
        : { available, unshare, prlimit: null, reason: r.started ? 'a namespaced process could still connect (' + r.net + ')' : 'unshare failed (' + r.detail + ')' };
      log.info('sandbox.isolation', { namespace: available, detail: probe.reason });
      return probe;
    })().catch(err => /** @type {IsolationProbe} */ ({ available: false, unshare: null, prlimit: null, reason: 'probe failed (' + String(err && err.message).slice(0, 200) + ')' }));
  }
  return probeCache;
}

/**
 * @param {CodeLanguage} language
 * @param {ExecutionSettings} s
 * @param {IsolationProbe} probe
 * @returns {IsolationReport}
 */
function isolationReport(language, s, probe) {
  const python = language === 'python';
  const namespace = s.isolation !== 'process' && probe.available;
  const cpu = namespace && probe.prlimit ? cpuSeconds(s.timeoutMs, python) : null;
  return {
    engine: python
      ? 'Pyodide ' + packageVersion('pyodide') + ' (CPython in WebAssembly) — network modules blocked'
      : 'QuickJS (WebAssembly) — no I/O APIs',
    process: 'separate process, Node permission model: reads only the engine\'s files, no writes, no child processes, no workers, no native addons',
    network: namespace ? 'none — separate network namespace' : 'not isolated by the OS; the engine has no network APIs',
    filesystem: 'no host files (engine files read-only)',
    environment: 'empty — no secrets',
    limits: 'time ' + (s.timeoutMs / 1000) + ' s' + (python ? ' after start-up' : '') +
      ', memory ' + (python ? s.pythonMemoryMb : s.memoryMb) + ' MB, output ' + sizeText(s.maxOutputKb) +
      (cpu ? ', CPU ' + cpu + ' s (prlimit)' : ''),
    networkNamespace: namespace
  };
}

/* ── Child processes ───────────────────────────────────────────── */

/**
 * The start plan for a child (scraper/sandbox children, Lab flags).
 * @param {CodeLanguage} language
 * @param {ExecutionSettings} s
 * @param {IsolationProbe} probe
 * @returns {SpawnPlan}
 */
function spawnPlan(language, s, probe) {
  const python = language === 'python';
  let script, args, dirs;
  if (python) {
    const engine = paths.pythonEnginePaths();
    script = paths.PY_CHILD;
    args = [engine.entry, engine.dir];          // no format library: the bridge has only call and send
    dirs = [paths.PY_CHILD, engine.root];
  } else {
    const engine = paths.sandboxReadablePaths();
    script = paths.CHILD;
    args = [engine.entry];
    dirs = engine.dirs;
  }
  const execArgv = [
    '--permission',
    ...dirs.map(p => '--allow-fs-read=' + p),
    '--max-old-space-size=' + (python ? 192 : s.memoryMb * 2 + 64),
    '--disallow-code-generation-from-strings',
    '--no-warnings'
  ];
  /** @type {Record<string, string>} */
  const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const useNamespace = s.isolation !== 'process' && probe.available;
  const cpu = useNamespace && probe.prlimit ? cpuSeconds(s.timeoutMs, python) : null;
  return {
    python, script, args, execArgv, cwd: path.dirname(script), env,
    wrapper: useNamespace ? isolatedCommand(probe, cpu || 0, [...execArgv, script, ...args]) : null,
    cpuSeconds: cpu
  };
}

/**
 * Starts a sandbox child as planned: fork() as the scraper does, or under the
 * OS wrapper with the same stdio (including the IPC channel; spawn adds
 * NODE_CHANNEL_FD to the otherwise empty environment).
 * @param {SpawnPlan} plan
 * @returns {import('child_process').ChildProcess}
 */
function spawnSandboxChild(plan) {
  if (plan.wrapper) {
    return spawn(plan.wrapper.command, plan.wrapper.args, { env: plan.env, cwd: plan.cwd, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
  }
  return fork(plan.script, plan.args, { execArgv: plan.execArgv, env: plan.env, cwd: plan.cwd, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
}

/* ── Requests, messages ────────────────────────────────────────── */

/** @param {unknown} v */
const str = v => v === undefined || v === null ? '' : String(v);
/** Control characters (other than tab) can't reach the terminal. @param {string} s */
const cleanText = s => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
/** @param {unknown} v @returns {number | null} */
const byteCount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

/**
 * Only the fields code under test may see (no reference, baseline or split).
 * @param {any} r
 * @returns {SandboxInputRecord}
 */
function inputRecord(r) {
  if (!r || typeof r !== 'object' || (typeof r.id !== 'string' && typeof r.id !== 'number')) throw invalid('Every sandbox record needs an id.');
  /** @type {SandboxInputRecord['meta']} */
  const meta = {};
  if (r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)) {
    for (const [k, v] of Object.entries(r.meta)) {
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) meta[k] = v;
    }
  }
  return { id: String(r.id), text: str(r.text), author: str(r.author), timestamp: str(r.timestamp), meta };
}

/**
 * @param {any} v
 * @returns {SandboxVariable}
 */
function inputVariable(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.codes)) throw invalid('The variable (with its codes) is missing.');
  return {
    id: str(v.id), name: str(v.name), description: str(v.description),
    codes: v.codes.map(/** @param {any} c */ c => ({ id: str(c && c.id), label: str(c && c.label), description: str(c && c.description) }))
  };
}

/**
 * @param {unknown} request
 * @returns {{ language: CodeLanguage, code: string, records: SandboxInputRecord[], variable: SandboxVariable, mode: 'run' | 'analyze' }}
 */
function checkRequest(request) {
  const r = /** @type {Record<string, any>} */ (request && typeof request === 'object' ? request : {});
  if (!LANGUAGES.includes(r.language)) throw invalid('The language must be javascript, typescript or python.');
  if (typeof r.code !== 'string' || !r.code.trim()) throw invalid('There is no code to run.');
  if (Buffer.byteLength(r.code) > MAX_CODE_BYTES) throw invalid('The code is too long to run.');
  const mode = r.mode === undefined ? 'run' : r.mode;
  if (mode !== 'run' && mode !== 'analyze') throw invalid('The sandbox mode must be run or analyze.');
  if (mode === 'analyze' && r.language !== 'python') throw invalid('Only Python is analyzed inside the sandbox (JavaScript and TypeScript are checked on the server).');
  if (mode === 'run' && !Array.isArray(r.records)) throw invalid('The sandbox records are missing.');
  /** @type {SandboxInputRecord[]} */
  const records = mode === 'run' ? r.records.map(inputRecord) : [];
  const ids = new Set(records.map(x => x.id));
  if (ids.size !== records.length) throw invalid('Sandbox record ids must be unique.');
  return { language: r.language, code: r.code, records, variable: inputVariable(r.variable), mode };
}

/**
 * @param {unknown} list
 * @returns {PolicyFinding[]}
 */
function cleanFindings(list) {
  if (!Array.isArray(list)) return [];
  /** @param {unknown} n */
  const pos = n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1e7 ? n : null;
  return list.slice(0, MAX_FINDINGS).filter(f => f && typeof f === 'object').map(/** @param {any} f */ f => ({
    rule: cleanText(str(f.rule)).slice(0, 40) || 'policy',
    severity: f.severity === 'warning' ? 'warning' : 'error',
    message: cleanText(str(f.message)).slice(0, 500),
    line: pos(f.line),
    column: pos(f.column),
    excerpt: cleanText(str(f.excerpt)).slice(0, 160)
  }));
}

/* ── The runner ────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig labConfig (its `execution` settings; the defaults when absent)
 * @param {(plan: SpawnPlan) => import('child_process').ChildProcess} [opts.spawnChild] how children start (tests wrap it)
 */
function createCodeSandbox(opts) {
  const getConfig = opts.getConfig;
  const spawnChild = opts.spawnChild || spawnSandboxChild;
  let running = 0;
  let maxRunning = DEFAULTS.maxRunning;
  /** @type {{ grant: () => void }[]} */
  const waiting = [];

  const settings = () => executionSettings(getConfig());

  /**
   * Whether this server can run code in the language at all.
   * @param {string} language
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function supported(language) {
    if (!LANGUAGES.includes(/** @type {CodeLanguage} */ (language))) return { ok: false, reason: 'Coding rules can be written in JavaScript, TypeScript or Python.' };
    // (the stable --permission flag the children start with arrived in Node 22.13; 22.0–22.12 only have --experimental-permission)
    if (!paths.permissionModelAvailable()) return { ok: false, reason: 'Running coding rules needs Node.js 22.13 or newer on the MetaCode server (for Node\'s --permission flag). Update Node.js.' };
    if (language === 'python') {
      if (!paths.moduleHooksAvailable()) return { ok: false, reason: 'Python coding rules need Node.js 22.15 or newer on the MetaCode server. Use JavaScript, or update Node.js.' };
      try { paths.pythonEnginePaths(); } catch (e) { return { ok: false, reason: 'The Python sandbox (Pyodide) isn\'t installed. Run "npm install" and restart MetaCode.' }; }
      return { ok: true };
    }
    try { paths.sandboxReadablePaths(); } catch (e) { return { ok: false, reason: 'The JavaScript sandbox (QuickJS) isn\'t installed. Run "npm install" and restart MetaCode.' }; }
    if (language === 'typescript' && !paths.typeScriptAvailable()) return { ok: false, reason: 'TypeScript needs Node.js 22.13 or newer on the MetaCode server. Use JavaScript.' };
    return { ok: true };
  }

  /**
   * How a run in this language is (or would now be) isolated.
   * @param {CodeLanguage} [language] default javascript
   * @returns {Promise<IsolationReport>}
   */
  async function isolation(language) {
    const s = settings();
    const probe = s.isolation === 'process' ? NO_PROBE : await probeIsolation();
    return isolationReport(language === 'python' || language === 'typescript' ? language : 'javascript', s, probe);
  }

  // Server-wide cap on children (AI_LAB_MAX_RUNNING_EXECUTIONS): later runs wait their turn.
  const pump = () => { while (waiting.length && running < maxRunning) { const next = waiting.shift(); if (next) next.grant(); } };
  /** @param {AbortSignal | undefined} signal @returns {Promise<boolean>} false = cancelled while waiting */
  const acquire = signal => new Promise((resolve, reject) => {
    if (running < maxRunning && !waiting.length) { running++; return resolve(true); }
    if (waiting.length >= MAX_WAITING) return reject(new LabError('sandbox_busy', 'The sandbox is busy with other runs. Try again in a minute.', { status: 503, retryAfterSeconds: 30 }));
    const onAbort = () => {
      const i = waiting.indexOf(entry);
      if (i !== -1) waiting.splice(i, 1);
      resolve(false);
    };
    const entry = { grant: () => { if (signal) signal.removeEventListener('abort', onAbort); running++; resolve(true); } };
    waiting.push(entry);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
  const release = () => { running = Math.max(0, running - 1); pump(); };

  /**
   * Runs code in a fresh sandbox child. Never throws for problems of the
   * code (they come back as `failure`); throws LabError for host faults
   * (execution off, engine missing, namespace required but unavailable, the
   * process couldn't start) and for malformed requests.
   * @param {SandboxRunRequest} request
   * @param {SandboxHooks} [hooks]
   * @returns {Promise<SandboxOutcome>}
   */
  async function run(request, hooks) {
    const h = hooks || {};
    const s = settings();
    if (s.mode !== 'sandbox') throw new LabError('execution_disabled', 'Running code is switched off on this server (AI_LAB_CODE_EXECUTION isn\'t "sandbox").', { status: 503 });
    const req = checkRequest(request);
    const support = supported(req.language);
    if (!support.ok) throw new LabError('not_available', support.reason, { status: 503 });
    const probe = s.isolation === 'process' ? NO_PROBE : await probeIsolation();
    if (s.isolation === 'namespace' && !probe.available) {
      throw new LabError('isolation_unavailable', 'This server runs code only inside an OS network namespace (AI_LAB_SANDBOX_ISOLATION=namespace), and it can\'t create one here: ' + probe.reason + '.', { status: 503 });
    }
    const report = isolationReport(req.language, s, probe);
    const engine = engineInfo(req.language);
    /** @param {{ type: string, message: string }} failure @returns {SandboxOutcome} */
    const notStarted = failure => ({
      ok: false, outputs: [], failure, policy: null, durationMs: 0, bootMs: 0,
      resources: { rssBytes: null, engineMemoryBytes: null, outputBytes: 0, logBytes: 0 }, isolation: report, engine
    });
    const cancelled = { type: 'cancelled', message: 'The run was cancelled.' };
    if (h.signal && h.signal.aborted) return notStarted(cancelled);
    maxRunning = s.maxRunning;
    pump();
    if (!(await acquire(h.signal))) return notStarted(cancelled);
    try {
      if (h.signal && h.signal.aborted) return notStarted(cancelled);
      return await execute(req, s, spawnPlan(req.language, s, probe), report, engine, h);
    } finally {
      release();
    }
  }

  /**
   * @param {ReturnType<typeof checkRequest>} req
   * @param {ExecutionSettings} s
   * @param {SpawnPlan} plan
   * @param {IsolationReport} report
   * @param {{ name: string, version: string }} engine
   * @param {SandboxHooks} h
   * @returns {Promise<SandboxOutcome>}
   */
  function execute(req, s, plan, report, engine, h) {
    return new Promise((resolve, reject) => {
      const python = plan.python;
      const signal = h.signal;
      const records = req.records;
      const total = records.length;
      const maxOutputBytes = s.maxOutputKb * 1024;
      const timeoutMessage = SUBJECT + ' ran longer than the ' + (s.timeoutMs / 1000) + '-second limit and was stopped.';
      const memoryMessage = SUBJECT + ' used more memory than the sandbox allows (' + (python ? s.pythonMemoryMb : s.memoryMb) + ' MB) and was stopped.';

      /** @type {import('child_process').ChildProcess} */
      let child;
      try {
        child = spawnChild(plan);
      } catch (err) {
        return reject(new LabError('sandbox_error', 'The sandbox process couldn\'t be started.', { status: 500 }));
      }
      const spawnedAt = Date.now();
      /** @type {number | null} */ let firstMessageAt = null;
      /** @type {number | null} */ let startedAt = null;
      /** @type {RawRecordOutput[]} */
      const outputs = [];
      const seen = new Set();
      let outputBytes = 0;
      let logLines = 0;
      let logBytes = 0;
      let logCapped = false;
      /** @type {PolicyFinding[] | null} */
      let policy = null;
      let progressWindow = 0;
      let progressCount = 0;
      let progressDone = -1;
      /** @type {number | null} */
      let progressHeld = null;   // the latest count dropped by the rate limit, delivered later
      let calls = 0;
      let cursor = 0;
      let stderr = '';
      let settled = false;
      /** @type {{ rssBytes: number | null, engineMemoryBytes: number | null } | null} */
      let stats = null;
      /** @type {NodeJS.Timeout} */
      let timer;
      /** @type {NodeJS.Timeout | null} */
      let rssWatch = null;
      let peakRss = 0;

      /** @param {() => void} fn */
      const safely = fn => { try { fn(); } catch (e) { /* a hook's own failure doesn't stop the run */ } };
      /** @param {SandboxLogLine} line */
      const emitLog = line => safely(() => { if (h.onLog) h.onLog(line); });

      // The single exit path: stop the clock, kill the child, report once it is gone.
      /** @param {{ type: string, message: string } | null} failure */
      const finish = failure => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rssWatch) clearInterval(rssWatch);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!failure && progressHeld !== null) deliverProgress(progressHeld);
        const endedAt = Date.now();
        const bootMs = python ? (startedAt || endedAt) - spawnedAt : (firstMessageAt ? firstMessageAt - spawnedAt : 0);
        /** @type {SandboxOutcome} */
        const outcome = {
          ok: !failure,
          outputs: req.mode === 'analyze' ? [] : outputs,
          failure,
          policy,
          durationMs: Math.max(0, endedAt - spawnedAt - bootMs),
          bootMs,
          resources: { rssBytes: stats && stats.rssBytes !== null ? stats.rssBytes : peakRss || null, engineMemoryBytes: stats ? stats.engineMemoryBytes : null, outputBytes, logBytes },
          isolation: report,
          engine
        };
        const gone = () => resolve(outcome);
        if (child.exitCode !== null || child.signalCode !== null) return gone();
        const wait = setTimeout(gone, EXIT_WAIT_MS);
        child.once('exit', () => { clearTimeout(wait); gone(); });
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      };
      /** @param {string} message */
      const contractBroken = message => finish({ type: 'contract_error', message });

      const onTimeout = () => {
        if (python && startedAt === null) return finish({ type: 'sandbox_error', message: 'Python didn\'t start within ' + (PY_BOOT_ALLOWANCE_MS / 1000) + ' seconds (the server may be busy). Try again.' });
        finish({ type: 'timeout', message: timeoutMessage });
      };
      // JavaScript: QuickJS interrupts itself at the limit; this is the hard
      // backstop. Python: Pyodide gets time to start; the limit counts from 'started'.
      timer = setTimeout(onTimeout, python ? PY_BOOT_ALLOWANCE_MS : s.timeoutMs + JS_GRACE_MS);
      const onAbort = () => finish({ type: 'cancelled', message: 'The run was cancelled.' });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (typeof child.pid === 'number') {
        const pid = child.pid;
        safely(() => { if (h.onSpawn) h.onSpawn(pid); });
        // Resident memory cap: the engine's limit plus the process's own overhead.
        const rssCap = (python ? s.pythonMemoryMb + 320 : s.memoryMb * 2 + 256) * 1024 * 1024;
        if (process.platform === 'linux') {
          rssWatch = setInterval(() => {
            fs.readFile('/proc/' + pid + '/status', 'utf8', (err, text) => {
              if (err || settled) return;
              const m = /VmRSS:\s+(\d+) kB/.exec(text);
              const rss = m ? Number(m[1]) * 1024 : 0;
              if (rss > peakRss) peakRss = rss;
              if (rss > rssCap) finish({ type: 'memory_limit', message: memoryMessage });
            });
          }, RSS_CHECK_MS);
          rssWatch.unref();
        }
      }

      if (child.stderr) child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rssWatch) clearInterval(rssWatch);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { child.kill('SIGKILL'); } catch (e) { /* not started */ }
        log.warn('sandbox.spawn_failed', { detail: String(err && err.message).slice(0, 200) });
        reject(new LabError('sandbox_error', 'The sandbox process couldn\'t be started.', { status: 500 }));
      });
      child.on('exit', (code, sig) => {
        if (settled) return;
        if (sig === 'SIGXCPU') return finish({ type: 'timeout', message: SUBJECT + ' used more CPU time than the sandbox allows (' + plan.cpuSeconds + ' s) and was stopped.' });
        const blocked = stderr.match(/"([^"]{1,60})" is not available in the MetaCode sandbox|(\w{1,40}) is not available in the MetaCode sandbox/);
        if (blocked) {
          return finish({ type: 'blocked_operation', message: SUBJECT + ' tried to use something the sandbox doesn\'t allow (' + (blocked[1] || blocked[2]) + '). Coding rules have no network, files or programs.' });
        }
        if (/heap out of memory|Allocation failed/i.test(stderr)) return finish({ type: 'memory_limit', message: memoryMessage });
        finish({ type: 'sandbox_error', message: 'The sandbox stopped unexpectedly before your coding rule finished (exit ' + code + (sig ? ', ' + sig : '') + ').' });
      });

      /** @param {number} id @param {boolean} ok @param {unknown} payload */
      const reply = (id, ok, payload) => {
        if (settled || !child.connected) return;
        // (With a callback, a closed channel isn't an 'error' event; the exit is reported instead.)
        try { child.send(ok ? { type: 'reply', id, ok: true, value: payload } : { type: 'reply', id, ok: false, error: payload }, () => {}); } catch (e) { /* channel closed */ }
      };

      // Records, never all at once: ≤ 100 per batch and ≤ 256 KB of JSON (at least one).
      /** @type {string | null} */
      let carried = null;   // the record that didn't fit in the last batch
      const nextBatch = () => {
        const parts = [];
        let bytes = 2;
        while (cursor < total && parts.length < BATCH_RECORDS) {
          const json = carried || JSON.stringify(records[cursor]);
          carried = null;
          const size = Buffer.byteLength(json) + 1;
          if (parts.length && bytes + size > BATCH_BYTES) { carried = json; break; }
          parts.push(json);
          bytes += size;
          cursor++;
        }
        return '{"records":[' + parts.join(',') + '],"done":' + (cursor >= total) + '}';
      };

      /** @param {any} msg */
      const onCall = msg => {
        if (++calls > total + 50) return contractBroken('The sandbox asked for records more often than there are records; the run was stopped.');
        if (typeof msg.id !== 'number') return;
        if (msg.name !== 'input.next') return reply(msg.id, false, NOT_AVAILABLE);
        reply(msg.id, true, nextBatch());
      };

      /** @param {unknown} items */
      const onEmit = items => {
        if (!Array.isArray(items)) return contractBroken('The sandbox sent results in the wrong shape; the run was stopped.');
        outputBytes += Buffer.byteLength(JSON.stringify(items));
        if (outputBytes > maxOutputBytes) {
          return finish({ type: 'output_too_large', message: SUBJECT + '\'s results passed the ' + sizeText(s.maxOutputKb) + ' limit (AI_LAB_SANDBOX_MAX_OUTPUT_KB) and the run was stopped.' });
        }
        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || item.id.length > 200) {
            return contractBroken('The sandbox sent a result without a record id; the run was stopped.');
          }
          if (seen.has(item.id)) return contractBroken('The sandbox sent two results for record “' + item.id.slice(0, 120) + '”; the run was stopped.');
          if (outputs.length >= total) return contractBroken('The sandbox sent more results than there are records; the run was stopped.');
          seen.add(item.id);
          /** @type {RawRecordOutput} */
          const out = { id: item.id };
          if ('out' in item) out.out = item.out;
          if (item.error !== undefined && item.error !== null) out.error = cleanText(String(item.error)).slice(0, 4000);
          if (typeof item.ms === 'number' && Number.isFinite(item.ms) && item.ms >= 0) out.ms = item.ms;
          outputs.push(out);
        }
      };

      /** @param {any} msg */
      const onLogMessage = msg => {
        if (logCapped) return;
        const level = msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info';
        const text = cleanText(str(msg.message).slice(0, MAX_LINE_CHARS));
        const bytes = Buffer.byteLength(text);
        if (logLines >= MAX_LOG_LINES || logBytes + bytes > MAX_LOG_BYTES) {
          logCapped = true;
          return emitLog({ stream: 'stderr', level: 'warn', text: 'Log limit reached (' + MAX_LOG_LINES + ' lines or ' + (MAX_LOG_BYTES / 1024) + ' KB); further output from this run is dropped.' });
        }
        logLines++;
        logBytes += bytes;
        emitLog({ stream: level === 'info' ? 'stdout' : 'stderr', level, text });
      };

      /** @param {number} done */
      const deliverProgress = done => {
        progressHeld = null;
        if (done <= progressDone) return;
        progressDone = done;
        safely(() => { if (h.onProgress) h.onProgress({ done, total }); });
      };

      /** @param {any} patch */
      const onProgressMessage = patch => {
        if (!patch || typeof patch !== 'object') return;
        const done = typeof patch.done === 'number' && Number.isFinite(patch.done) ? Math.max(0, Math.min(total, Math.floor(patch.done))) : null;
        const now = Date.now();
        if (now - progressWindow >= 1000) { progressWindow = now; progressCount = 0; }
        if (++progressCount > MAX_PROGRESS_PER_SECOND) {
          if (done !== null) progressHeld = done;
          return;
        }
        if (Array.isArray(patch.policy)) {
          // Only the analyzer's report counts: it is sent before any user code runs.
          if (!python || policy) return;
          policy = cleanFindings(patch.policy);
          const findings = policy;
          return safely(() => { if (h.onPolicy) h.onPolicy(findings); });
        }
        if (done !== null) deliverProgress(done);
      };

      /** @param {any} msg */
      const onDone = msg => {
        let size = Infinity;
        try { size = Buffer.byteLength(JSON.stringify(msg)); } catch (e) { /* unmeasurable */ }
        if (size > MAX_DONE_BYTES) return contractBroken('The sandbox\'s final message was too large; the run was stopped.');
        const st = msg.stats && typeof msg.stats === 'object' ? msg.stats : {};
        stats = { rssBytes: byteCount(st.rssBytes), engineMemoryBytes: byteCount(st.engineMemoryBytes) };
        if (python && !policy) {
          // The analyzer always reports first; without its findings nothing is known to be checked.
          return finish({ type: 'sandbox_error', message: 'The Python policy check didn\'t report back; the results are discarded.' });
        }
        finish(null);
      };

      /** @param {any} e */
      const onError = e => {
        const err = e && typeof e === 'object' ? e : {};
        const type = typeof err.type === 'string' ? err.type : 'custom_code_error';
        const message = cleanText(str(err.message)).slice(0, 4000) || SUBJECT + ' failed.';
        switch (type) {
          case 'custom_code_timeout': case 'timeout':
            return finish({ type: 'timeout', message: timeoutMessage });
          case 'custom_code_memory': case 'memory_limit':
            return finish({ type: 'memory_limit', message: python && startedAt === null ? 'Python needs more memory than AI_LAB_SANDBOX_PYTHON_MEMORY_MB (' + s.pythonMemoryMb + ' MB) allows to start.' : memoryMessage });
          case 'policy_blocked': case 'contract_error': case 'output_too_large': case 'sandbox_error':
            return finish({ type, message });
          case 'not_available': case 'blocked_operation':
            return finish({ type: 'blocked_operation', message: SUBJECT + ' tried to use a host service; coding rules have no network, files or programs.' });
          default:
            // The JavaScript harness throws this when classify is missing.
            if (!python && message.includes('Define a function classify(record, variable)')) {
              return finish({ type: 'contract_error', message: 'Define a function classify(record, variable) that returns a code id, { code, confidence, reason } or null.' });
            }
            return finish({ type: 'runtime_error', message });
        }
      };

      child.on('message', msg => {
        if (settled || !msg || typeof msg !== 'object') return;
        const m = /** @type {any} */ (msg);
        if (firstMessageAt === null) firstMessageAt = Date.now();
        switch (m.type) {
          case 'started':
            if (python && startedAt === null) {
              startedAt = Date.now();
              clearTimeout(timer);
              timer = setTimeout(onTimeout, s.timeoutMs);
            }
            break;
          case 'call': onCall(m); break;
          case 'emit': onEmit(m.records); break;
          case 'log': onLogMessage(m); break;
          case 'progress': onProgressMessage(m.patch); break;
          case 'done': onDone(m); break;
          case 'error': onError(m.error); break;
          default: break;
        }
      });

      if (signal && signal.aborted) return onAbort();
      try {
        child.send({
          type: 'start',
          code: req.code,
          language: req.language,
          preludeSource: python ? PY_PRELUDE : JS_PRELUDE,
          formatSource: '',
          subject: SUBJECT,
          filename: req.language === 'typescript' ? 'rule.ts' : python ? 'rule.py' : 'rule.js',
          bindNames: ['classify'],
          limits: { memoryBytes: (python ? s.pythonMemoryMb : s.memoryMb) * 1024 * 1024, timeoutMs: s.timeoutMs },
          init: python
            ? { variable: req.variable, total, mode: req.mode, allowedModules: PYTHON_ALLOWED_MODULES.slice() }
            : { variable: req.variable, total, mode: req.mode }
        }, err => { if (err) finish({ type: 'sandbox_error', message: 'The sandbox process couldn\'t be started.' }); });
      } catch (err) {
        finish({ type: 'sandbox_error', message: 'The sandbox process couldn\'t be started.' });
      }
    });
  }

  /** @returns {{ running: number, waiting: number }} */
  function stats() {
    return { running, waiting: waiting.length };
  }

  return { supported, isolation, run, stats };
}

module.exports = {
  createCodeSandbox, executionSettings, probeIsolation, isolatedCommand, spawnSandboxChild,
  POLICY_VERSION, PYTHON_ALLOWED_MODULES, LANGUAGES
};
