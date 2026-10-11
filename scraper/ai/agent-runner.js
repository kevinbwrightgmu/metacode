// ── AI Scraper (beta): the server side of an AI job ───────────────────────────
// An AI job is run by python/ai_scraper.py, the agent: it asks MetaCode's AI
// service what to do next and calls read-only Reddit tools. This file starts
// the agent and answers its calls:
//   ai                 → MetaCode's AI service (opts.ai.chat), within the job's AI budget
//   find_subreddits, search_posts, list_posts, read_post
//                      → the job's Reddit client (ctx.http: the user's own keys,
//                        the server's keys or public pages, or RedditAPIs.com), so
//                        rate limits, the host allow-list and retries apply as for
//                        any job
//   keep               → adds posts the agent has seen in results (and their
//                        comments) to the job
// The agent only gets compact views of posts. The records a job keeps are the
// ones Reddit returned to this server, so the AI can't invent data, and
// whatever a post says can at most steer which read-only call comes next. The
// agent process gets no secrets: no keys, no .env.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const F = require('../reddit/format');
const { normalizeTarget } = require('../reddit/targets');
const { fetchPostWithComments, readListing } = require('../reddit/standard-scraper');
const { ScraperError, isScraperError, cancelledError, sanitize } = require('../errors');
const { pythonCandidates } = require('../network/python-transport');

const AGENT = path.join(__dirname, '..', '..', 'python', 'ai_scraper.py');
// After these, the job can't usefully go on (the agent is told to stop).
const FATAL = new Set(['cancelled', 'auth_error', 'reddit_blocked', 'payment_required', 'robots_disallowed', 'robots_unavailable',
  'tls', 'proxy_blocked', 'ai_error']);
const POST_ID_RE = /^[a-z0-9]{3,12}$/;
const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_PROMPT_CHARS = 150000;
const STOP_GRACE_MS = 60000;      // after the time limit: how long the agent gets to wrap up
const MAX_STEPS_SHOWN = 200;

const clip = (s, n) => {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function compactPost(p, textLength) {
  const text = p.selftext || (p.url && !p.is_self ? 'Link: ' + p.url : '');
  return { id: p.post_id, subreddit: p.subreddit, score: p.score, num_comments: p.num_comments, created_utc: p.created_utc,
    title: clip(p.title, 300), text: clip(text, textLength || 600) };
}

function invalidCall(message) { return new ScraperError('invalid_request', message, { status: 400 }); }

// Options of an AI job (from the request), clamped to safe limits.
function normalizeAiOptions(input) {
  const o = input && typeof input === 'object' ? input : {};
  const int = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
  const model = typeof o.model === 'string' ? o.model.trim().slice(0, 120) : '';
  return {
    maxPosts:        int(o.maxPosts, 1, 300, 50),
    commentsPerPost: int(o.commentsPerPost, 0, 100, 0),
    maxSteps:        int(o.maxSteps, 5, 60, 25),
    maxMinutes:      int(o.maxMinutes, 1, 30, 10),
    model
  };
}

function normalizeGoal(raw) {
  const goal = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (goal.length < 10) throw invalidCall('Describe what to collect in a sentence or two (at least 10 characters).');
  if (goal.length > 2000) throw invalidCall('The description is too long (2,000 characters at most).');
  return goal;
}

// Starts python/ai_scraper.py with the first Python that works.
function startAgent(env) {
  const candidates = pythonCandidates(env);
  return new Promise((resolve, reject) => {
    const tryNext = i => {
      if (i >= candidates.length) {
        return reject(new ScraperError('not_available', 'The AI Scraper needs Python 3 on the MetaCode server (tried ' +
          candidates.map(c => [c.cmd].concat(c.args).join(' ')).join(', ') + '). Install it, or set SCRAPER_PYTHON.', { status: 503 }));
      }
      const c = candidates[i];
      let child;
      try {
        child = spawn(c.cmd, c.args.concat(['-u', AGENT]), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // No secrets: only what Python needs to start
          env: pick(env, ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG'], { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' })
        });
      } catch (e) { return tryNext(i + 1); }
      child.once('error', () => tryNext(i + 1));
      child.once('spawn', () => resolve(child));
    };
    tryNext(0);
  });
}

