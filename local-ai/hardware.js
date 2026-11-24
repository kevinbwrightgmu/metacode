// What this device has, for the Model Store's recommendations: memory, CPU, architecture, GPU, free disk
// space (where Ollama keeps its models) and the operating system. Only cheap, local reads: no network, one short
// `nvidia-smi` call when an NVIDIA driver is present, and on a Mac `vm_stat`, `sw_vers` and `sysctl`. Cached
// for a minute.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
// A short command: → what it printed, or null when it failed or took longer than `ms`
const run = (cmd, args, ms) => new Promise(resolve => {
  execFile(cmd, args, { timeout: ms || 2000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
});
// This machine, as the functions below see it (the tests give another)
const SYSTEM = {
  platform: process.platform, arch: process.arch, release: () => os.release(), run,
  stat: p => fs.promises.stat(p), statfs: p => fs.promises.statfs(p), diskTimeoutMs: 2000,
};

// A Mac with Apple Silicon, also when MetaCode runs as an Intel program under Rosetta (next to an arm64 Ollama):
// → true, false, or null when it can't tell
async function appleSilicon(sys) {
  if (sys.platform !== 'darwin') return false;
  if (sys.arch === 'arm64') return true;
  const out = await sys.run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], 2000);
  return out === null ? null : out.trim() === '1';
}

// A Mac's usable memory from vm_stat: its free, inactive, speculative and purgeable pages; null when it can't tell
function vmStatAvailable(out, total) {
  const page = /page size of (\d+) bytes/.exec(out || '');
  const pages = what => { const m = new RegExp('^Pages ' + what + ':\\s+(\\d+)', 'm').exec(out || ''); return m ? Number(m[1]) : null; };
  const free = pages('free'), inactive = pages('inactive');
  if (!page || free === null || inactive === null) return null;
  return Math.min(total, (free + inactive + (pages('speculative') || 0) + (pages('purgeable') || 0)) * Number(page[1]));
}
// Available memory: Linux's MemAvailable (what can be used without swapping) is better than MemFree. On a Mac the
// free pages are a small part of what can be used (os.freemem() counts only those): see vmStatAvailable.
async function memory(sys) {
  sys = sys || SYSTEM;
  const total = os.totalmem();
  if (sys.platform === 'darwin') return { total, available: vmStatAvailable(await sys.run('/usr/bin/vm_stat', [], 2000), total) };
  let available = os.freemem();
  const info = sys.platform === 'linux' || sys.platform === 'android' ? read('/proc/meminfo') : null;
  const m = info && /MemAvailable:\s+(\d+) kB/.exec(info);
  if (m) available = Number(m[1]) * 1024;
  return { total, available };
}

// The macOS version for a Darwin release, when sw_vers can't say: Darwin 20–24 is macOS 11–15, Darwin 25 is
// macOS 26 (Tahoe) and so on; before Darwin 20, macOS 10.x
function macosFromDarwin(release) {
  const major = parseInt(release, 10);
  if (!(major >= 5)) return null;
  return major >= 25 ? String(major + 1) : major >= 20 ? String(major - 9) : '10.' + (major - 4);
}
async function operatingSystem(sys, env) {
  sys = sys || SYSTEM;
  env = env || process.env;
  const out = { platform: sys.platform, release: sys.release(), name: null, device: null };
  // (Node in Termux, on Android, calls its platform "android")
  if (sys.platform === 'linux' || sys.platform === 'android') {
    const rel = read('/etc/os-release');
    const pretty = rel && /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
    if (pretty) out.name = pretty[1];
    const model = read('/proc/device-tree/model') || read('/sys/firmware/devicetree/base/model');
    if (model) out.device = model.replace(/\0/g, '').trim();       // e.g. "Raspberry Pi 5 Model B Rev 1.0"
    if (/microsoft/i.test(out.release)) out.name = (out.name || 'Linux') + ' (WSL)';
    if (sys.platform === 'android' || env.ANDROID_ROOT || env.TERMUX_VERSION) out.name = 'Android (Termux)';
  } else if (sys.platform === 'darwin') {
    // (os.release() is the Darwin kernel's version: 24.1.0 on macOS 15.1)
    const v = String(await sys.run('/usr/bin/sw_vers', ['-productVersion'], 2000) || '').trim();
    const version = /^\d+(\.\d+){0,2}$/.test(v) ? v : macosFromDarwin(out.release);
    out.name = 'macOS' + (version ? ' ' + version : '');
  } else if (sys.platform === 'win32') out.name = (os.version ? os.version() : 'Windows') + ' (' + out.release + ')';
  return out;
}

