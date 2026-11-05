// lib/keepalive.js: a streamed AI response never stays silent for longer than the setting
// (AI_KEEPALIVE_SECONDS), wherever in the check interval the last write fell.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { keepAlive, keepAliveMs } = require('../lib/keepalive');

function fakeResponse() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  res.write = text => { res.writes.push({ at: Date.now(), text }); return true; };
  return res;
}

test('AI_KEEPALIVE_SECONDS: 15 s by default, 1–60 s', () => {
  assert.equal(keepAliveMs({}), 15000);
  assert.equal(keepAliveMs({ AI_KEEPALIVE_SECONDS: '5' }), 5000);
  assert.equal(keepAliveMs({ AI_KEEPALIVE_SECONDS: '0.5' }), 15000);
  assert.equal(keepAliveMs({ AI_KEEPALIVE_SECONDS: '600' }), 60000);
});

test('the longest silence is the setting, also when the response\'s own write came just after a check', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  for (const seconds of [1, 2, 3, 7, 15, 46, 60]) {
    const ms = seconds * 1000;
    for (const offset of [0, 1, 17, Math.floor(ms / 3) - 1, Math.floor(ms / 2)]) {
      const res = fakeResponse();
      const alive = keepAlive(res, '\n', ms);
      const start = Date.now();
      // the response writes something of its own `offset` ms after the alive timer started
      t.mock.timers.tick(offset);
      alive.touch();
      const touched = Date.now();
      for (let i = 0; i < 5 * ms; i += 10) t.mock.timers.tick(10);
      const times = [touched].concat(res.writes.map(w => w.at), [Date.now()]);
      let longest = 0;
      for (let i = 1; i < times.length; i++) longest = Math.max(longest, times[i] - times[i - 1]);
      assert.ok(res.writes.length >= 4, seconds + ' s: ' + res.writes.length + ' keep-alives in ' + (5 * seconds) + ' s');
      assert.ok(longest <= ms, seconds + ' s, touched ' + offset + ' ms in: silent for ' + longest + ' ms');
      assert.ok(longest >= ms / 2, 'not more often than needed (' + longest + ' ms)');
      alive.stop();
      res.emit('close');
      assert.ok(Date.now() - start > 0);
    }
  }
});

test('it stops when the response ends or closes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const res = fakeResponse();
  const run = ms => { for (let i = 0; i < ms; i += 10) t.mock.timers.tick(10); };
  keepAlive(res, ': keep-alive\n\n', 1000);
  run(5000);
  const n = res.writes.length;
  assert.ok(n >= 5, String(n));
  res.writableEnded = true;
  run(5000);
  assert.equal(res.writes.length, n);

  const res2 = fakeResponse();
  keepAlive(res2, '\n', 1000);
  res2.emit('close');
  run(5000);
  assert.equal(res2.writes.length, 0);
});