function pick(env, names, extra) {
  const out = Object.assign({}, extra);
  names.forEach(n => { if (env[n] !== undefined) out[n] = env[n]; });
  return out;
}

// opts: { ai: { chat(messages, { model, signal }) → { text }, problem() → string|null }, env }
function createAiRunner(opts) {
  const ai = opts && opts.ai;
  const env = (opts && opts.env) || process.env;

  return async function runAiJob(job, ctx) {
    const a = job.options.ai;
    if (!ai) throw new ScraperError('not_available', 'The AI Scraper isn\'t available on this server.', { status: 503 });
    const problem = ai.problem();
    if (problem) throw new ScraperError('not_available', problem, { status: 503 });

    ctx.log('info', 'Goal: ' + a.goal);
    ctx.log('info', 'Reddit through: ' + (ctx.http.label || (ctx.http.mode === 'oauth' ? 'Reddit Data API (server keys)' : 'public Reddit pages')) +
      '; up to ' + a.maxPosts + ' posts' + (a.commentsPerPost ? ' with up to ' + a.commentsPerPost + ' comments each' : '') +
      ', ' + a.maxSteps + ' steps, ' + a.maxMinutes + ' min.');

    const pool = new Map();            // post id → normalized post the agent has seen
    const kept = new Set();
    const maxAiCalls = a.maxSteps + 6;
    let aiCalls = 0, requests = 0;
    const meta = { goal: a.goal, steps: [], kept: 0, aiCalls: 0, summary: null, reason: null };
    const publishMeta = () => { meta.kept = kept.size; meta.aiCalls = aiCalls; ctx.setMeta('ai', meta); };

    const listing = async (path, query, what) => {
      const { json } = await ctx.http.getJson(path, Object.assign({}, ctx.requestOpts, { query, context: what }));
      ctx.progress({ pagesFetched: ++requests });
      return readListing(json, what);
    };

    const tools = {
      async find_subreddits(args) {
        const q = clip(args.query, 100);
        if (!q) throw invalidCall('"query" is required.');
        const data = await listing('/subreddits/search', { q, limit: Math.max(1, Math.min(10, Number(args.limit) || 8)) }, 'Subreddit search');
        return { subreddits: data.children.filter(c => c && c.kind === 't5').map(c => F.normalizeSubreddit(c.data))
          .map(s => ({ name: s.name, title: clip(s.title, 100), subscribers: s.subscribers, description: clip(s.description, 240) })) };
      },
      async search_posts(args) {
        const t = normalizeTarget({ type: 'search', query: args.query, subreddit: args.subreddit || '', sort: args.sort, time: args.time });
        const query = { q: t.query, sort: t.sort, t: t.time, type: 'link', limit: limitOf(args), after: afterOf(args) };
        if (t.subreddit) query.restrict_sr = 'on';
        return posts(await listing(t.path, query, 'This search'));
      },
      async list_posts(args) {
        const t = normalizeTarget({ type: 'subreddit', subreddit: args.subreddit, sort: args.sort, time: args.time });
        return posts(await listing(t.path, { t: t.time, limit: limitOf(args), after: afterOf(args) }, 'r/' + t.subreddit));
      },
      async read_post(args) {
        const id = postId(args.post_id);
        const n = Math.max(0, Math.min(20, Number(args.comments) || 0));
        const res = await fetchPostWithComments(ctx, { commentLimit: Math.max(1, n), commentDepth: 2, expandMore: false }, id, { commentSort: 'top' });
        ctx.progress({ pagesFetched: ++requests });
        pool.set(res.post.post_id, res.post);
        return { post: compactPost(res.post, 2000), comments: res.comments.slice(0, n).map(c => ({ score: c.score, body: clip(c.body, 400) })) };
      },
      async keep(args) {
        const ids = Array.isArray(args.post_ids) ? args.post_ids.slice(0, 50).map(String) : [];
        const out = { kept: [], already: [], unknown: [], comments: 0 };
        for (const raw of ids) {
          const id = raw.replace(/^t3_/i, '').toLowerCase();
          if (kept.has(id)) { out.already.push(id); continue; }
          const post = POST_ID_RE.test(id) ? pool.get(id) : null;
          if (!post) { out.unknown.push(clip(raw, 20)); continue; }
          if (kept.size >= a.maxPosts || ctx.remaining() <= 0) break;
          let records = [post];
          if (a.commentsPerPost > 0) {
            try {
              const res = await fetchPostWithComments(ctx, { commentLimit: a.commentsPerPost, commentDepth: 5, expandMore: false }, id, {});
              ctx.progress({ pagesFetched: ++requests });
              records = [res.post].concat(res.comments);
              out.comments += res.comments.length;
            } catch (err) {
              if (isScraperError(err) && FATAL.has(err.type)) throw err;
              ctx.log('warn', 'Comments of post ' + id + ' couldn\'t be loaded: ' + (err.message || 'unknown error') + ' The post is kept without them.');
            }
          }
          ctx.emit(records);
          kept.add(id);
          out.kept.push(id);
        }
        if (out.kept.length) ctx.log('info', 'Kept ' + out.kept.length + ' post(s)' + (args.reason ? ': ' + clip(args.reason, 200) : '.'));
        publishMeta();
        return out;
      }
    };
    const limitOf = args => Math.max(1, Math.min(50, Number(args.limit) || 25));
    const afterOf = args => (typeof args.after === 'string' && /^t3_[a-z0-9]{3,12}$|^[A-Za-z0-9_=-]{1,60}$/.test(args.after) ? args.after : undefined);
    const postId = raw => {
      const id = String(raw || '').replace(/^t3_/i, '').toLowerCase();
      if (!POST_ID_RE.test(id)) throw invalidCall('That isn\'t a post id from the results.');
      return id;
    };
    function posts(data) {
      const list = data.children.filter(c => c && c.kind === 't3').map(c => F.normalizePost(c.data)).filter(p => p.post_id);
      list.forEach(p => pool.set(p.post_id, p));
      return { posts: list.map(p => compactPost(p)), after: typeof data.after === 'string' && data.after ? data.after : null };
    }

    async function askAi(args) {
      if (aiCalls >= maxAiCalls) throw new ScraperError('ai_error', 'The job used all ' + maxAiCalls + ' AI requests it may make.', { status: 429 });
      const messages = Array.isArray(args && args.messages) ? args.messages : [];
      let size = 0;
      const clean = messages.map(m => {
        if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') throw new ScraperError('internal_error', 'The AI agent sent a malformed request.', { status: 500 });
        size += m.content.length;
        return { role: m.role, content: m.content };
      });
      if (!clean.length || size > MAX_PROMPT_CHARS) throw new ScraperError('internal_error', 'The AI agent\'s request was too large.', { status: 500 });
      aiCalls++;
      const r = await ai.chat(clean, { model: a.model, signal: ctx.signal });
      publishMeta();
      return { text: String((r && r.text) || '') };
    }

    const child = await startAgent(env);
    return new Promise((resolve, reject) => {
      let settled = false, stderr = '';
      const send = msg => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { /* the agent is gone; 'exit' reports it */ } };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeLimit);
        clearTimeout(hardStop);
        ctx.signal.removeEventListener('abort', onAbort);
        try { child.stdin.end(); } catch (e) { /* closed */ }
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
        if (err) reject(err); else resolve();
      };
      const onAbort = () => { child.kill('SIGKILL'); finish(ctx.signal.reason || cancelledError()); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      let hardStop = null;
      const timeLimit = setTimeout(() => {
        ctx.log('info', 'Time limit (' + a.maxMinutes + ' min) reached; asking the AI to wrap up.');
        send({ type: 'stop', reason: 'time' });
        hardStop = setTimeout(() => { child.kill('SIGKILL'); meta.reason = 'time'; publishMeta(); finish(null); }, STOP_GRACE_MS);
      }, a.maxMinutes * 60000);

      child.stderr.on('data', d => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
      child.on('close', code => {
        if (settled) return;
        finish(new ScraperError('internal_error', 'The AI agent stopped unexpectedly. The server log has details.', { status: 500,
          detail: 'exit ' + code + ': ' + sanitize(stderr, 600) }));
      });

      readline.createInterface({ input: child.stdout }).on('line', async line => {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'event') return onEvent(msg);
        if (msg.type === 'done') {
          meta.summary = clip(msg.summary, 1000) || null;
          meta.reason = String(msg.reason || 'finished');
          publishMeta();
          ctx.log('info', 'AI: ' + (meta.summary || 'finished') + ' (' + kept.size + ' post' + (kept.size === 1 ? '' : 's') + ' kept)');
          return finish(null);
        }
        if (msg.type === 'failed') {
          const e = msg.error || {};
          const type = /^[a-z_]{2,40}$/.test(e.type || '') ? e.type : 'ai_error';
          return finish(new ScraperError(type, clip(e.message, 600) || 'The AI agent stopped.', { status: 502 }));
        }
        if (msg.type !== 'call') return;
        const id = msg.id;
        try {
          let value;
          if (msg.name === 'ai') value = await askAi(msg.args);
          else if (Object.prototype.hasOwnProperty.call(tools, msg.name)) value = await tools[msg.name](msg.args && typeof msg.args === 'object' ? msg.args : {});
          else throw invalidCall('There is no tool "' + clip(msg.name, 40) + '".');
          send({ type: 'result', id, ok: true, value });
        } catch (err) {
          if (settled) return;
          if (ctx.signal.aborted) return onAbort();
          const e = isScraperError(err) ? err : null;
          if (!e) ctx.log('warn', 'Unexpected error in an AI tool call: ' + sanitize(err && err.message, 200));
          const type = e ? e.type : 'internal_error';
          const message = e ? e.message : 'Something went wrong on the server.';
          send({ type: 'result', id, ok: false, error: { type, message, fatal: FATAL.has(type) || type === 'internal_error' } });
        }
      });

      function onEvent(ev) {
        if (ev.kind === 'step') {
          const step = { step: Number(ev.step) || meta.steps.length + 1, tool: clip(ev.tool, 40), args: describeArgs(ev.args), thought: clip(ev.thought, 500),
            result: ev.error ? 'invalid: ' + clip(ev.error, 200) : null, error: !!ev.error };
          if (meta.steps.length >= MAX_STEPS_SHOWN) meta.steps.shift();
          meta.steps.push(step);
          ctx.log('info', 'Step ' + step.step + ': ' + step.tool + (step.args ? ' ' + step.args : '') + (step.thought ? ' — ' + step.thought : ''));
          ctx.progress({ message: 'Step ' + step.step + ': ' + step.tool + (step.args ? ' ' + step.args : '') });
          publishMeta();
        } else if (ev.kind === 'observation') {
          const last = meta.steps[meta.steps.length - 1];
          if (last && last.step === Number(ev.step)) { last.result = clip(ev.summary, 300); last.error = !!ev.error; }
          publishMeta();
        } else if (ev.kind === 'note') {
          ctx.log('warn', clip(ev.message, 300));
        }
      }

      send({ type: 'start', goal: a.goal, today: new Date().toISOString().slice(0, 10),
        limits: { maxPosts: a.maxPosts, maxSteps: a.maxSteps } });
    });
  };
}

function describeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  if (args.query) parts.push('"' + clip(args.query, 80) + '"');
  if (args.subreddit) parts.push('r/' + clip(args.subreddit, 30));
  if (args.sort) parts.push(clip(args.sort, 15) + (args.time ? ' ' + clip(args.time, 10) : ''));
  if (args.after) parts.push('more');
  if (args.post_id) parts.push(clip(args.post_id, 15));
  if (Array.isArray(args.post_ids)) parts.push(args.post_ids.length + ' post' + (args.post_ids.length === 1 ? '' : 's'));
  return parts.join(' · ');
}

module.exports = { createAiRunner, normalizeAiOptions, normalizeGoal, compactPost };