async function gpus(sys, apple) {
  const found = [];
  if (apple) return [{ vendor: 'apple', name: 'Apple Silicon GPU (Metal)', memory: os.totalmem(), shared: true, usable: true }];
  if (sys.platform === 'linux') {
    // AMD and Intel through the kernel's DRM devices; NVIDIA below through its driver
    let cards = [];
    try { cards = fs.readdirSync('/sys/class/drm').filter(d => /^card\d+$/.test(d)); } catch (e) { /* none */ }
    for (const c of cards) {
      const vendor = (read('/sys/class/drm/' + c + '/device/vendor') || '').trim();
      if (vendor === '0x1002') {
        const vram = Number(read('/sys/class/drm/' + c + '/device/mem_info_vram_total')) || null;
        found.push({ vendor: 'amd', name: 'AMD GPU', memory: vram, usable: true });
      } else if (vendor === '0x8086') found.push({ vendor: 'intel', name: 'Intel integrated GPU', memory: null, usable: false });
    }
  }
  const nvidia = sys.platform === 'win32' || fs.existsSync('/proc/driver/nvidia') || fs.existsSync('/dev/nvidia0');
  if (!nvidia) return found;
  const out = await sys.run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 3000);
  String(out || '').trim().split(/\r?\n/).filter(Boolean).forEach(line => {
    const [name, mem] = line.split(',').map(s => s.trim());
    found.push({ vendor: 'nvidia', name, memory: Number(mem) ? Number(mem) * 1024 * 1024 : null, usable: true });
  });
  return found;
}

// Where Ollama keeps models: OLLAMA_MODELS_DIR (set it when Ollama's own OLLAMA_MODELS points elsewhere), then
// the usual places; the first that exists is measured
function modelsDirs(sys, env) {
  const home = os.homedir();
  const out = [];
  const set = String(env.OLLAMA_MODELS_DIR || env.OLLAMA_MODELS || '').trim();
  if (set && !/^(all|auto)$|,/.test(set) && /[\\/]/.test(set)) out.push(set);
  out.push(path.join(home, '.ollama', 'models'));
  if (sys.platform === 'linux') out.push('/usr/share/ollama/.ollama/models', '/var/lib/ollama/models');
  return out;
}
const unknownDisk = () => ({ path: null, free: null, total: null, ollamaDir: false });
async function measureDisk(sys, env, fallback) {
  try {
    const candidates = modelsDirs(sys, env).concat([fallback, os.homedir()]).filter(Boolean);
    for (const dir of candidates) {
      try {
        await sys.stat(dir);
        const st = await sys.statfs(dir);
        return { path: dir, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), ollamaDir: candidates.indexOf(dir) < candidates.length - 2 };
      } catch (e) { /* next */ }
    }
  } catch (e) { /* (no home folder) */ }
  return unknownDisk();
}

function createHardware(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const sys = Object.assign({}, SYSTEM, opts.system);
  let cached = null;
  // The free disk space, without blocking: a models folder on a network mount that hangs (an NFS server gone away)
  // would stop all of MetaCode, and an install. One look at a time: after 2 s the answer is "unknown", and while a
  // look still goes on (perhaps stuck for good) the last answer is given.
  let look = null, last = null;
  async function disk() {
    if (look && last) return last;
    if (!look) {
      const pending = measureDisk(sys, env, opts.dataDir).then(d => { last = d; return d; });
      look = pending;
      pending.then(() => { if (look === pending) look = null; });
    }
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(unknownDisk()), sys.diskTimeoutMs); });
    try { return await Promise.race([look, late]); } finally { clearTimeout(timer); }
  }
  async function detect(force) {
    if (!force && cached && Date.now() - cached.at < 60000) return cached.value;
    const cpus = os.cpus() || [];
    const apple = await appleSilicon(sys);
    const [system, mem, gpuList, space] = await Promise.all([operatingSystem(sys, env), memory(sys), gpus(sys, apple), disk()]);
    const value = {
      os: system,
      arch: sys.arch,
      appleSilicon: apple,
      cpu: { model: cpus[0] ? cpus[0].model.trim() : null, threads: os.availableParallelism ? os.availableParallelism() : cpus.length },
      memory: mem,
      gpus: gpuList,
      disk: space,
      node: process.version,
    };
    cached = { at: Date.now(), value };
    return value;
  }
  return { detect };
}

module.exports = { createHardware, memory, operatingSystem, vmStatAvailable, macosFromDarwin };
