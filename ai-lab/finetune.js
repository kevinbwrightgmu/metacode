// @ts-check
// ── Fine-tuning ───────────────────────────────────────────────────────────────
// Fine-tuning changes a model's parameters by training it on examples. It is
// offered only through a provider that actually supports it: the
// OpenAI-compatible provider, when the operator turns it on
// (AI_LAB_FINE_TUNING=on, AI_LAB_FINE_TUNE_MODELS lists the base models).
// MetaCode's own AI service has no fine-tuning, so without that setting the
// Training Studio offers dataset curation, export, profiles, retrieval and
// evaluation — and says plainly that fine-tuning isn't available.
//
// A job is a real provider job: MetaCode uploads the training (and optional
// validation) file in the chat format, creates the job, and shows the
// provider's own status and events. It never simulates training. Training is
// billed by the provider; the user must confirm that before a job starts, and
// the Ultra plan's labFineTunes meter limits jobs per month.
//
// Provider API (OpenAI, as documented; verify against the provider's current
// documentation before enabling): POST /files (purpose fine-tune),
// POST /fine_tuning/jobs, GET /fine_tuning/jobs/{id}, POST …/{id}/cancel,
// GET …/{id}/events.

const { LabError, invalid } = require('./errors');
const { newId } = require('./store');
const D = require('./datasets');
const P = require('./profiles');
const { logger, redact } = require('../lib/log');

const log = logger('ai-lab');
const ACTIVE = new Set(['validating_files', 'queued', 'running', 'creating']);
const MIN_EXAMPLES = 10;

/**
 * @param {object} deps
 * @param {import('./store').LabStore} deps.store
 * @param {ReturnType<typeof import('./providers').createRegistry>} deps.registry
 * @param {ReturnType<typeof import('./usage').createLabUsage>} deps.usage
 * @param {() => ReturnType<typeof import('./config').labConfig>} deps.getConfig
 */
