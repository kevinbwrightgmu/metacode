// /api/collab — shared projects (collab/): who may read, change, invite and
// remove (decided on the server for every request), invitation links (one
// email, expiring, single use), edits from two people at once (a change made
// from an old revision is a conflict and overwrites nothing), the live event
// stream (presence, updates, chat, removal) and chat history. Sign-in is
// checked with a stand-in Supabase (test/helpers/account-mocks.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockSupabase } = require('./helpers/account-mocks');
const { testEnv } = require('./helpers/harness');

const KEY = 'sb_publishable_test_collab_0123456789';
let sb, server, base, tmp, mod;
const U = {}, T = {};

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-collab-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  for (const n of ['owner', 'alice', 'bob', 'mallory']) { U[n] = sb.addUser(n + '@example.org', 'pw-' + n); T[n] = sb.issue(U[n]).access_token; }
  U.carol = sb.addUser('carol@example.org', 'pw-carol', { unconfirmed: true });
  T.carol = sb.issue(U.carol).access_token;
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY, STRIPE_SECRET_KEY: '',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    COLLAB_DATA_DIR: path.join(tmp, 'collab'), EMIS_MODELS_FILE: path.join(tmp, 'none.json'), PUBLIC_URL: '', DESKTOP_RELEASES_REPO: 'off'
  }));
  mod = require('../server');
  server = await mod.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (sb) await sb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, p, token, body, headers) {
  const r = await fetch(base + '/api/collab' + p, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** A live event stream for one account, with waitFor(event, test) */
function stream(token, id) {
  const ac = new AbortController();
  const got = [];
  let wake = () => {};
  let status = null;
  const done = fetch(base + '/api/collab/projects/' + id + '/events', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal }).then(async r => {
    status = r.status;
    if (r.status !== 200) { got.push({ event: '_status', data: { status: r.status, body: await r.text() } }); wake(); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read().catch(() => ({ done: true }));
      if (end) { got.push({ event: '_end', data: null }); wake(); return; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
        if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
      wake();
    }
  }).catch(() => {});
  let cursor = 0;
  return {
    got, get status() { return status; },
    async waitFor(event, ok, ms) {
      const until = Date.now() + (ms || 5000);
      for (;;) {
        for (; cursor < got.length; cursor++) {
          const e = got[cursor];
          if (e.event === event && (!ok || ok(e.data))) { cursor++; return e.data; }
        }
        if (Date.now() > until) throw new Error('no "' + event + '" event; got ' + got.map(e => e.event).join(', '));
        await new Promise(r => { wake = r; setTimeout(r, 100); });
      }
    },
    close() { ac.abort(); return done; }
  };
}

const sample = () => ({
  project: { name: 'Field notes', description: 'Coding study' },
  posts: [{ id: 'p1', title: 'First', codes: {} }, { id: 'p2', title: 'Second', codes: {} }, { id: 3, title: 'Numeric id' }],
  codebook: [{ name: 'tone', type: 'categorical', categories: ['pos', 'neg'] }],
  network: { nodes: [], edges: [] },
  networkAnalysis: null
});
const linkToken = link => link.split('#invite/')[1];
/** Shares a project as `owner` and invites `who` with `role`; returns the project id */
async function shareWith(who, role, name) {
  const c = await api('POST', '/projects', T.owner, { name: name || 'Shared', data: sample() });
  assert.equal(c.status, 200);
  const id = c.json.project.id;
  for (const w of [].concat(who || [])) {
    const inv = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: [U[w].email], role });
    const a = await api('POST', '/invites/' + linkToken(inv.json.results[0].link) + '/accept', T[w]);
    assert.equal(a.status, 200, a.text);
  }
  return id;
}

