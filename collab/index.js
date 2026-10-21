// @ts-check
// ── /api/collab — shared MetaCode projects ────────────────────────────────────
// A project can be shared with other MetaCode accounts. The shared copy lives
// on this server (collab/store.js); who may do what is decided here, for every
// request, from the account the request is signed in as (accounts/):
//
//   owner   everything: edit, invite and remove people, change roles, delete
//   editor  edit the project, chat
//   viewer  read the project, chat
//
//   GET    /config                          is sharing available (accounts on)?
//   GET    /projects                        the shared projects you belong to
//   POST   /projects                        share a project: { name, data } → you own it
//   GET    /projects/:id[?since=rev]        the project (or what changed since a revision)
//   POST   /projects/:id/changes            { changes: [{ key, baseRev, value }] } (editor+)
//   PATCH  /projects/:id                    { name } (editor+)
//   DELETE /projects/:id                    (owner)
//   GET    /projects/:id/members            members (+ pending invitations, owner only)
//   POST   /projects/:id/invites            { emails, role } → invitation links (owner)
//   DELETE /projects/:id/invites/:inviteId  revoke (owner)
//   PATCH  /projects/:id/members/:userId    { role } (owner)
//   DELETE /projects/:id/members/:userId    remove someone (owner) or leave (yourself)
//   GET    /invites/:token                  what an invitation is for (no sign-in needed)
//   POST   /invites/:token/accept           join (signed in with the invited email)
//   GET    /projects/:id/chat               messages (?before / ?after = seq, ?limit)
//   POST   /projects/:id/chat               { text, clientId }
//   GET    /projects/:id/events             live events (Server-Sent Events): hello,
//                                           presence, updated, chat, members, revoked, deleted
//
// Invitations are links (MetaCode doesn't send email): each holds a random
// token, stored only as a hash, valid 14 days, for one email address; only
// the account with that (confirmed) email can accept it.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { CollabStore, applyChanges, changesSince } = require('./store');

const ROLES = { viewer: 1, editor: 2, owner: 3 };
const INVITE_DAYS = 14;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;

/** @param {number} status @param {string} type @param {string} message @param {any} [extra] */
function fail(status, type, message, extra) { return Object.assign(new Error(message), { status, type, extra: extra || null }); }
/** @param {any} res @param {any} e */
function send(res, e) {
  if (res.headersSent) return;
  if (!e.status) console.error('[collab] ' + String(e && e.message || e).slice(0, 200));
  res.status(e.status || 500).json({ error: Object.assign({ type: e.type || 'internal_error', message: e.status ? e.message : 'Something went wrong with the shared project.' }, e.extra || {}) });
}
/** @param {string} email */
const maskEmail = email => { const [u, d] = String(email || '').split('@'); return d ? (u.slice(0, 1) + '•••@' + d) : ''; };
/** @param {string} t */
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

/**
 * @param {{ accounts: any, dataDir?: string, publicUrl?: () => string | null, limits?: Partial<{ ownedProjects: number, members: number, pendingInvites: number, chatPerMinute: number, streamsPerUser: number }> }} deps
 */
