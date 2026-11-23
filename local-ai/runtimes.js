// The runtimes that can run AI models on a device, which of them work here, and where each one works.
//
// - Ollama on this machine: the primary runtime. The Model Store installs and manages its models.
// - An OpenAI-compatible server on this machine (llama.cpp's llama-server, LM Studio, Jan, LocalAI, vLLM): these
//   manage their own models. MetaCode finds them when asked (a short look at their usual ports) and says how
//   to add one; the AI service then uses it like any provider, with no key needed on 127.0.0.1.
// - Another MetaCode server (your PC, a Raspberry Pi, a VPS): how phones and tablets get local AI. The
//   browser uses that server's models, and nothing runs on the phone itself.
'use strict';

const KNOWN_SERVERS = [
  { id: 'llamacpp', name: 'llama.cpp (llama-server)', port: 8080 },
  { id: 'lmstudio', name: 'LM Studio', port: 1234 },
  { id: 'jan', name: 'Jan', port: 1337 },
  { id: 'vllm', name: 'vLLM', port: 8000 },
  { id: 'localai', name: 'LocalAI', port: 8081 },
];

// Where each runtime works (the compatibility matrix in the System page and docs/offline-first.md)
const MATRIX = [
  { id: 'windows', name: 'Windows 10/11 (x64, ARM64)', ollama: 'yes', openai: 'yes', server: 'yes' },
  { id: 'macos-arm', name: 'macOS on Apple Silicon', ollama: 'yes (Metal GPU)', openai: 'yes', server: 'yes' },
  { id: 'macos-intel', name: 'macOS on Intel', ollama: 'yes (CPU)', openai: 'yes', server: 'yes' },
  { id: 'linux-x64', name: 'Linux x64 (incl. mini PCs, old laptops)', ollama: 'yes (NVIDIA/AMD GPU or CPU)', openai: 'yes', server: 'yes' },
  { id: 'linux-arm64', name: 'Linux ARM64 (Raspberry Pi 4/5 with a 64-bit OS, ARM boards)', ollama: 'yes (CPU)', openai: 'yes (llama.cpp)', server: 'yes' },
  { id: 'linux-arm32', name: '32-bit ARM Linux (Pi Zero 2/3 with a 32-bit OS)', ollama: 'no (64-bit only)', openai: 'llama.cpp built from source', server: 'yes' },
  { id: 'chromeos', name: 'ChromeOS', ollama: 'inside its Linux container', openai: 'inside its Linux container', server: 'yes' },
  { id: 'android', name: 'Android phones and tablets', ollama: 'no official build (community builds in Termux)', openai: 'llama.cpp in Termux', server: 'yes' },
  { id: 'ios', name: 'iPhone and iPad', ollama: 'no', openai: 'no', server: 'yes' },
  { id: 'browser', name: 'Any browser, as an installed app (PWA)', ollama: '—', openai: '—', server: 'yes' },
];

// The row of the matrix for the machine MetaCode runs on
function platformId(hw) {
  const p = hw.os.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return hw.arch === 'arm64' ? 'macos-arm' : 'macos-intel';
  if (/android/i.test(hw.os.name || '')) return 'android';
  if (p === 'linux') return hw.arch === 'arm64' ? 'linux-arm64' : /^arm/.test(hw.arch) ? 'linux-arm32' : 'linux-x64';
  return null;
}

function createRuntimes(opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const ollama = opts.ollama;
  let lastScan = null;

  async function probe(url, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || 1500);
    try {
      const res = await fetchImpl(url, { signal: ac.signal });
      const j = await res.json().catch(() => null);
      return res.ok ? j : null;
    } catch (e) { return null; } finally { clearTimeout(t); }
  }

  // → [{ id, name, kind, status: 'running'|'not-running'|'unsupported', detail, models?, howTo? }]
  async function list(hw) {
    const pid = platformId(hw);
    const row = MATRIX.find(r => r.id === pid) || null;
    const out = [];
    let version = null;
    try { version = await ollama.version(); } catch (e) { version = null; }
    const ollamaSupported = !row || !/^no/.test(row.ollama);
    out.push({
      id: 'ollama', name: 'Ollama', kind: 'ollama', primary: true,
      status: version ? 'running' : ollamaSupported ? 'not-running' : 'unsupported',
      version, address: ollama.base(),
      detail: version ? 'Ollama ' + version + ' answers at ' + ollama.base() + '.'
        : ollamaSupported ? 'Ollama isn\'t answering at ' + ollama.base() + '. Install it from ollama.com (a separate download, about 1 GB with its GPU libraries) and start it; MetaCode finds it by itself.'
          : 'There is no Ollama for this system (' + (row ? row.name : hw.os.platform) + '). Use an OpenAI-compatible server instead, or another MetaCode server with Ollama.',
      canInstallModels: true,
    });
    for (const s of (lastScan || [])) out.push(s);
    return { platform: row, runtimes: out, scannedAt: lastScan ? lastScan.at : null };
  }

  // A short look for OpenAI-compatible servers on their usual ports (only when asked)
  async function scan() {
    const found = await Promise.all(KNOWN_SERVERS.map(async s => {
      const base = 'http://127.0.0.1:' + s.port + '/v1';
      const j = await probe(base + '/models', 1200);
      if (!j || !Array.isArray(j.data)) return null;
      const models = j.data.map(m => m && m.id).filter(Boolean).slice(0, 50);
      return {
        id: s.id, name: s.name, kind: 'openai-compatible', status: 'running', address: base, models,
        detail: s.name + ' answers at ' + base + ' with ' + models.length + ' model' + (models.length === 1 ? '' : 's') + '.',
        canInstallModels: false,
        howTo: 'To use it in MetaCode, add it to OPENCODE_CONFIG in .env, then click Reload .env: ' +
          JSON.stringify({ provider: { [s.id]: { npm: '@ai-sdk/openai-compatible', name: s.name, options: { baseURL: base } } } }),
      };
    }));
    lastScan = found.filter(Boolean);
    lastScan.at = new Date().toISOString();
    return lastScan;
  }

  return { list, scan };
}

module.exports = { createRuntimes, MATRIX, KNOWN_SERVERS, platformId };