test('sharing a project: the owner gets a server copy, split into entities with revisions', async () => {
  const cfg = await api('GET', '/config', T.owner);
  assert.deepEqual([cfg.json.enabled, cfg.json.signedIn, cfg.json.roles], [true, true, ['viewer', 'editor', 'owner']]);
  assert.equal((await api('GET', '/config')).json.signedIn, false);

  const c = await api('POST', '/projects', T.owner, { name: '  My study  ', data: sample() });
  assert.equal(c.status, 200);
  assert.match(c.json.project.id, /^cp_[A-Za-z0-9]{8,32}$/);
  assert.equal(c.json.project.name, 'My study', 'the name given wins over the data\'s');
  assert.equal(c.json.project.role, 'owner');
  assert.equal(c.json.revision, 1);
  assert.deepEqual(c.json.data.posts.map(p => p.id), ['p1', 'p2', '3'], 'post ids become strings');
  assert.deepEqual(Object.keys(c.json.revs).sort(), ['codebook', 'meta', 'network', 'networkAnalysis', 'post:3', 'post:p1', 'post:p2']);
  assert.equal(c.headers.get('cache-control'), 'no-store');

  const list = await api('GET', '/projects', T.owner);
  assert.ok(list.json.projects.some(p => p.id === c.json.project.id && p.role === 'owner' && p.posts === 3 && p.members === 1));
  assert.equal((await api('GET', '/projects', T.alice)).json.projects.length, 0, 'not shared with alice yet');

  assert.equal((await api('POST', '/projects', T.owner, { name: 'x' })).status, 400, 'data is required');
  assert.equal((await api('POST', '/projects', null, { data: sample() })).json.error.type, 'sign_in_required');
  // Stored as a file only the server can read
  const file = path.join(tmp, 'collab', 'projects', c.json.project.id + '.json');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'not readable by other users of the machine');
});

test('invitations: links for any email (accounts not needed yet), renewed, refused for yourself, members and non-emails; only the owner invites', async () => {
  const id = await shareWith(null, null, 'Invites');
  const r = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: 'alice@example.org, newcomer@example.net; not-an-email OWNER@example.org', role: 'editor' });
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.results.map(x => [x.email, x]));
  assert.equal(by['alice@example.org'].status, 'invited');
  assert.equal(by['newcomer@example.net'].status, 'invited', 'someone without an account can be invited');
  assert.equal(by['not-an-email'].status, 'invalid');
  assert.equal(by['owner@example.org'].status, 'self');
  assert.match(by['alice@example.org'].link, /^http:\/\/127\.0\.0\.1:\d+\/app\.html#invite\/[A-Za-z0-9_-]{20,64}$/);
  const oldToken = linkToken(by['alice@example.org'].link);

  // The token is stored only as a hash
  const raw = fs.readFileSync(path.join(tmp, 'collab', 'projects', id + '.json'), 'utf8');
  assert.ok(!raw.includes(oldToken), 'the link\'s token isn\'t stored');

  // Invite alice again (as a viewer): the invitation is renewed and the old link stops working
  const again = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['alice@example.org'], role: 'viewer' });
  assert.equal(again.json.results[0].status, 'renewed');
  assert.equal((await api('GET', '/invites/' + oldToken)).status, 404);
  const info = await api('GET', '/invites/' + linkToken(again.json.results[0].link));
  assert.equal(info.status, 200);
  assert.deepEqual([info.json.project.name, info.json.role, info.json.email, info.json.status, info.json.invitedBy], ['Invites', 'viewer', 'a•••@example.org', 'pending', 'owner@example.org']);

  const members = await api('GET', '/projects/' + id + '/members', T.owner);
  assert.deepEqual(members.json.invites.map(i => [i.email, i.role, i.status]).sort(), [['alice@example.org', 'viewer', 'pending'], ['newcomer@example.net', 'editor', 'pending']]);
  assert.ok(!JSON.stringify(members.json).includes('tokenHash'), 'hashes never leave the server');

  // Only the owner invites; a role is required
  assert.equal((await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['x@example.org'], role: 'owner' })).status, 400);
  assert.equal((await api('POST', '/projects/' + id + '/invites', T.mallory, { emails: ['x@example.org'], role: 'editor' })).status, 404, 'non-members can\'t tell the project exists');
  assert.equal((await api('GET', '/invites/not-a-real-token-0000000000')).status, 404);
});

