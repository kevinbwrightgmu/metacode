// What this device has, for the Model Store's recommendations: memory, CPU, architecture, GPU, free disk
// space (where Ollama keeps its models) and the operating system. Only cheap, local reads: no network, and
// one short `nvidia-smi` call when an NVIDIA driver is present. Cached for a minute.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };

// Available memory: Linux's MemAvailable (what can be used without swapping) is better than MemFree
function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  const info = process.platform === 'linux' ? read('/proc/meminfo') : null;
  const m = info && /MemAvailable:\s+(\d+) kB/.exec(info);
  if (m) available = Number(m[1]) * 1024;
  return { total, available };
}

function operatingSystem() {
  const out = { platform: process.platform, release: os.release(), name: null, device: null };
  if (process.platform === 'linux') {
    const rel = read('/etc/os-release');
    const pretty = rel && /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
    if (pretty) out.name = pretty[1];
    const model = read('/proc/device-tree/model') || read('/sys/firmware/devicetree/base/model');
    if (model) out.device = model.replace(/\0/g, '').trim();       // e.g. "Raspberry Pi 5 Model B Rev 1.0"
    if (/microsoft/i.test(os.release())) out.name = (out.name || 'Linux') + ' (WSL)';
    if (process.env.ANDROID_ROOT || process.env.TERMUX_VERSION) out.name = 'Android (Termux)';
  } else if (process.platform === 'darwin') out.name = 'macOS ' + os.release();
  else if (process.platform === 'win32') out.name = (os.version ? os.version() : 'Windows') + ' (' + os.release() + ')';
  return out;
}

function gpus() {
  return new Promise(resolve => {
    const found = [];
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      found.push({ vendor: 'apple', name: 'Apple Silicon GPU (Metal)', memory: os.totalmem(), shared: true, usable: true });
      return resolve(found);
    }
    if (process.platform === 'linux') {
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
    const nvidia = process.platform === 'win32' || fs.existsSync('/proc/driver/nvidia') || fs.existsSync('/dev/nvidia0');
    if (!nvidia) return resolve(found);
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        String(stdout).trim().split(/\r?\n/).filter(Boolean).forEach(line => {
          const [name, mem] = line.split(',').map(s => s.trim());
          found.push({ vendor: 'nvidia', name, memory: Number(mem) ? Number(mem) * 1024 * 1024 : null, usable: true });
        });
      }
      resolve(found);
    });
  });
}

// Where Ollama keeps models: OLLAMA_MODELS_DIR (set it when Ollama's own OLLAMA_MODELS points elsewhere), then
// the usual places; the first that exists is measured
function modelsDirs(env) {
  const home = os.homedir();
  const out = [];
  const set = String(env.OLLAMA_MODELS_DIR || env.OLLAMA_MODELS || '').trim();
  if (set && !/^(all|auto)$|,/.test(set) && /[\\/]/.test(set)) out.push(set);
  out.push(path.join(home, '.ollama', 'models'));
  if (process.platform === 'linux') out.push('/usr/share/ollama/.ollama/models', '/var/lib/ollama/models');
  return out;
}
function disk(env, fallback) {
  const candidates = modelsDirs(env).concat([fallback, os.homedir()]).filter(Boolean);
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const st = fs.statfsSync(dir);
      return { path: dir, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), ollamaDir: candidates.indexOf(dir) < candidates.length - 2 };
    } catch (e) { /* next */ }
  }
  return { path: null, free: null, total: null, ollamaDir: false };
}

function createHardware(opts) {
  const env = (opts && opts.env) || process.env;
  let cached = null;
  async function detect(force) {
    if (!force && cached && Date.now() - cached.at < 60000) return cached.value;
    const cpus = os.cpus() || [];
    const value = {
      os: operatingSystem(),
      arch: process.arch,
      cpu: { model: cpus[0] ? cpus[0].model.trim() : null, threads: os.availableParallelism ? os.availableParallelism() : cpus.length },
      memory: memory(),
      gpus: await gpus(),
      disk: disk(env, opts && opts.dataDir),
      node: process.version,
    };
    cached = { at: Date.now(), value };
    return value;
  }
  return { detect };
}

module.exports = { createHardware, memory, operatingSystem };
