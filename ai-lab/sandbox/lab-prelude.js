/* ══════════════════════════════════════════════
   lab-prelude.js — the AI Coding Lab's harness for coding rules (classify/1)

   Evaluated INSIDE the QuickJS sandbox (scraper/sandbox/sandbox-child.js,
   started by ai-lab/code-sandbox.js), never in Node, before the user's code.
   It takes the two host functions the child installs and removes them from
   the global scope, so the user's code has no way out at all:

     __host_call('input.next', '{}') → Promise<json>   the next batch of records
     __host_send(name, json)                           log / emit / progress

   'input.next' is the only call the parent answers; there is no fetch, no
   timers and no other host service. Records arrive in batches pulled by
   this file (never all at once), each one a fresh deep-frozen copy without
   labels; results leave in batches of about 256 KB. The parent checks every
   message again (sizes, counts, one result per record), so nothing here is
   trusted for safety — this file only makes honest code work well.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  var hostCall = globalThis.__host_call;
  var hostSend = globalThis.__host_send;
  delete globalThis.__host_call;
  delete globalThis.__host_send;

  // Taken now: the user's code runs after this file and may replace globals.
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var freeze = Object.freeze;
  var isFrozen = Object.isFrozen;
  var ownNames = Object.getOwnPropertyNames;
  var now = Date.now;
  var toString = String;
  var LabError = Error;

  var BATCH_CHARS = 256 * 1024;       // flush results at about this size
  var MAX_RESULT_CHARS = 64 * 1024;   // one record's result (a code, a confidence and a short reason)
  var MAX_LOG_CHARS = 4000;
  var PROGRESS_EVERY = 50;
  var STACK_LINES = 6;

  function send(name, value) { hostSend(name, stringify(value)); }

  function text(x) {
    if (typeof x === 'string') return x;
    try {
      if (x instanceof LabError) return x.name + ': ' + x.message;
      var s = stringify(x);
      return s === undefined ? toString(x) : s;
    } catch (e) {
      try { return toString(x); } catch (e2) { return '[unprintable value]'; }
    }
  }

  function logAt(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts[parts.length] = text(arguments[i]);
      send('log', { level: level, message: parts.join(' ').slice(0, MAX_LOG_CHARS) });
    };
  }

  // console.log/info/debug → stdout; warn and error → stderr (the parent maps levels to streams).
  globalThis.console = freeze({
    log: logAt('info'), info: logAt('info'), debug: logAt('info'), warn: logAt('warn'), error: logAt('error')
  });

  function deepFreeze(x) {
    if (x !== null && typeof x === 'object' && !isFrozen(x)) {
      freeze(x);
      var keys = ownNames(x);
      for (var i = 0; i < keys.length; i++) deepFreeze(x[keys[i]]);
    }
    return x;
  }

  // "Name: message" plus the first stack lines of the user's code (the
  // harness's own frames, in sdk.js, are left out).
  function errorText(e) {
    var name = 'Error';
    var message = '';
    var stack = '';
    try {
      if (e !== null && typeof e === 'object') {
        name = toString(e.name || 'Error');
        message = toString(e.message === undefined ? '' : e.message);
        if (typeof e.stack === 'string') stack = e.stack;
      } else {
        name = 'Thrown value';
        message = toString(e);
      }
    } catch (err) {
      message = '(the error could not be read)';
    }
    var lines = [];
    var all = stack.split('\n');
    for (var i = 0; i < all.length && lines.length < STACK_LINES; i++) {
      if (!all[i].trim() || all[i].indexOf('sdk.js') !== -1) continue;
      lines[lines.length] = all[i];
    }
    return (name + ': ' + message + (lines.length ? '\n' + lines.join('\n') : '')).slice(0, 4000);
  }

  // QuickJS's memory limit: stop the run (the parent reports memory_limit)
  // instead of recording one error per record. Time-limit interrupts can't
  // be caught at all.
  function outOfMemory(e) {
    try {
      return e !== null && typeof e === 'object' && e.name === 'InternalError' && toString(e.message).indexOf('out of memory') !== -1;
    } catch (err) {
      return false;
    }
  }

  // One record → the JSON text of { id, out, ms } or { id, error, ms }.
  function classifyOne(classify, record, variable) {
    var id = stringify(toString(record.id));
    var t0 = now();
    var out;
    try {
      out = classify(record, variable);
    } catch (e) {
      if (outOfMemory(e)) throw e;
      return { failed: true, json: '{"id":' + id + ',"error":' + stringify(errorText(e)) + ',"ms":' + (now() - t0) + '}' };
    }
    var ms = now() - t0;
    var problem = null;
    var json;
    try {
      if (out !== null && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function') {
        problem = 'classify must return a value, not a Promise (it can\'t be async)';
      } else if (typeof out === 'function' || typeof out === 'symbol' || typeof out === 'bigint') {
        problem = 'classify returned a value that isn\'t JSON (a ' + typeof out + ')';
      } else {
        json = out === undefined ? undefined : stringify(out);
        if (json !== undefined && json.length > MAX_RESULT_CHARS) {
          problem = 'classify returned ' + Math.round(json.length / 1024) + ' KB for one record (at most ' + (MAX_RESULT_CHARS / 1024) + ' KB)';
        }
      }
    } catch (e) {
      if (outOfMemory(e)) throw e;
      problem = 'classify returned a value that isn\'t JSON';
    }
    if (problem) return { failed: true, json: '{"id":' + id + ',"error":' + stringify(problem) + ',"ms":' + ms + '}' };
    return { failed: false, json: '{"id":' + id + (json === undefined ? '' : ',"out":' + json) + ',"ms":' + ms + '}' };
  }

  globalThis.__metacode_run = async function (initJson) {
    var init = parse(initJson);
    var variable = deepFreeze(init.variable);
    var total = Number(init.total) || 0;
    // Bound by the child after the user's code (works for const/let too).
    var classify = globalThis.classify;
    if (typeof classify !== 'function') throw new LabError('Define a function classify(record, variable)');

    var processed = 0;
    var errors = 0;
    var batch = [];
    var batchChars = 0;
    var flush = function () {
      if (!batch.length) return;
      hostSend('emit', '[' + batch.join(',') + ']');
      batch = [];
      batchChars = 0;
    };

    for (;;) {
      var reply = parse(await hostCall('input.next', '{}'));
      var records = reply && reply.records ? reply.records : [];
      for (var i = 0; i < records.length; i++) {
        var result = classifyOne(classify, deepFreeze(records[i]), variable);
        if (result.failed) errors++;
        if (batchChars + result.json.length > BATCH_CHARS) flush();
        batch[batch.length] = result.json;
        batchChars += result.json.length + 1;
        processed++;
        if (processed % PROGRESS_EVERY === 0) send('progress', { done: processed, total: total });
      }
      if (!reply || reply.done || !records.length) break;
    }
    flush();
    if (processed % PROGRESS_EVERY !== 0) send('progress', { done: processed, total: total });
    return stringify({ processed: processed, errors: errors });
  };
})();