test('accepting: only the invited, confirmed email can; links are single-use; revoked links stop working', async () => {
  const id = await shareWith(null, null, 'Accepting');
  const inv = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['bob@example.org', 'carol@example.org', 'dave@example.org'], role: 'viewer' });
  const [bobTok, carolTok, daveTok] = inv.json.results.map(x => linkToken(x.link));

  const wrong = await api('POST', '/invites/' + bobTok + '/accept', T.mallory);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.type, 'invite_wrong_account');
  assert.ok(!wrong.text.includes('bob@example.org'), 'the invited address is masked');
  assert.equal((await api('POST', '/invites/' + bobTok + '/accept')).status, 401, 'signed out');

  const unconfirmed = await api('POST', '/invites/' + carolTok + '/accept', T.carol);
  assert.equal(unconfirmed.json.error.type, 'email_unconfirmed', 'an unconfirmed address could belong to anyone');

  const ok = await api('POST', '/invites/' + bobTok + '/accept', T.bob);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.role, ok.json.project.id], ['viewer', id]);
  assert.ok((await api('GET', '/projects', T.bob)).json.projects.some(p => p.id === id && p.role === 'viewer'));
  const used = await api('POST', '/invites/' + bobTok + '/accept', T.bob);
  assert.equal(used.status, 404, 'a used link isn\'t valid any more');

  // dave has no account yet: he signs up later and the link still works
  const dave = sb.addUser('dave@example.org', 'pw-dave');
  const daveIn = await api('POST', '/invites/' + daveTok + '/accept', sb.issue(dave).access_token);
  assert.equal(daveIn.status, 200, daveIn.text);

  // A revoked invitation
  const inv2 = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['alice@example.org'], role: 'editor' });
  const members = await api('GET', '/projects/' + id + '/members', T.owner);
  const pending = members.json.invites.find(i => i.email === 'alice@example.org');
  assert.equal((await api('DELETE', '/projects/' + id + '/invites/' + pending.id, T.bob)).status, 403, 'only the owner revokes');
  assert.equal((await api('DELETE', '/projects/' + id + '/invites/' + pending.id, T.owner)).status, 200);
  assert.equal((await api('POST', '/invites/' + linkToken(inv2.json.results[0].link) + '/accept', T.alice)).status, 404);
  assert.equal((await api('GET', '/projects/' + id, T.alice)).status, 404, 'alice never joined');
});

test('an expired invitation can\'t be accepted', async () => {
  const id = await shareWith(null, null, 'Expiry');
  const inv = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['alice@example.org'], role: 'editor' });
  const tok = linkToken(inv.json.results[0].link);
  // Age the invitation on disk (as 15 days passing would)
  await mod.collab.store.update(id, p => { p.invites[0].expiresAt = new Date(Date.now() - 1000).toISOString(); return { save: true }; });
  const info = await api('GET', '/invites/' + tok);
  assert.equal(info.json.status, 'expired');
  const r = await api('POST', '/invites/' + tok + '/accept', T.alice);
  assert.equal(r.status, 410);
  assert.equal(r.json.error.type, 'invite_expired');
  const m = await api('GET', '/projects/' + id + '/members', T.owner);
  assert.equal(m.json.invites[0].status, 'expired');
});

