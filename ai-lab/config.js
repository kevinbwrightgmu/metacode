// @ts-check
// ── AI Coding Lab settings (from the environment) ─────────────────────────────
// Read on every use, so Settings → Reload .env applies changes. Bad values
// are ignored with a warning, never a crash.
//
//   AI_LAB_ENABLED              true (default) | false — the whole Lab
//   AI_LAB_DATA_DIR             where projects, profiles, documents, datasets and
//                               evaluation results are kept (default lab-data/)
//   AI_LAB_WITHOUT_ACCOUNTS     false (default). With accounts off there are no
//                               plans, so the Lab (Ultra only) is closed — unless
//                               this is true (a private, single-user server)
//   AI_LAB_DEFAULT_CONTEXT_TOKENS  context budget for models whose window isn't
//                               known (default 16000)
//   AI_LAB_MAX_DOC_KB           largest knowledge document (default 1024)
//   AI_LAB_MAX_DOCS_PER_PROJECT default 200
//   AI_LAB_MAX_RUNNING_EVALS    evaluation runs at once, server-wide (default 2)
//   AI_LAB_PRICING_FILE         JSON price list for cost estimates (docs/ai-lab.md);
//                               without one, costs are shown as unknown
//   AI_LAB_CODE_EXECUTION       sandbox (default) | off. sandbox: code experiments
//                               (coding rules) run, when the user clicks Run, in
//                               the isolated sandbox (ai-lab/code-sandbox.js);
//                               off: nothing runs (runs answer 503). Workbench and
//                               evaluation answers are never run either way.
//   AI_LAB_SANDBOX_ISOLATION    auto (default) | namespace | process — auto: an OS
//                               network namespace (unshare) and process limits
//                               (prlimit) when the host allows them; namespace:
//                               require them (runs fail 503 without); process: never
//   AI_LAB_SANDBOX_TIMEOUT_MS   per run, after Python's start-up (default 15000; 1000–120000)
//   AI_LAB_SANDBOX_MEMORY_MB    QuickJS memory, JavaScript/TypeScript (default 64; 16–512)
//   AI_LAB_SANDBOX_PYTHON_MEMORY_MB  Pyodide memory cap (default 256; 128–1024)
//   AI_LAB_SANDBOX_MAX_OUTPUT_KB  results + logs per run (default 8192; 256–65536)
//   AI_LAB_MAX_RUNNING_EXECUTIONS  sandbox runs at once, server-wide (default 2; 1–16)
//
//   OpenAI-compatible provider (optional, operator-configured; SECRET key):
//   AI_LAB_OPENAI_API_KEY       sk-…
//   AI_LAB_OPENAI_BASE_URL      default https://api.openai.com/v1 (https, or localhost for tests)
//   AI_LAB_OPENAI_MODELS        comma list to offer (default: the provider's own /models list)
//   AI_LAB_FINE_TUNING          off (default) | on — fine-tuning through that provider (paid)
//   AI_LAB_FINE_TUNE_MODELS     base models offered for fine-tuning (comma list)

const path = require('path');