function createFineTuning(deps) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  const counters = { created: 0, failed: 0 };

  function availability() {
    const cfg = deps.getConfig().openai;
    if (!cfg.configured) return { available: false, reason: 'No provider with fine-tuning is configured on this server. MetaCode\'s own AI service doesn\'t offer fine-tuning.' };
    if (!cfg.fineTuning) return { available: false, reason: 'Fine-tuning through ' + (cfg.isOfficial ? 'OpenAI' : 'the OpenAI-compatible provider') + ' is turned off on this server (the administrator can enable it with AI_LAB_FINE_TUNING=on; it is billed by the provider).' };
    if (!cfg.fineTuneModels.length) return { available: false, reason: 'No base models for fine-tuning are listed (AI_LAB_FINE_TUNE_MODELS).' };
    return { available: true, reason: null };
  }

  /** @returns {any} the OpenAI-compatible provider */
  function provider() {
    const a = availability();
    if (!a.available) throw new LabError('fine_tuning_unavailable', /** @type {string} */ (a.reason), { status: 503 });
    return deps.registry.get('openai');
  }

  /** @param {any} p @param {string} path @param {object} [o] */
  async function call(p, path, o) {
    const res = await p.call(path, Object.assign({ timeoutMs: 60000 }, o || {}));
    if (!res.ok) throw await p.fail(res, 'fine-tuning');
    return /** @type {any} */ (await res.json());
  }

  /** @param {any} p @param {string} name @param {string} jsonl */
  async function upload(p, name, jsonl) {
    const form = new FormData();
    form.append('purpose', 'fine-tune');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), name);
    const j = await call(p, '/files', { method: 'POST', body: form });
    if (!j || typeof j.id !== 'string') throw new LabError('provider_error', 'The provider didn\'t return a file id for the upload.', { status: 502 });
    return j.id;
  }

  /** Updates a stored job from the provider. @param {import('./store').UserStore} u @param {any} job */
  async function refresh(u, job) {
    if (!job.providerJobId || !ACTIVE.has(job.status)) return job;
    try {
      const p = provider();
      const j = await call(p, '/fine_tuning/jobs/' + encodeURIComponent(job.providerJobId));
      const ev = await call(p, '/fine_tuning/jobs/' + encodeURIComponent(job.providerJobId) + '/events?limit=20').catch(() => null);
      job.status = String(j.status || job.status).slice(0, 40);
      job.fineTunedModel = j.fine_tuned_model || null;
      job.trainedTokens = Number.isFinite(j.trained_tokens) ? j.trained_tokens : null;
      job.error = j.error && j.error.message ? { type: 'provider_error', message: redact(String(j.error.message), 500) } : null;
      job.events = ev && Array.isArray(ev.data) ? ev.data.slice(0, 20).map(/** @param {any} e */ e => ({ at: e.created_at ? new Date(e.created_at * 1000).toISOString() : null, level: String(e.level || 'info').slice(0, 10), message: redact(String(e.message || ''), 300) })) : job.events;
      job.checkedAt = new Date().toISOString();
      job.updatedAt = job.checkedAt;
      u.put('finetunes', job);
    } catch (err) {
      job.lastCheckError = err instanceof LabError ? err.message : 'The provider couldn\'t be reached.';
      job.checkedAt = new Date().toISOString();
      u.put('finetunes', job);
    }
    return job;
  }

  /**
   * @param {any} router
   * @param {{ us: (req: any) => import('./store').UserStore, owned: Function, route: Function, str: (v: unknown, max: number) => string }} h
   */
  function routes(router, h) {
    const { us, owned, route, str } = h;

    router.get('/finetune/capabilities', route(() => {
      const a = availability();
      const cfg = deps.getConfig().openai;
      return Object.assign(a, {
        provider: cfg.configured ? (cfg.isOfficial ? 'OpenAI' : 'OpenAI-compatible API') : null,
        baseModels: a.available ? cfg.fineTuneModels : [],
        requirements: { format: 'Chat-format JSONL: one {"messages": [system?, user, assistant]} conversation per line', minExamples: MIN_EXAMPLES,
          trainingSplit: 'Examples in the dataset version\'s "train" split with an expected output (rejected examples are left out); "validation" examples become the validation file.' },
        cost: 'Training is billed by the provider per trained token. MetaCode can\'t tell the price in advance; check the provider\'s pricing page.',
        note: 'Fine-tuning changes the model\'s parameters. Profiles, retrieval and evaluation don\'t — they change what is sent to the model and how answers are measured.'
      });
    }));

    router.get('/finetunes', route(/** @param {any} req */ async req => {
      const u = us(req);
      const list = u.list('finetunes').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return { jobs: list };
    }));

    router.post('/finetunes', route(/** @param {any} req */ async req => {
      const u = us(req);
      const p = provider();
      const b = req.body || {};
      if (b.confirmCost !== true) throw invalid('Confirm that you understand the provider bills this training (confirmCost: true).');
      const cfg = deps.getConfig().openai;
      const baseModel = str(b.baseModel, 120);
      if (!cfg.fineTuneModels.includes(baseModel)) throw invalid('Choose one of the base models offered for fine-tuning: ' + cfg.fineTuneModels.join(', ') + '.');
      const ds = owned(u, 'datasets', b.datasetId, 'That dataset');
      const version = Number(b.datasetVersion);
      const raw = u.readSidecar('datasets', ds.id, 'v' + version + '.json');
      if (!raw) throw invalid('Choose a committed version of the dataset.');
      /** @type {import('../types/ai-lab').DatasetExample[]} */
      const examples = JSON.parse(raw).examples;
      const report = D.qualityReport(examples, { purpose: 'training' });
      const blocking = report.issues.filter(i => i.level === 'error' && ['possible_secret', 'split_overlap', 'empty_task'].includes(i.code));
      if (blocking.length) throw new LabError('quality_errors', 'The dataset version has problems that must be fixed before training (' + blocking.slice(0, 3).map(i => i.message).join(' ') + ').', { status: 409 });
      let system = '';
      if (b.profileId) { const prof = owned(u, 'profiles', b.profileId, 'That profile'); system = P.render(P.current(prof).fields); }
      const train = D.chatTrainingFormat(examples.filter(e => e.split === 'train'), system);
      const valid = D.chatTrainingFormat(examples.filter(e => e.split === 'validation'), system);
      if (train.count < MIN_EXAMPLES) throw invalid('Fine-tuning needs at least ' + MIN_EXAMPLES + ' training examples with expected outputs in the "train" split; this version has ' + train.count + '.');
      const suffix = str(b.suffix, 40).replace(/[^A-Za-z0-9-]/g, '').slice(0, 18) || 'metacode';
      const meter = deps.usage.take(req.lab, 'labFineTunes');
      /** @type {any} */
      const job = { id: newId('finetunes'), provider: 'openai', baseModel, datasetId: ds.id, datasetVersion: version, profileId: b.profileId || null,
        trainingExamples: train.count, validationExamples: valid.count, suffix, status: 'creating', providerJobId: null, fineTunedModel: null, trainedTokens: null,
        error: null, events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checkedAt: null };
      u.put('finetunes', job);
      try {
        const trainingFile = await upload(p, 'train-' + ds.id + '-v' + version + '.jsonl', train.jsonl);
        const validationFile = valid.count ? await upload(p, 'validation-' + ds.id + '-v' + version + '.jsonl', valid.jsonl) : null;
        /** @type {Record<string, unknown>} */
        const body = { training_file: trainingFile, model: baseModel, suffix };
        if (validationFile) body.validation_file = validationFile;
        const j = await call(p, '/fine_tuning/jobs', { method: 'POST', json: body });
        job.providerJobId = String(j.id || '');
        job.status = String(j.status || 'queued').slice(0, 40);
        job.updatedAt = new Date().toISOString();
        u.put('finetunes', job);
        u.audit('finetune.created', { job: job.id, dataset: ds.id, datasetVersion: version, baseModel });
        counters.created++;
      } catch (err) {
        meter.release();
        job.status = 'failed';
        job.error = { type: err instanceof LabError ? err.type : 'error', message: err instanceof LabError ? err.message : 'The job couldn\'t be created.' };
        u.put('finetunes', job);
        counters.failed++;
        if (!(err instanceof LabError)) log.error('finetune.create_failed', { detail: redact(String(err && /** @type {Error} */ (err).message)) });
        throw err instanceof LabError ? err : new LabError('provider_error', 'The fine-tuning job couldn\'t be created.', { status: 502 });
      }
      return { job };
    }));

    router.get('/finetunes/:id', route(/** @param {any} req */ async req => {
      const u = us(req);
      const job = owned(u, 'finetunes', req.params.id, 'That fine-tuning job');
      return { job: await refresh(u, job) };
    }));

    router.post('/finetunes/:id/cancel', route(/** @param {any} req */ async req => {
      const u = us(req);
      const job = owned(u, 'finetunes', req.params.id, 'That fine-tuning job');
      if (!ACTIVE.has(job.status) || !job.providerJobId) throw invalid('Only queued or running jobs can be cancelled.');
      const j = await call(provider(), '/fine_tuning/jobs/' + encodeURIComponent(job.providerJobId) + '/cancel', { method: 'POST' });
      job.status = String(j.status || 'cancelled').slice(0, 40);
      job.updatedAt = new Date().toISOString();
      u.put('finetunes', job);
      u.audit('finetune.cancelled', { job: job.id });
      return { job };
    }));
  }

  /** Background status checks of active jobs, every 2 minutes (only while some exist). */
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!availability().available) return;
      for (const key of deps.store.userKeys()) {
        const u = deps.store.forUser(key);
        u.list('finetunes').filter(j => ACTIVE.has(j.status)).forEach(j => { refresh(u, j).catch(() => {}); });
      }
    }, 120000);
    if (timer.unref) timer.unref();
  }

  function shutdown() { if (timer) { clearInterval(timer); timer = null; } }

  /** @param {import('./store').UserStore} u */
  function active(u) { return u.list('finetunes').filter(j => ACTIVE.has(j.status)); }

  return { routes, start, shutdown, active, availability, stats: () => Object.assign({}, counters) };
}

module.exports = { createFineTuning, MIN_EXAMPLES };