test('roles are enforced on the server: viewers read but can\'t change; non-members get 404 everywhere', async () => {
  const id = await shareWith(['alice', 'bob'], 'viewer', 'Roles');
  await api('PATCH', '/projects/' + id + '/members/' + U.alice.id, T.owner, { role: 'editor' });
  const P = '/projects/' + id;

  const view = await api('GET', P, T.bob);
  assert.equal(view.status, 200);
  assert.equal(view.json.project.role, 'viewer');
  assert.equal(view.json.data.posts.length, 3);
  const ch = await api('POST', P + '/changes', T.bob, { changes: [{ key: 'post:p1', baseRev: view.json.revs['post:p1'], value: { id: 'p1', title: 'hacked' } }] });
  assert.equal(ch.status, 403);
  assert.equal(ch.json.error.type, 'forbidden');
  assert.equal((await api('PATCH', P, T.bob, { name: 'nope' })).status, 403);
  assert.equal((await api('POST', P + '/invites', T.bob, { emails: ['x@example.org'], role: 'viewer' })).status, 403);
  assert.equal((await api('DELETE', P, T.bob)).status, 403);
  assert.equal((await api('DELETE', P, T.alice)).status, 403, 'editors can\'t delete');
  assert.equal((await api('PATCH', P + '/members/' + U.bob.id, T.alice, { role: 'editor' })).status, 403, 'editors can\'t change roles');
  assert.equal((await api('DELETE', P + '/members/' + U.bob.id, T.alice)).status, 403, 'editors can\'t remove people');
  assert.equal((await api('GET', P + '/members', T.alice)).json.invites, undefined, 'only the owner sees invitations');
  assert.equal((await api('GET', P, T.bob)).json.data.posts[0].title, 'First', 'nothing changed');

  for (const [m, p, b] of [['GET', P], ['GET', P + '?since=0'], ['POST', P + '/changes', { changes: [{ key: 'meta', baseRev: 1, value: { name: 'x' } }] }], ['PATCH', P, { name: 'x' }], ['DELETE', P],
    ['GET', P + '/members'], ['GET', P + '/chat'], ['POST', P + '/chat', { text: 'hi' }], ['DELETE', P + '/members/' + U.bob.id], ['POST', P + '/invites', { emails: ['x@example.org'], role: 'viewer' }]]) {
    const r = await api(m, p, T.mallory, b);
    assert.equal(r.status, 404, m + ' ' + p);
    assert.equal(r.json.error.type, 'not_found');
  }
  const s = stream(T.mallory, id);
  const st = await s.waitFor('_status');
  assert.equal(st.status, 404);
  await s.close();
  assert.equal((await api('GET', '/projects/cp_doesnotexist01', T.owner)).status, 404);
  assert.equal((await api('GET', '/projects/..%2F..%2Fetc', T.owner)).status, 404, 'ids are checked before any file is read');
  // Requests from another website are refused before any route runs
  const xs = await api('POST', P + '/chat', T.alice, { text: 'hi' }, { Origin: 'https://evil.example' });
  assert.equal(xs.status, 403);
  assert.equal(xs.json.error.type, 'forbidden_origin');
});

