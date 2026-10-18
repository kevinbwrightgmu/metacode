// @ts-check
// ── MetaCode features the app uses (all checked by the server) ────────────────
//   AI            POST /api/desktop/ai, /api/desktop/ai/batch (desktop plans,
//                 counted against the plan's AI limits like the website)
//   models        GET /api/models
//   projects      the account's saved MetaCode projects (Supabase table
//                 metacode_data, kind "projects"; Row Level Security lets an
//                 account read and write only its own rows). The app reads them
//                 and adds new ones; it never changes or deletes existing ones.
//   scraper       GET /api/scraper/jobs and …/results (the account's jobs)
'use strict';
const crypto = require('crypto');
const { NetError, errorMessage } = require('./http');

class PlatformError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; }
}

const MAX_PROJECT_BYTES = 24 * 1024 * 1024;

/**
 * @param {{ http: ReturnType<typeof import('./http').createHttp>, auth: ReturnType<typeof import('./auth').createAuth>,
 *           entitlement: ReturnType<typeof import('./entitlement').createEntitlement>, server: string }} o
 */
function createPlatform(o) {
  async function token() {
    if (!o.entitlement.online()) {
      throw new PlatformError('offline', o.entitlement.unlocked() ? 'This needs a connection to MetaCode — you\'re working offline right now.' : 'Sign in with a Pro, Max or Ultra plan to use this.');
    }
    const t = await o.auth.accessToken();
    if (!t) throw new PlatformError('signed_out', 'Sign in again to use this.');
    return t;
  }
  /** @param {any} r @param {string} what */
  function fail(r, what) {
    const type = r.json && r.json.error && r.json.error.type;
    if (r.status === 401) { o.entitlement.check('401').catch(() => {}); return new PlatformError('signed_out', 'Your session ended. Sign in again.', 401); }
    if (r.status === 402 || r.status === 403) {
      if (type === 'plan_required' || type === 'feature_unavailable') o.entitlement.check('403').catch(() => {});
      return new PlatformError(type || 'forbidden', errorMessage(r, 'Your plan doesn\'t include ' + what + '.'), r.status);
    }
    if (r.status === 429) return new PlatformError(type || 'limit_reached', errorMessage(r, 'You\'ve reached your plan\'s limit for ' + what + '.'), 429);
    return new PlatformError(type || 'server_error', errorMessage(r, 'MetaCode couldn\'t complete ' + what + ' (' + r.status + ').'), r.status);
  }
  /** @param {string} pathname @param {any} [opts] */
  async function server(pathname, opts = {}) {
    const t = await token();
    try {
      return await o.http.request(o.server + pathname, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {}) }));
    } catch (e) {
      if (e instanceof NetError) throw new PlatformError(e.kind, e.message);
      throw e;
    }
  }
  async function supabase() {
    const c = await o.entitlement.config();
    if (!c || !c.accounts || !c.accounts.supabaseUrl) throw new PlatformError('accounts_off', 'This server doesn\'t keep projects in accounts.');
    return c.accounts;
  }
  /** @param {string} query @param {any} [opts] */
  async function rest(query, opts = {}) {
    const a = await supabase();
    const t = await token();
    try {
      return await o.http.request(a.supabaseUrl + '/rest/v1/metacode_data?' + query, Object.assign({}, opts, { headers: Object.assign({ apikey: a.publishableKey, Authorization: 'Bearer ' + t }, opts.headers || {}), timeoutMs: opts.timeoutMs || 60000 }));
    } catch (e) {
      if (e instanceof NetError) throw new PlatformError(e.kind, e.message);
      throw e;
    }
  }

  return {
    /** One AI request @param {{ messages: any[], model?: string, max_tokens?: number, temperature?: number }} body */
    async ai(body) {
      const r = await server('/api/desktop/ai', { method: 'POST', json: body, timeoutMs: 180000 });
      if (!r.ok) throw fail(r, 'AI requests');
      return { text: String((r.json && r.json.text) || ''), model: (r.json && r.json.model) || null };
    },

    /**
     * AI Coding of many rows; results arrive one line at a time
     * @param {{ requests: { id: any, body: any }[], parallel?: number }} body
     * @param {(line: any) => void} onLine @param {AbortSignal} [signal]
     */
    async aiBatch(body, onLine, signal) {
      const t = await token();
      let r;
      try { r = await o.http.request(o.server + '/api/desktop/ai/batch', { method: 'POST', json: body, headers: { Authorization: 'Bearer ' + t, Accept: 'application/x-ndjson' }, raw: true, signal, timeoutMs: 30 * 60 * 1000 }); }
      catch (e) { if (e instanceof NetError) throw new PlatformError(e.kind, e.message); throw e; }
      if (!r.ok) {
        let text = '';
        try { text = await r.response.text(); } catch (e) { text = ''; }
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        throw fail({ status: r.status, json }, 'AI Coding');
      }
      const reader = r.response.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { onLine(JSON.parse(line)); } catch (e) { /* a broken line is skipped */ }
          }
        }
      } catch (e) {
        if (signal && signal.aborted) return { stopped: true };
        throw new PlatformError('offline', 'The connection to MetaCode was interrupted during AI Coding. What was done is kept.');
      }
      if (buf.trim()) { try { onLine(JSON.parse(buf.trim())); } catch (e) { /* ignore */ } }
      return { stopped: false };
    },

    async models() {
      const r = await server('/api/models', { timeoutMs: 20000 });
      if (!r.ok || !r.json) return { models: [], note: 'Couldn\'t load the model list.' };
      return { models: Array.isArray(r.json.models) ? r.json.models.slice(0, 200).map((/** @type {any} */ m) => ({ id: String(m.id), name: String(m.name || m.id) })) : [], note: r.json.note || null };
    },

    /** The account's saved projects (names and dates, not their data) */
    async projects() {
      const r = await rest('select=id,updated_at,name:data->>name,savedAt:data->>savedAt,description:data->>description&kind=eq.projects&deleted=eq.false&order=updated_at.desc&limit=500', { timeoutMs: 30000 });
      if (!r.ok) throw fail(r, 'loading your projects');
      return (Array.isArray(r.json) ? r.json : []).map((/** @type {any} */ p) => ({ id: String(p.id), name: String(p.name || 'Untitled project'), description: p.description ? String(p.description).slice(0, 300) : '', updatedAt: p.updated_at || p.savedAt || null }));
    },

    /** One project with its data @param {string} id */
    async project(id) {
      if (typeof id !== 'string' || !/^[\w.:-]{1,200}$/.test(id)) throw new PlatformError('invalid', 'That isn\'t a project id.');
      const r = await rest('select=id,data&kind=eq.projects&deleted=eq.false&id=eq.' + encodeURIComponent(id), { timeoutMs: 120000 });
      if (!r.ok) throw fail(r, 'loading the project');
      const row = Array.isArray(r.json) ? r.json[0] : null;
      if (!row || !row.data) throw new PlatformError('not_found', 'That project isn\'t in your account any more.', 404);
      return row.data;
    },

    /**
     * Adds a new project to the account (the website picks it up the next time
     * it syncs). Existing projects are never overwritten.
     * @param {any} project
     */
    async createProject(project) {
      if (!project || typeof project !== 'object' || typeof project.name !== 'string' || !project.data || typeof project.data !== 'object') throw new PlatformError('invalid', 'The project is incomplete.');
      // the website's id format (public/js/projects.js)
      const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const id = 'pr_' + Array.from(crypto.randomBytes(12), b => ALPHA[b % 62]).join('');
      const at = new Date().toISOString();
      const data = Object.assign({}, project, { id, createdAt: at, savedAt: at, revision: 1 });
      const body = JSON.stringify([{ kind: 'projects', id, data }]);
      if (Buffer.byteLength(body) > MAX_PROJECT_BYTES) throw new PlatformError('too_large', 'The project is larger than 24 MB, the most an account can keep in one project.');
      const r = await rest('', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, timeoutMs: 120000 });
      if (!r.ok) throw fail(r, 'saving the project');
      return { id, name: data.name };
    },

    async scraperJobs() {
      const r = await server('/api/scraper/jobs?limit=100', { timeoutMs: 20000 });
      if (!r.ok) throw fail(r, 'loading your scraper jobs');
      return (r.json && Array.isArray(r.json.jobs) ? r.json.jobs : []).map((/** @type {any} */ j) => ({
        id: String(j.id), status: String(j.status || ''), createdAt: j.createdAt || null, engine: j.engine || null,
        label: String(j.label || (j.target && (j.target.label || j.target.value || j.target.name)) || j.mode || 'Scraper job').slice(0, 200),
        records: Number(j.itemCount) || 0
      }));
    },

    /** @param {string} id @param {{ offset?: number, limit?: number }} [page] */
    async scraperResults(id, page = {}) {
      if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new PlatformError('invalid', 'That isn\'t a job id.');
      const offset = Math.max(0, Math.floor(Number(page.offset) || 0)), limit = Math.max(1, Math.min(10000, Math.floor(Number(page.limit) || 10000)));
      const r = await server('/api/scraper/jobs/' + encodeURIComponent(id) + '/results?offset=' + offset + '&limit=' + limit, { timeoutMs: 120000 });
      if (!r.ok) throw fail(r, 'loading the scraper results');
      return { total: Number(r.json && r.json.total) || 0, offset, records: (r.json && Array.isArray(r.json.records)) ? r.json.records : [] };
    }
  };
}

module.exports = { createPlatform, PlatformError };
