// ── Result export (CSV / JSON / NDJSON) ───────────────────────────────────────

// Spreadsheet apps execute cells starting with = + - @ (and tab/CR) as
// formulas. Scraped Reddit text is untrusted, so such strings are prefixed
// with an apostrophe (OWASP "CSV injection"). Numbers are left alone.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Column order: the union of record keys in first-seen order, with the
// common identifying columns first.
const PREFERRED = ['record_type', 'post_id', 'comment_id', 'title', 'author', 'subreddit', 'created_at', 'score',
  'upvote_ratio', 'num_comments', 'url', 'permalink', 'selftext', 'body', 'flair'];

function columnsFor(records) {
  const seen = new Set();
  const cols = [];
  PREFERRED.forEach(c => { if (records.some(r => r && Object.prototype.hasOwnProperty.call(r, c))) { seen.add(c); cols.push(c); } });
  records.forEach(r => Object.keys(r || {}).forEach(k => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));
  return cols;
}

function toCSV(records) {
  const cols = columnsFor(records);
  const lines = [cols.map(csvCell).join(',')];
  records.forEach(r => lines.push(cols.map(c => csvCell(r ? r[c] : null)).join(',')));
  return '﻿' + lines.join('\r\n') + '\r\n';       // BOM so Excel reads UTF-8
}

// Comments nested under their posts (when the post is in the results).
function nestComments(records) {
  const posts = new Map();
  const out = [];
  records.forEach(r => {
    if (r && r.record_type === 'post' && r.post_id) {
      const copy = Object.assign({}, r, { comments: [] });
      posts.set(r.post_id, copy);
      out.push(copy);
    }
  });
  records.forEach(r => {
    if (!r || r.record_type === 'post') return;
    if (r.record_type === 'comment' && r.post_id && posts.has(r.post_id)) posts.get(r.post_id).comments.push(r);
    else out.push(r);
  });
  return out;
}

function toJSON(job, records, nested) {
  return JSON.stringify({
    job: { id: job.id, mode: job.mode, target: job.target, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, meta: job.meta },
    count: records.length,
    records: nested ? nestComments(records) : records
  }, null, 2);
}

function toNDJSON(records) {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

module.exports = { toCSV, toJSON, toNDJSON, nestComments, csvCell, columnsFor };