test('two editors at once: different entities both apply; the same entity from an old revision is a conflict and overwrites nothing', async () => {
  const id = await shareWith(['alice'], 'editor', 'Concurrent');
  const P = '/projects/' + id;
  const a = (await api('GET', P, T.owner)).json, b = (await api('GET', P, T.alice)).json;

  const r1 = await api('POST', P + '/changes', T.owner, { changes: [{ key: 'post:p1', baseRev: a.revs['post:p1'], value: { id: 'p1', title: 'First', codes: { tone: 'pos' } } }] });
  assert.deepEqual([r1.status, r1.json.applied, r1.json.conflicts, r1.json.revision], [200, ['post:p1'], [], 2]);
  const r2 = await api('POST', P + '/changes', T.alice, { changes: [{ key: 'post:p2', baseRev: b.revs['post:p2'], value: { id: 'p2', title: 'Second', codes: { tone: 'neg' } } }] });
  assert.deepEqual([r2.json.applied, r2.json.conflicts, r2.json.revision], [['post:p2'], [], 3], 'a different post: no conflict');

  // alice edits p1 from the revision she loaded (1), after the owner changed it (2)
  const r3 = await api('POST', P + '/changes', T.alice, { changes: [
    { key: 'post:p1', baseRev: b.revs['post:p1'], value: { id: 'p1', title: 'First', codes: { tone: 'neg' } } },
    { key: 'codebook', baseRev: b.revs.codebook, value: [{ name: 'tone', type: 'categorical', categories: ['pos', 'neg', 'mixed'] }] }
  ] });
  assert.deepEqual(r3.json.applied, ['codebook'], 'the rest of the batch still applies');
  assert.equal(r3.json.conflicts.length, 1);
  assert.deepEqual(r3.json.conflicts[0], { key: 'post:p1', rev: 2, value: { id: 'p1', title: 'First', codes: { tone: 'pos' } } }, 'the current version comes back for resolving');
  const now = (await api('GET', P, T.owner)).json;
  assert.deepEqual(now.data.posts.find(p => p.id === 'p1').codes, { tone: 'pos' }, 'the owner\'s coding was not overwritten');

  // Resolving: alice re-sends from the current revision → applied
  const r4 = await api('POST', P + '/changes', T.alice, { changes: [{ key: 'post:p1', baseRev: 2, value: { id: 'p1', title: 'First', codes: { tone: 'neg' } } }] });
  assert.deepEqual(r4.json.applied, ['post:p1']);

  // New and deleted posts; invalid changes are reported, not applied
  const cur = (await api('GET', P, T.owner)).json;
  const r5 = await api('POST', P + '/changes', T.owner, { changes: [
    { key: 'post:p9', baseRev: 0, value: { id: 'p9', title: 'New' } },
    { key: 'post:p2', baseRev: cur.revs['post:p2'], value: null },
    { key: 'post:p1', baseRev: cur.revs['post:p1'], value: { id: 'other', title: 'id mismatch' } },
    { key: '__proto__', baseRev: 0, value: {} },
    { key: 'meta', baseRev: cur.revs.meta, value: 'not an object' }
  ] });
  assert.deepEqual(r5.json.applied.sort(), ['post:p2', 'post:p9']);
  assert.deepEqual(r5.json.invalid.sort(), ['__proto__', 'meta', 'post:p1']);
  const after = (await api('GET', P, T.alice)).json;
  assert.deepEqual(after.data.posts.map(p => p.id), ['p1', '3', 'p9']);
  assert.equal((await api('POST', P + '/changes', T.owner, { changes: [{ key: 'post:p9', baseRev: 0, value: { id: 'p9', title: 'again' } }] })).json.conflicts.length, 1, 'creating a post someone else just created is a conflict');

  // What changed since a revision (what a reconnecting client fetches)
  const d = await api('GET', P + '?since=' + cur.revision, T.alice);
  assert.equal(d.json.revision, after.revision);
  assert.deepEqual(d.json.changes.map(c => [c.key, c.value && c.value.id]).sort(), [['post:p2', null], ['post:p9', 'p9']], 'a deleted post comes back as null');
  assert.equal(d.json.changes.find(c => c.key === 'post:p2').value, null);
  assert.deepEqual(d.json.order, ['p1', '3', 'p9'], 'the post order, when posts changed');
  assert.equal(d.json.data, undefined, 'only the changes');

  // Renaming (editors can) is the meta entity
  const rn = await api('PATCH', P, T.alice, { name: 'Renamed' });
  assert.equal(rn.status, 200);
  const named = (await api('GET', P, T.owner)).json;
  assert.deepEqual([named.project.name, named.data.project.name], ['Renamed', 'Renamed']);
  assert.equal((await api('POST', P + '/changes', T.owner, { changes: [] })).status, 400);
});

