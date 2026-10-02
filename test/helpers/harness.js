// Test harness: a scraper instance on its own HTTP server (with the real Wisp
// endpoint and epoxy-tls transport), an SSE reader, and a scriptable fake
// transport for unit tests that shouldn't touch the network.

const http = require('http');
const express = require('express');
const { loadScraperConfig } = require('../../scraper/config');
const { createScraper } = require('../../scraper');

const TEST_UA = 'nodejs:metacode-tests:1.0 (by /u/metacode_tests)';

function testEnv(extra) {
  return Object.assign({
    SCRAPER_USER_AGENT: TEST_UA,
    SCRAPER_ALLOW_PRIVATE_NETWORK: 'true',
    SCRAPER_MIN_DELAY_MS: '0',
    SCRAPER_PUBLIC_MIN_DELAY_MS: '0',
    SCRAPER_DEFAULT_DELAY_MS: '0'
  }, extra || {});
}

function testConfig(extra) {
  return loadScraperConfig(testEnv(extra));
}

async function startScraperApp(env) {
  const config = loadScraperConfig(testEnv(env));
  const scraper = createScraper({ config, logToConsole: false });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/scraper', scraper.router);
  app.use('/scramjet', scraper.scramjetRouter);
  const server = http.createServer(app);
  server.on('upgrade', scraper.onUpgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  scraper.setPort(port);
  return {
    scraper, config, port,
    url: 'http://127.0.0.1:' + port,
    api: 'http://127.0.0.1:' + port + '/api/scraper',
    async close() {
      scraper.shutdown();
      scraper.onUpgrade.closeAll();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json, headers: res.headers };
}

async function getJson(url) {
  const res = await fetch(url);
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

// Reads a server-sent event stream until it ends (or `timeoutMs` passes).
async function readEvents(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  const events = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        const data = [];
        block.split('\n').forEach(line => {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data.push(line.slice(6));
        });
        if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function waitForJob(api, id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  for (;;) {
    const { json } = await getJson(api + '/jobs/' + id);
    if (json && json.job && ['completed', 'failed', 'cancelled'].includes(json.job.status)) return json.job;
    if (Date.now() > deadline) throw new Error('Job ' + id + ' did not finish in time (status ' + (json && json.job && json.job.status) + ')');
    await new Promise(r => setTimeout(r, 50));
  }
}

// A transport whose answers are scripted per request: handler(req) → response
// object { status, headers, body } or throws.
class FakeTransport {
  constructor(handler) {
    this.handler = handler;
    this.requests = [];
  }
  async request(req) {
    this.requests.push(req);
    if (req.signal && req.signal.aborted) throw req.signal.reason;
    const r = await this.handler(req, this.requests.length);
    return Object.assign({ status: 200, statusText: 'OK', headers: {}, body: '', url: req.url }, r);
  }
}

const json = (body, extraHeaders) => ({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}), body: JSON.stringify(body) });

module.exports = { TEST_UA, testEnv, testConfig, startScraperApp, postJson, getJson, readEvents, waitForJob, FakeTransport, json };
