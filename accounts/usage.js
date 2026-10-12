// ── Usage counters ────────────────────────────────────────────────────────────
// How much of each plan limit an account has used this month / today, plus two
// small lookup tables the server needs: account → Stripe customer, and
// owner id (owner.js) → account (whose plan applies to a published survey's
// responses). Kept in one JSON file, ACCOUNT_DATA_DIR/usage.json, written
// atomically shortly after each change (and on shutdown). Nothing personal is
// stored besides the account's email (for ACCOUNT_PLAN_OVERRIDES by email).
//
// Counting works by reservation: reserve(n) takes up to n of what's left and
// says how many it got; release() gives back what wasn't used (a failed AI
// request, a scrape that found fewer items), so failures aren't charged.
const fs = require('fs');
const path = require('path');
const Plans = require('../public/js/plans.js');

const monthOf = t => new Date(t).toISOString().slice(0, 7);
const dayOf = t => new Date(t).toISOString().slice(0, 10);
function nextReset(period, t) {
  const d = new Date(t);
  return period === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString()
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

class UsageStore {
  constructor(dir, opts) {
    opts = opts || {};
    this.dir = dir;
    this.file = path.join(dir, 'usage.json');
    this.now = opts.now || Date.now;
    this.delayMs = opts.writeDelayMs === undefined ? 1000 : opts.writeDelayMs;
    this.data = null;
    this.timer = null;
  }

  load() {
    if (this.data) return this.data;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') d = {};
    ['users', 'customers', 'owners'].forEach(k => { if (!d[k] || typeof d[k] !== 'object') d[k] = {}; });
    this.data = d;
    return d;
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.data) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[accounts] Couldn\'t save usage counters: ' + (e && e.code || 'error'));
    }
  }

  user(userId) {
    const d = this.load();
    const t = this.now();
    let u = d.users[userId];
    if (!u) u = d.users[userId] = { month: monthOf(t), day: dayOf(t), m: {}, d: {} };
    if (u.month !== monthOf(t)) { u.month = monthOf(t); u.m = {}; }
    if (u.day !== dayOf(t)) { u.day = dayOf(t); u.d = {}; }
    return u;
  }

  bucket(u, meter) { return Plans.METERS[meter].period === 'month' ? u.m : u.d; }
  periodKey(meter) { const t = this.now(); return Plans.METERS[meter].period === 'month' ? monthOf(t) : dayOf(t); }

  used(userId, meter) { return this.bucket(this.user(userId), meter)[meter] || 0; }

  // Takes up to n (never past limit). → { granted, used, limit, period, resetsAt }
  reserve(userId, meter, n, limit) {
    const u = this.user(userId), b = this.bucket(u, meter);
    const used = b[meter] || 0;
    const granted = Math.max(0, Math.min(n, limit - used));
    if (granted) { b[meter] = used + granted; this.changed(); }
    return { granted, used: used + granted, limit, period: this.periodKey(meter), resetsAt: nextReset(Plans.METERS[meter].period, this.now()) };
  }

  // Gives back n reserved in `period` (ignored once the period has rolled over).
  release(userId, meter, n, period) {
    if (!(n > 0)) return;
    const u = this.user(userId);
    if (period && period !== this.periodKey(meter)) return;
    const b = this.bucket(u, meter);
    b[meter] = Math.max(0, (b[meter] || 0) - n);
    this.changed();
  }

  summary(userId, limits) {
    const t = this.now();
    const out = {};
    Object.keys(Plans.METERS).forEach(meter => {
      const m = Plans.METERS[meter];
      out[meter] = { used: this.used(userId, meter), limit: limits[m.limit], period: m.period, resetsAt: nextReset(m.period, t) };
    });
    return out;
  }

  // Account email (for overrides by email) — only verified emails are kept.
  noteUser(user) {
    if (!user || !user.id) return;
    const u = this.user(user.id);
    const email = user.emailConfirmed && user.email ? user.email : null;
    if (u.email !== email) { u.email = email; this.changed(); }
  }
  emailOf(userId) { const u = this.load().users[userId]; return (u && u.email) || null; }

  setCustomer(userId, customerId) { const d = this.load(); if (d.customers[userId] !== customerId) { d.customers[userId] = customerId; this.changed(); } }
  customerOf(userId) { return this.load().customers[userId] || null; }
  userOfCustomer(customerId) { const d = this.load(); return Object.keys(d.customers).find(u => d.customers[u] === customerId) || null; }

  linkOwner(owner, userId) { const d = this.load(); if (owner && d.owners[owner] !== userId) { d.owners[owner] = userId; this.changed(); } }
  userOfOwner(owner) { return (owner && this.load().owners[owner]) || null; }
}

module.exports = { UsageStore, nextReset, monthOf, dayOf };