test('live events: presence, updates and chat reach everyone with the project open; history is kept; messages aren\'t duplicated', async () => {
  const id = await shareWith(['alice', 'bob'], 'editor', 'Live');
  await api('PATCH', '/projects/' + id + '/members/' + U.bob.id, T.owner, { role: 'viewer' });
  const P = '/projects/' + id;
  const so = stream(T.owner, id);
  const hello = await so.waitFor('hello');
  assert.deepEqual([hello.role, hello.you.email, hello.revision, hello.chatLatest], ['owner', 'owner@example.org', 1, 0]);
  assert.deepEqual(hello.users.map(u => u.email), ['owner@example.org']);

  const sa = stream(T.alice, id);
  const ah = await sa.waitFor('hello');
  assert.equal(ah.role, 'editor');
  const pres = await so.waitFor('presence', d => d.users.length === 2);
  assert.deepEqual(pres.users.map(u => u.email).sort(), ['alice@example.org', 'owner@example.org']);
  // A second tab of the same account doesn't count twice
  const sa2 = stream(T.alice, id);
  await sa2.waitFor('hello');
  assert.equal((await api('GET', P + '/members', T.owner)).json.online.length, 2);

  const cur = (await api('GET', P, T.alice)).json;
  await api('POST', P + '/changes', T.alice, { changes: [{ key: 'post:p1', baseRev: cur.revs['post:p1'], value: { id: 'p1', title: 'Live edit' } }] });
  const up = await so.waitFor('updated');
  assert.deepEqual([up.revision, up.keys, up.by.email], [2, ['post:p1'], 'alice@example.org']);

  // Chat: viewers can chat too; a re-sent message (same clientId) isn't duplicated
  const sb2 = stream(T.bob, id);
  await sb2.waitFor('hello');
  const m1 = await api('POST', P + '/chat', T.bob, { text: '  Is p1 done?\r\n ', clientId: 'cli-abc-1' });
  assert.equal(m1.status, 200);
  assert.deepEqual([m1.json.message.text, m1.json.message.from.email, m1.json.duplicate], ['Is p1 done?', 'bob@example.org', false]);
  const seen = await so.waitFor('chat');
  assert.equal(seen.message.text, 'Is p1 done?');
  const again = await api('POST', P + '/chat', T.bob, { text: 'Is p1 done?', clientId: 'cli-abc-1' });
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.message.seq, m1.json.message.seq);
  await api('POST', P + '/chat', T.alice, { text: 'Yes <b>done</b>', clientId: 'cli-xyz-2' });
  const hist = await api('GET', P + '/chat', T.owner);
  assert.deepEqual(hist.json.messages.map(m => [m.seq, m.from.email, m.text]), [[1, 'bob@example.org', 'Is p1 done?'], [2, 'alice@example.org', 'Yes <b>done</b>']], 'stored as text; the page escapes it');
  assert.deepEqual((await api('GET', P + '/chat?after=1', T.bob)).json.messages.map(m => m.seq), [2]);
  assert.deepEqual((await api('GET', P + '/chat?before=2', T.bob)).json.messages.map(m => m.seq), [1]);
  assert.equal((await api('POST', P + '/chat', T.bob, { text: '' })).status, 400);
  assert.equal((await api('POST', P + '/chat', T.bob, { text: 'x'.repeat(2001) })).status, 400);

  // Closing a stream updates everyone's presence
  await sa.close(); await sa2.close();
  const left = await so.waitFor('presence', d => !d.users.some(u => u.email === 'alice@example.org'));
  assert.deepEqual(left.users.map(u => u.email).sort(), ['bob@example.org', 'owner@example.org']);
  // Reconnecting gets the current revision and the latest chat seq to catch up from
  const back = stream(T.alice, id);
  const bh = await back.waitFor('hello');
  assert.deepEqual([bh.revision, bh.chatLatest], [2, 2]);
  await back.close(); await sb2.close(); await so.close();
});