const isLocal = /** @param {string} host */ host => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function labConfig(env) {
  const e = env || process.env;
  /** @type {string[]} */
  const warnings = [];
  const flag = /** @param {string} name @param {boolean} dflt */ (name, dflt) => {
    const raw = String(e[name] || '').trim().toLowerCase();
    if (!raw) return dflt;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    warnings.push(name + ' must be on or off; using ' + (dflt ? 'on' : 'off') + '.');
    return dflt;
  };
  const int = /** @param {string} name @param {number} dflt @param {number} min @param {number} max */ (name, dflt, min, max) => {
    const raw = String(e[name] || '').trim();
    if (!raw) return dflt;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    warnings.push(name + ' must be a whole number from ' + min + ' to ' + max + '; using ' + dflt + '.');
    return dflt;
  };

  /** @type {<T extends string>(name: string, values: T[], dflt: T, otherwise: T) => T} */
  const choice = (name, values, dflt, otherwise) => {
    const raw = String(e[name] || '').trim().toLowerCase();
    if (!raw) return dflt;
    const hit = values.find(v => v === raw);
    if (hit) return hit;
    warnings.push(name + ' must be ' + values.slice(0, -1).join(', ') + ' or ' + values[values.length - 1] + '; using ' + otherwise + '.');
    return otherwise;
  };

  // Code experiments: coding rules run only in the isolated sandbox, only when the user clicks Run
  const codeExecution = choice('AI_LAB_CODE_EXECUTION', /** @type {('sandbox' | 'off')[]} */ (['sandbox', 'off']), 'sandbox', 'off');
  const execution = {
    mode: codeExecution,
    // (a value that isn't one of these is read as the strictest, so a typo never weakens isolation)
    isolation: choice('AI_LAB_SANDBOX_ISOLATION', /** @type {('auto' | 'namespace' | 'process')[]} */ (['auto', 'namespace', 'process']), 'auto', 'namespace'),
    timeoutMs: int('AI_LAB_SANDBOX_TIMEOUT_MS', 15000, 1000, 120000),
    memoryMb: int('AI_LAB_SANDBOX_MEMORY_MB', 64, 16, 512),
    pythonMemoryMb: int('AI_LAB_SANDBOX_PYTHON_MEMORY_MB', 256, 128, 1024),
    maxOutputKb: int('AI_LAB_SANDBOX_MAX_OUTPUT_KB', 8192, 256, 65536),
    maxRunning: int('AI_LAB_MAX_RUNNING_EXECUTIONS', 2, 1, 16)
  };

  // Optional OpenAI-compatible provider
  const key = String(e.AI_LAB_OPENAI_API_KEY || '').trim();
  let base = String(e.AI_LAB_OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.host))) || u.username || u.password) {
      warnings.push('AI_LAB_OPENAI_BASE_URL must be an https:// address; using https://api.openai.com/v1.');
      base = 'https://api.openai.com/v1';
    }
  } catch (err) {
    warnings.push('AI_LAB_OPENAI_BASE_URL isn\'t a valid URL; using https://api.openai.com/v1.');
    base = 'https://api.openai.com/v1';
  }
  if (key && !/^[\x21-\x7E]{8,512}$/.test(key)) warnings.push('AI_LAB_OPENAI_API_KEY contains characters that can\'t be in a key; the OpenAI-compatible provider is off.');
  const list = /** @param {string} name */ name => String(e[name] || '').split(/[\s,]+/).map(s => s.trim()).filter(s => /^[A-Za-z0-9._:\/-]{1,120}$/.test(s));

  return {
    enabled: flag('AI_LAB_ENABLED', true),
    dataDir: path.resolve(String(e.AI_LAB_DATA_DIR || '').trim() || path.join(__dirname, '..', 'lab-data')),
    withoutAccounts: flag('AI_LAB_WITHOUT_ACCOUNTS', false),
    defaultContextTokens: int('AI_LAB_DEFAULT_CONTEXT_TOKENS', 16000, 2000, 2000000),
    maxDocBytes: int('AI_LAB_MAX_DOC_KB', 1024, 1, 20480) * 1024,
    maxDocsPerProject: int('AI_LAB_MAX_DOCS_PER_PROJECT', 200, 1, 5000),
    maxRunningEvals: int('AI_LAB_MAX_RUNNING_EVALS', 2, 1, 32),
    pricingFile: String(e.AI_LAB_PRICING_FILE || '').trim() ? path.resolve(String(e.AI_LAB_PRICING_FILE).trim()) : path.join(__dirname, '..', 'ai-lab-pricing.json'),
    codeExecution,
    execution,
    openai: {
      configured: !!key && /^[\x21-\x7E]{8,512}$/.test(key),
      key: key && /^[\x21-\x7E]{8,512}$/.test(key) ? key : null,
      baseUrl: base,
      isOfficial: /^https:\/\/api\.openai\.com\//.test(base + '/'),
      models: list('AI_LAB_OPENAI_MODELS'),
      fineTuning: flag('AI_LAB_FINE_TUNING', false),
      fineTuneModels: list('AI_LAB_FINE_TUNE_MODELS')
    },
    warnings
  };
}

module.exports = { labConfig };