function createCollab(deps) {
  const accounts = deps.accounts;
  const dir = deps.dataDir || path.resolve(String(process.env.COLLAB_DATA_DIR || '').trim() || path.join(__dirname, '..', 'collab-data'));
  const store = new CollabStore(dir);
  const L = Object.assign({ ownedProjects: 100, members: 25, pendingInvites: 50, chatPerMinute: 30, streamsPerUser: 8 }, deps.limits || {});

  /* ── Who is asking, and what may they do ─── */
  /** @param {any} req */
  async function userOf(req) {
    if (!accounts.enabled()) throw fail(403, 'sharing_unavailable', 'Sharing needs accounts, which aren\'t turned on for this MetaCode server.');
    const ctx = await accounts.contextOf(req);
    const e = accounts.needUser(ctx, 'shared projects');
    if (e) throw e;
    return { id: String(ctx.user.id), email: ctx.user.email || null, emailConfirmed: ctx.user.emailConfirmed !== false };
  }
  /** @param {any} p @param {string} userId */
  const memberOf = (p, userId) => p.members.find(/** @param {any} m */ m => m.id === userId) || null;
  /**
   * The project, if this account is a member with at least `role` (404 for
   * non-members, so a project's existence isn't revealed).
   * @param {string} id @param {{ id: string }} user @param {'viewer' | 'editor' | 'owner'} role
   */
  async function access(id, user, role) {
    const p = await store.get(id);
    const m = p && memberOf(p, user.id);
    if (!p || !m) throw fail(404, 'not_found', 'That shared project doesn\'t exist, or you don\'t have access to it.');
    if (ROLES[/** @type {'viewer'} */ (m.role)] < ROLES[role]) {
      throw fail(403, 'forbidden', role === 'owner' ? 'Only the project\'s owner can do that.' : 'You can view this project but not change it (you\'re a viewer).', { role: m.role });
    }
    return { p, m };
  }
  /** @param {any} p @param {any} m */
  const summary = (p, m) => ({ id: p.id, name: p.name, role: m ? m.role : null, owner: { id: p.owner.id, email: p.owner.email }, revision: p.revision,
    members: p.members.length, posts: p.data.posts.length, createdAt: p.createdAt, updatedAt: p.updatedAt });
  /** @param {any} p */
  const membersOf = p => p.members.map(/** @param {any} m */ m => ({ id: m.id, email: m.email, role: m.role, addedAt: m.addedAt }));
  /** @param {any} inv */
  const inviteOut = inv => ({ id: inv.id, email: inv.email, role: inv.role, createdAt: inv.createdAt, expiresAt: inv.expiresAt,
    status: inv.status === 'pending' && Date.parse(inv.expiresAt) < Date.now() ? 'expired' : inv.status });

  /* ── Live events (Server-Sent Events) ─────── */
  /** @type {Map<string, Map<number, { user: { id: string, email: string | null }, res: any, since: string }>>} */
  const hub = new Map();
  let connSeq = 0, eventSeq = 0;
  /** @param {any} res @param {string} event @param {any} data */
  function write(res, event, data) { try { res.write('id: ' + (++eventSeq) + '\nevent: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* gone */ } }
  /** @param {string} id @param {string} event @param {any} data @param {(c: any) => boolean} [only] */
  function broadcast(id, event, data, only) { const conns = hub.get(id); if (conns) for (const c of conns.values()) if (!only || only(c)) write(c.res, event, data); }
  /** Who has the project open (one entry per account) @param {string} id */
  function presence(id) {
    const out = new Map();
    const conns = hub.get(id);
    if (conns) for (const c of conns.values()) if (!out.has(c.user.id)) out.set(c.user.id, { id: c.user.id, email: c.user.email, since: c.since });
    return [...out.values()];
  }
  /** Ends the streams of an account that lost access @param {string} id @param {string} userId @param {string} event */
  function kick(id, userId, event) {
    const conns = hub.get(id);
    if (!conns) return;
    for (const [k, c] of conns) if (c.user.id === userId) { write(c.res, event, { projectId: id }); try { c.res.end(); } catch (e) { /* gone */ } conns.delete(k); }
    broadcast(id, 'presence', { users: presence(id) });
  }
  /** @param {any} p */
  function announceMembers(p) { broadcast(p.id, 'members', { members: membersOf(p) }); }

  /* ── Routes ─────────────────────────────── */
  const router = express.Router();
  router.use(express.json({ limit: '25mb' }));
  router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => { res.set('Cache-Control', 'no-store'); next(); });
  /** @param {(req: any, res: any, user: any) => Promise<any>} fn @param {{ open?: boolean }} [o] */
  const route = (fn, o) => async (/** @type {any} */ req, /** @type {any} */ res) => {
    try {
      const user = o && o.open ? null : await userOf(req);
      const out = await fn(req, res, user);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) { send(res, e); }
  };
  /** Per-account request rate @param {any} user @param {string} what @param {number} perMinute */
  function limit(user, what, perMinute) {
    const r = accounts.rate.take('collab:' + what + ':' + user.id, perMinute);
    if (!r.ok) throw Object.assign(fail(429, 'rate_limited', 'Too many requests — try again in ' + r.retryAfter + ' s.', { retryAfterSeconds: r.retryAfter }), { retryAfter: r.retryAfter });
  }

  router.get('/config', async (/** @type {any} */ req, /** @type {any} */ res) => {
    let signedIn = false;
    try { if (accounts.enabled()) signedIn = !!(await accounts.contextOf(req)).user; } catch (e) { signedIn = false; }
    res.json({ enabled: accounts.enabled(), signedIn, roles: Object.keys(ROLES), inviteDays: INVITE_DAYS, limits: { members: L.members } });
  });

  router.get('/projects', route(async (req, res, user) => {
    const ids = await store.projectsOf(user.id);
    const out = [];
    for (const id of ids) {
      const p = await store.get(id);
      const m = p && memberOf(p, user.id);
      if (m) out.push(summary(p, m)); else await store.indexRemove(user.id, id);
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { projects: out };
  }));

  router.post('/projects', route(async (req, res, user) => {
    limit(user, 'create', 20);
    const b = req.body || {};
    if (!b.data || typeof b.data !== 'object') throw fail(400, 'invalid_request', 'Send the project as { name, data: { posts, codebook, … } }.');
    let owned = 0;
    for (const id of await store.projectsOf(user.id)) { const p = await store.get(id); if (p && p.owner.id === user.id) owned++; }
    if (owned >= L.ownedProjects) throw fail(409, 'limit_reached', 'You already share ' + L.ownedProjects + ' projects. Delete one you no longer need to share another.');
    const p = await store.create(user, b.data, typeof b.name === 'string' ? b.name : '');
    const sent = Array.isArray(b.data.posts) ? b.data.posts.length : 0;
    return { project: summary(p, memberOf(p, user.id)), revision: p.revision, revs: p.revs, data: p.data, skipped: Math.max(0, sent - p.data.posts.length) };
  }));

  router.get('/projects/:id', route(async (req, res, user) => {
    const { p, m } = await access(req.params.id, user, 'viewer');
    const since = req.query.since !== undefined ? Number(req.query.since) : null;
    if (since !== null && Number.isInteger(since) && since >= 0 && since <= p.revision) {
      const changes = changesSince(p, since);
      return { project: summary(p, m), revision: p.revision, changes, order: changes.some(c => c.key.startsWith('post:')) ? p.data.posts.map(/** @param {any} x */ x => x.id) : null };
    }
    return { project: summary(p, m), revision: p.revision, revs: p.revs, data: p.data, members: membersOf(p) };
  }));

  router.post('/projects/:id/changes', route(async (req, res, user) => {
    limit(user, 'changes', 240);
    const changes = req.body && Array.isArray(req.body.changes) ? req.body.changes : null;
    if (!changes || !changes.length || changes.length > 10000) throw fail(400, 'invalid_request', 'Send { changes: [{ key, baseRev, value }] } (1–10,000 changes).');
    await access(req.params.id, user, 'editor');
    const out = await store.update(req.params.id, p => {
      const m = memberOf(p, user.id);
      if (!m || ROLES[/** @type {'viewer'} */ (m.role)] < ROLES.editor) return { forbidden: true };      // lost access meanwhile
      const r = applyChanges(p, changes.map(/** @param {any} c */ c => ({ key: c && c.key, baseRev: c && c.baseRev, value: c ? c.value : undefined })));
      return Object.assign(r, { save: r.applied.length > 0, revision: p.revision, name: p.name });
    });
    if (out.notFound) throw fail(404, 'not_found', 'That shared project doesn\'t exist any more.');
    if (out.forbidden) throw fail(403, 'forbidden', 'You can no longer change this project.');
    if (out.applied.length) broadcast(req.params.id, 'updated', { revision: out.revision, keys: out.applied.slice(0, 500), count: out.applied.length, by: { id: user.id, email: user.email }, name: out.name });
    return { revision: out.revision, applied: out.applied, conflicts: out.conflicts, invalid: out.invalid };
  }));

  router.patch('/projects/:id', route(async (req, res, user) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 300) : '';
    if (!name) throw fail(400, 'invalid_request', 'Give the project a name.');
    await access(req.params.id, user, 'editor');
    const out = await store.update(req.params.id, p => {
      const r = applyChanges(p, [{ key: 'meta', baseRev: p.revs.meta || 0, value: Object.assign({}, p.data.project, { name }) }]);
      return { save: true, revision: p.revision, applied: r.applied };
    });
    broadcast(req.params.id, 'updated', { revision: out.revision, keys: ['meta'], count: 1, by: { id: user.id, email: user.email }, name });
    return { revision: out.revision, name };
  }));

  router.delete('/projects/:id', route(async (req, res, user) => {
    await access(req.params.id, user, 'owner');
    const conns = hub.get(req.params.id);
    broadcast(req.params.id, 'deleted', { projectId: req.params.id, by: { id: user.id, email: user.email } });
    if (conns) { for (const c of conns.values()) { try { c.res.end(); } catch (e) { /* gone */ } } hub.delete(req.params.id); }
    await store.delete(req.params.id);
    return { ok: true };
  }));

  router.get('/projects/:id/members', route(async (req, res, user) => {
    const { p, m } = await access(req.params.id, user, 'viewer');
    return { you: { id: user.id, role: m.role }, members: membersOf(p), invites: m.role === 'owner' ? p.invites.filter(/** @param {any} i */ i => i.status === 'pending').map(inviteOut) : undefined, online: presence(p.id) };
  }));

  router.post('/projects/:id/invites', route(async (req, res, user) => {
    limit(user, 'invite', 30);
    const b = req.body || {};
    const role = b.role === 'viewer' ? 'viewer' : b.role === 'editor' ? 'editor' : null;
    if (!role) throw fail(400, 'invalid_request', 'Choose a role for the people you invite: editor or viewer.');
    const emails = [...new Set((Array.isArray(b.emails) ? b.emails : String(b.emails || '').split(/[\s,;]+/)).map(/** @param {any} e */ e => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!emails.length || emails.length > 20) throw fail(400, 'invalid_request', 'Enter 1–20 email addresses.');
    await access(req.params.id, user, 'owner');
    const origin = (deps.publicUrl && deps.publicUrl()) || (req.protocol + '://' + req.get('host'));
    /** @type {{ hash: string, inviteId: string }[]} */
    const refs = [];
    /** @type {string[]} */
    const dropRefs = [];
    const out = await store.update(req.params.id, p => {
      const results = [];
      const now = Date.now();
      for (const email of emails) {
        if (!EMAIL.test(email)) { results.push({ email: email.slice(0, 120), status: 'invalid', message: 'That isn\'t an email address.' }); continue; }
        if (email === String(user.email || '').toLowerCase()) { results.push({ email, status: 'self', message: 'That\'s you.' }); continue; }
        if (p.members.some(/** @param {any} m */ m => String(m.email || '').toLowerCase() === email)) { results.push({ email, status: 'already_member', message: 'Already a member.' }); continue; }
        const token = crypto.randomBytes(24).toString('base64url');
        const hash = hashToken(token);
        const existing = p.invites.find(/** @param {any} i */ i => i.status === 'pending' && i.email === email);
        if (!existing && p.members.length + p.invites.filter(/** @param {any} i */ i => i.status === 'pending' && Date.parse(i.expiresAt) > now).length >= L.members) {
          results.push({ email, status: 'limit', message: 'A project can have up to ' + L.members + ' people (members and open invitations).' }); continue;
        }
        if (!existing && p.invites.filter(/** @param {any} i */ i => i.status === 'pending').length >= L.pendingInvites) { results.push({ email, status: 'limit', message: 'Too many open invitations — revoke some first.' }); continue; }
        const inv = existing || { id: 'inv_' + crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, ''), email, createdAt: new Date(now).toISOString(), invitedBy: user.id, status: 'pending' };
        if (existing && existing.tokenHash) dropRefs.push(existing.tokenHash);      // a renewed invitation's old link stops working
        Object.assign(inv, { role, tokenHash: hash, expiresAt: new Date(now + INVITE_DAYS * 86400000).toISOString() });
        if (!existing) p.invites.push(inv);
        refs.push({ hash, inviteId: inv.id });
        results.push({ email, status: existing ? 'renewed' : 'invited', role, inviteId: inv.id, link: origin + '/app.html#invite/' + token, expiresAt: inv.expiresAt });
      }
      return { save: refs.length > 0, results };
    });
    for (const h of dropRefs) await store.inviteRefRemove(h);
    for (const r of refs) await store.inviteRefPut(r.hash, req.params.id, r.inviteId);
    return { results: out.results };
  }));

  router.delete('/projects/:id/invites/:inviteId', route(async (req, res, user) => {
    await access(req.params.id, user, 'owner');
    let hash = null;
    const out = await store.update(req.params.id, p => {
      const inv = p.invites.find(/** @param {any} i */ i => i.id === req.params.inviteId && i.status === 'pending');
      if (!inv) return { missing: true };
      inv.status = 'revoked'; inv.revokedAt = new Date().toISOString(); hash = inv.tokenHash; delete inv.tokenHash;
      return { save: true };
    });
    if (out.missing) throw fail(404, 'not_found', 'That invitation isn\'t open (it may have been accepted or revoked).');
    if (hash) await store.inviteRefRemove(hash);
    return { ok: true };
  }));

  router.patch('/projects/:id/members/:userId', route(async (req, res, user) => {
    const role = req.body && (req.body.role === 'editor' || req.body.role === 'viewer') ? req.body.role : null;
    if (!role) throw fail(400, 'invalid_request', 'The role must be editor or viewer.');
    await access(req.params.id, user, 'owner');
    const out = await store.update(req.params.id, p => {
      const m = memberOf(p, req.params.userId);
      if (!m) return { missing: true };
      if (m.role === 'owner') return { owner: true };
      m.role = role;
      return { save: true, p };
    });
    if (out.missing) throw fail(404, 'not_found', 'That person isn\'t a member of this project.');
    if (out.owner) throw fail(400, 'invalid_request', 'The owner\'s role can\'t be changed.');
    announceMembers(out.p);
    return { members: membersOf(out.p) };
  }));

  router.delete('/projects/:id/members/:userId', route(async (req, res, user) => {
    const self = req.params.userId === user.id;
    await access(req.params.id, user, self ? 'viewer' : 'owner');
    const out = await store.update(req.params.id, p => {
      const m = memberOf(p, req.params.userId);
      if (!m) return { missing: true };
      if (m.role === 'owner') return { owner: true };
      p.members = p.members.filter(/** @param {any} x */ x => x.id !== m.id);
      return { save: true, p };
    });
    if (out.missing) throw fail(404, 'not_found', 'That person isn\'t a member of this project.');
    if (out.owner) throw fail(400, 'invalid_request', self ? 'You own this project: delete it instead of leaving it.' : 'The owner can\'t be removed.');
    await store.indexRemove(req.params.userId, req.params.id);
    kick(req.params.id, req.params.userId, 'revoked');
    announceMembers(out.p);
    return { members: membersOf(out.p) };
  }));

  /** The pending invitation a token stands for (or why not) @param {string} token */
  async function inviteFor(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { error: fail(404, 'invite_not_found', 'This invitation link isn\'t valid.') };
    const hash = hashToken(token);
    const ref = await store.inviteRef(hash);
    const p = ref && await store.get(ref.projectId);
    const inv = p && p.invites.find(/** @param {any} i */ i => i.id === ref.inviteId);
    if (!p || !inv || inv.tokenHash !== hash) return { error: fail(404, 'invite_not_found', 'This invitation link isn\'t valid any more (it may have been revoked or replaced by a newer one).') };
    if (inv.status === 'accepted') return { error: fail(410, 'invite_used', 'This invitation has already been accepted.'), p, inv };
    if (inv.status !== 'pending') return { error: fail(410, 'invite_revoked', 'This invitation was revoked.'), p, inv };
    if (Date.parse(inv.expiresAt) < Date.now()) return { error: fail(410, 'invite_expired', 'This invitation has expired. Ask the project\'s owner for a new one.'), p, inv };
    return { p, inv, hash };
  }

  router.get('/invites/:token', route(async (req) => {
    const r = await inviteFor(req.params.token);
    if (r.error && !r.p) throw r.error;
    const owner = r.p.owner;
    return { project: { name: r.p.name }, invitedBy: owner.email, role: r.inv.role, email: maskEmail(r.inv.email), expiresAt: r.inv.expiresAt,
      status: r.error ? r.error.type.replace('invite_', '') : 'pending', message: r.error ? r.error.message : null };
  }, { open: true }));

  router.post('/invites/:token/accept', route(async (req, res, user) => {
    limit(user, 'accept', 20);
    const r = await inviteFor(req.params.token);
    if (r.error) throw r.error;
    if (!user.email || user.email.toLowerCase() !== r.inv.email) {
      throw fail(403, 'invite_wrong_account', 'This invitation is for ' + maskEmail(r.inv.email) + '. Sign in with that email address to accept it.');
    }
    if (!user.emailConfirmed) throw fail(403, 'email_unconfirmed', 'Confirm your email address first (see the email from MetaCode), then accept the invitation.');
    const out = await store.update(r.p.id, p => {
      const inv = p.invites.find(/** @param {any} i */ i => i.id === r.inv.id);
      if (!inv || inv.status !== 'pending' || inv.tokenHash !== r.hash || Date.parse(inv.expiresAt) < Date.now()) return { gone: true };
      inv.status = 'accepted'; inv.acceptedAt = new Date().toISOString(); inv.acceptedBy = user.id; delete inv.tokenHash;
      const already = memberOf(p, user.id);
      if (!already) p.members.push({ id: user.id, email: user.email, role: inv.role, addedAt: inv.acceptedAt, addedBy: inv.invitedBy });
      return { save: true, p, role: already ? already.role : inv.role };
    });
    if (out.gone) throw fail(410, 'invite_used', 'This invitation was just used or revoked.');
    await store.inviteRefRemove(r.hash);
    await store.indexAdd(user.id, r.p.id);
    announceMembers(out.p);
    return { project: summary(out.p, memberOf(out.p, user.id)), role: out.role };
  }));

  router.get('/projects/:id/chat', route(async (req, res, user) => {
    await access(req.params.id, user, 'viewer');
    const c = await store.chat(req.params.id);
    const lim = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    let list = c.messages;
    if (req.query.after !== undefined) list = list.filter(/** @param {any} m */ m => m.seq > Number(req.query.after)).slice(0, lim);
    else { if (req.query.before !== undefined) list = list.filter(/** @param {any} m */ m => m.seq < Number(req.query.before)); list = list.slice(-lim); }
    return { messages: list.map(/** @param {any} m */ m => ({ seq: m.seq, id: m.id, at: m.at, from: m.from, text: m.text, clientId: m.clientId })), latest: c.seq };
  }));

  router.post('/projects/:id/chat', route(async (req, res, user) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) throw fail(400, 'invalid_request', 'Write a message first.');
    if (text.length > 2000) throw fail(400, 'invalid_request', 'Messages can be up to 2,000 characters.');
    const clientId = req.body && typeof req.body.clientId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(req.body.clientId) ? req.body.clientId : null;
    await access(req.params.id, user, 'viewer');
    limit(user, 'chat:' + req.params.id, L.chatPerMinute);
    const r = await store.addMessage(req.params.id, user, text, clientId);
    if (!r.duplicate) broadcast(req.params.id, 'chat', { message: r.message });
    return { message: r.message, duplicate: r.duplicate };
  }));

  router.get('/projects/:id/events', async (/** @type {any} */ req, /** @type {any} */ res) => {
    let user, p, m;
    try { user = await userOf(req); ({ p, m } = await access(req.params.id, user, 'viewer')); } catch (e) { return send(res, e); }
    const conns = hub.get(p.id) || new Map();
    if ([...conns.values()].filter(c => c.user.id === user.id).length >= L.streamsPerUser) return send(res, fail(429, 'rate_limited', 'This project is open in too many of your tabs.'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const connId = ++connSeq;
    conns.set(connId, { user: { id: user.id, email: user.email }, res, since: new Date().toISOString() });
    hub.set(p.id, conns);
    const chat = await store.chat(p.id);
    write(res, 'hello', { projectId: p.id, revision: p.revision, name: p.name, role: m.role, you: { id: user.id, email: user.email }, chatLatest: chat.seq, users: presence(p.id) });
    broadcast(p.id, 'presence', { users: presence(p.id) }, c => c.res !== res);
    // Keep-alive, and a periodic check that the account still has access
    const beat = setInterval(async () => {
      const cur = await store.get(p.id).catch(() => null);
      const still = cur && memberOf(cur, user.id);
      if (!still) { kick(p.id, user.id, cur ? 'revoked' : 'deleted'); return; }
      try { res.write(': ping\n\n'); } catch (e) { /* gone */ }
    }, 20000);
    const done = () => {
      clearInterval(beat);
      const cs = hub.get(p.id);
      if (cs && cs.delete(connId)) { if (!cs.size) hub.delete(p.id); else broadcast(p.id, 'presence', { users: presence(p.id) }); }
    };
    res.on('close', done);
    res.on('error', done);
  });

  // A body the JSON parser refused: say why, as JSON (not Express's HTML page)
  router.use((/** @type {any} */ err, /** @type {any} */ req, /** @type {any} */ res, /** @type {(e?: any) => void} */ next) => {
    if (!err || res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return send(res, fail(413, 'too_large', 'That\'s more than 25 MB, the most a shared project can send at once. Share a smaller copy (fewer posts).'));
    if (err.type === 'entity.parse.failed') return send(res, fail(400, 'invalid_request', 'The request wasn\'t valid JSON.'));
    return send(res, err);
  });

  return {
    router, store,
    online: /** @param {string} id */ id => presence(id),
    shutdown() { for (const conns of hub.values()) for (const c of conns.values()) { try { c.res.end(); } catch (e) { /* gone */ } } hub.clear(); }
  };
}

module.exports = { createCollab, ROLES };