test('removing someone ends their access at once: requests 404, their open stream gets "revoked"; people can leave; the owner can\'t', async () => {
  const id = await shareWith(['alice', 'bob'], 'editor', 'Removal');
  const P = '/projects/' + id;
  const sa = stream(T.alice, id);
  await sa.waitFor('hello');
  const so = stream(T.owner, id);
  await so.waitFor('hello');

  const r = await api('DELETE', P + '/members/' + U.alice.id, T.owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.members.map(m => m.email).sort(), ['bob@example.org', 'owner@example.org']);
  const rev = await sa.waitFor('revoked');
  assert.equal(rev.projectId, id);
  await sa.waitFor('_end');
  await so.waitFor('members', d => d.members.length === 2);
  assert.equal((await api('GET', P, T.alice)).status, 404);
  assert.equal((await api('POST', P + '/chat', T.alice, { text: 'still here?' })).status, 404);
  assert.ok(!(await api('GET', '/projects', T.alice)).json.projects.some(p => p.id === id));

  // bob leaves on his own
  assert.equal((await api('DELETE', P + '/members/' + U.bob.id, T.bob)).status, 200);
  assert.equal((await api('GET', P, T.bob)).status, 404);
  // the owner can't leave (or be removed)
  const own = await api('DELETE', P + '/members/' + U.owner.id, T.owner);
  assert.equal(own.status, 400);
  assert.equal((await api('PATCH', P + '/members/' + U.owner.id, T.owner, { role: 'viewer' })).status, 400);
  // and alice can be invited back
  const inv = await api('POST', P + '/invites', T.owner, { emails: ['alice@example.org'], role: 'viewer' });
  assert.equal(inv.json.results[0].status, 'invited');
  await so.close();
});

test('a role change takes effect on the next request (no stale permissions)', async () => {
  const id = await shareWith(['alice'], 'editor', 'Demotion');
  const P = '/projects/' + id;
  const cur = (await api('GET', P, T.alice)).json;
  await api('PATCH', P + '/members/' + U.alice.id, T.owner, { role: 'viewer' });
  const r = await api('POST', P + '/changes', T.alice, { changes: [{ key: 'post:p1', baseRev: cur.revs['post:p1'], value: { id: 'p1', title: 'x' } }] });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.role, 'viewer');
  assert.equal((await api('PATCH', P + '/members/' + U.alice.id, T.owner, { role: 'admin' })).status, 400, 'only editor or viewer');
});

test('deleting a shared project: owner only; everyone\'s stream gets "deleted"; invitations to it stop working', async () => {
  const id = await shareWith(['alice'], 'editor', 'Deleting');
  const inv = await api('POST', '/projects/' + id + '/invites', T.owner, { emails: ['bob@example.org'], role: 'viewer' });
  const sa = stream(T.alice, id);
  await sa.waitFor('hello');
  assert.equal((await api('DELETE', '/projects/' + id, T.alice)).status, 403);
  assert.equal((await api('DELETE', '/projects/' + id, T.owner)).status, 200);
  const d = await sa.waitFor('deleted');
  assert.equal(d.by.email, 'owner@example.org');
  await sa.waitFor('_end');
  assert.equal((await api('GET', '/projects/' + id, T.owner)).status, 404);
  assert.ok(!(await api('GET', '/projects', T.alice)).json.projects.some(p => p.id === id));
  assert.equal((await api('GET', '/invites/' + linkToken(inv.json.results[0].link))).status, 404);
  assert.ok(!fs.existsSync(path.join(tmp, 'collab', 'projects', id + '.json')));
});

test('limits: chat messages per minute, members per project, open streams per account', async () => {
  const id = await shareWith(['alice'], 'viewer', 'Limits');
  const P = '/projects/' + id;
  let limited = null;
  for (let i = 0; i < 31 && !limited; i++) {
    const r = await api('POST', P + '/chat', T.alice, { text: 'm' + i });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the 31st message in a minute is refused');
  assert.equal(limited.json.error.type, 'rate_limited');
  assert.ok(limited.json.error.retryAfterSeconds >= 1);

  // 25 people per project (members + open invitations)
  const emails = Array.from({ length: 24 }, (_, i) => 'person' + i + '@example.com');
  const many = await api('POST', P + '/invites', T.owner, { emails: emails.slice(0, 20), role: 'viewer' });
  assert.ok(many.json.results.every(r => r.status === 'invited'));
  const more = await api('POST', P + '/invites', T.owner, { emails: emails.slice(20), role: 'viewer' });
  assert.deepEqual(more.json.results.map(r => r.status), ['invited', 'invited', 'invited', 'limit'], '2 members + 23 invitations = 25');
  assert.equal((await api('POST', P + '/invites', T.owner, { emails: Array.from({ length: 21 }, (_, i) => 'x' + i + '@example.com'), role: 'viewer' })).status, 400, 'at most 20 at a time');

  const streams = [];
  for (let i = 0; i < 8; i++) { const s = stream(T.alice, id); await s.waitFor('hello'); streams.push(s); }
  const ninth = stream(T.alice, id);
  assert.equal((await ninth.waitFor('_status')).status, 429);
  for (const s of streams) await s.close();
});

test('a stream the browser closes while it\'s being set up doesn\'t stay "open now"', async () => {
  const id = await shareWith([], null, 'Ghosts');
  // The slow steps: checking the sign-in (Supabase, Stripe) and reading the chat
  for (const [what, obj, fn] of [['sign-in check', mod.accounts, 'contextOf'], ['chat read', mod.collab.store, 'chat']]) {
    const orig = obj[fn];
    let reached = () => {};
    const slow = new Promise(r => { reached = r; });
    obj[fn] = async function (...a) { reached(); await new Promise(r => setTimeout(r, 300)); return orig.apply(this, a); };
    try {
      const s = stream(T.owner, id);
      await slow;
      await s.close();                       // e.g. the page was reloaded
      await new Promise(r => setTimeout(r, 500));
    } finally { obj[fn] = orig; }
    assert.deepEqual(mod.collab.online(id), [], what);
  }
  // …and a stream that stays open is still counted
  const s = stream(T.owner, id);
  await s.waitFor('hello');
  assert.deepEqual(mod.collab.online(id).map(u => u.email), ['owner@example.org']);
  await s.close();
});

test('bodies the server can\'t read get a JSON answer saying why', async () => {
  const bad = await fetch(base + '/api/collab/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + T.owner, 'Content-Type': 'application/json' }, body: '{"name": "x", data: ' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, 'invalid_request');
  const big = await fetch(base + '/api/collab/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + T.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { posts: [{ id: 'p', text: 'x'.repeat(26 * 1024 * 1024) }] } }) });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.type, 'too_large');
});

test('the server keeps at most 200 projects in memory and reads the others from disk', async () => {
  const { CollabStore } = require('../collab/store');
  const dir = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const st = new CollabStore(dir);
  const ids = [];
  for (let i = 0; i < 205; i++) ids.push((await st.create({ id: 'u1', email: 'u1@example.org' }, { posts: [{ id: 'a' + i }] }, 'P' + i)).id);
  assert.equal(st.cache.size, 200);
  const first = await st.get(ids[0]);
  assert.equal(first.name, 'P0', 'evicted, then read again');
  assert.equal(st.cache.size, 200);
  // A failed write leaves the file as the truth
  const out = await st.update(ids[1], p => { p.name = 'changed in memory only'; throw new Error('disk full'); }).catch(e => e);
  assert.match(String(out.message), /disk full/);
  assert.equal((await st.get(ids[1])).name, 'P1');
});

test('with accounts turned off, sharing says so instead of failing oddly', async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = '';
  try {
    const cfg = await api('GET', '/config');
    assert.deepEqual([cfg.json.enabled, cfg.json.signedIn], [false, false]);
    const r = await api('GET', '/projects', T.owner);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.type, 'sharing_unavailable');
  } finally { process.env.SUPABASE_URL = saved; }
});
