/* ══════════════════════════════════════════════
   survey-public.js — the published survey page (/s/<publicId>)
   Loads the published version and records the response through the
   public API. No editor code or editor data is loaded here.

   Before the survey starts, respondents are told what is recorded beyond
   their answers: a session timeline (when the survey's settings turn it on)
   and metadata such as the IP address (when a Respondent information block
   collects it). With "ask for consent", the timeline is recorded only if the
   respondent allows it. Timeline events go to the server with each save, and
   once more if the respondent leaves before finishing.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const main = document.getElementById('svp-main');
  const publicId = (location.pathname.match(/\/s\/([A-Za-z0-9]{4,40})/) || [])[1];
  const api = '/api/public/surveys/' + encodeURIComponent(publicId || '');
  const MAX_EVENTS = 3000;

  function stateBox(title, text) {
    main.innerHTML = '<div class="svp-state"><h1></h1><p></p></div>';
    main.querySelector('h1').textContent = title;
    main.querySelector('p').textContent = text;
  }

  async function request(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error('Couldn\'t reach the survey server. Check your internet connection.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || ('The server answered ' + res.status + '.'));
      err.status = res.status;
      err.problems = data && data.problems;
      throw err;
    }
    return data;
  }

  // What respondents are told before they begin. Resolves to the recording mode:
  // 'off' (nothing to record), 'notice' / 'consent' (recording), 'declined'.
  function disclose(doc) {
    const priv = SurveyCore.privacyOf(doc);
    const items = [];
    if (priv.session !== 'off') items.push(doc.settings.sessionNotice || SurveyCore.SESSION_NOTICE);
    const derived = SurveyCore.derivedNotice(priv);
    if (derived) items.push(derived);
    if (priv.link && !priv.link.show) items.push('The participant code in your survey link is saved with your response.');
    if (!items.length) return Promise.resolve(priv.session);
    return new Promise(resolve => {
      main.innerHTML = '';
      const box = document.createElement('section');
      box.className = 'svp-notice';
      box.setAttribute('aria-labelledby', 'svp-notice-h');
      box.innerHTML = '<h1 id="svp-notice-h"></h1><p class="svp-sub">Before you begin, here is what this survey records besides your answers.</p><ul></ul><div class="svp-actions"></div>';
      box.querySelector('h1').textContent = doc.title || 'Survey';
      const ul = box.querySelector('ul');
      items.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      const actions = box.querySelector('.svp-actions');
      const button = (label, cls, value) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'svp-btn ' + cls; b.textContent = label;
        b.addEventListener('click', () => resolve(value));
        actions.appendChild(b);
        return b;
      };
      let first;
      if (priv.session === 'consent') {
        first = button('Allow and start', 'svp-btn-primary', 'consent');
        button('Start without the timeline', 'svp-btn-secondary', 'declined');
      } else first = button('Start the survey', 'svp-btn-primary', priv.session);
      main.appendChild(box);
      first.focus();
    });
  }

  async function start() {
    if (!publicId) return stateBox('Survey not found', 'This link doesn\'t point to a survey.');
    let survey;
    try { survey = (await request('GET', api)).survey; } catch (e) {
      return stateBox(e.status === 404 ? 'Survey not found' : 'Couldn\'t load the survey', e.status === 404 ? 'This survey link isn\'t valid or the survey is no longer available.' : e.message);
    }
    const doc = survey.doc;
    document.title = doc.title || 'Survey';
    const tokens = (doc.theme && doc.theme.tokens) || {};
    if (tokens.background) document.body.style.setProperty('--page-bg', tokens.background);
    if (window.SurveyFonts) window.SurveyFonts.ensureDoc(doc);
    if (!survey.open) return stateBox(doc.title || 'Survey closed', 'This survey isn\'t accepting responses right now.');

    const recording = await disclose(doc);
    const recordEvents = recording === 'notice' || recording === 'consent';
    const sessionStart = Date.now();
    let pending = [];
    let total = 0;
    const record = ev => {
      if (!recordEvents || total >= MAX_EVENTS) return;
      total++;
      const out = Object.assign({}, ev, { t: Math.max(0, ev.at - sessionStart) });
      delete out.at;
      pending.push(out);
    };
    const session = () => ({ recording: recording === 'off' ? undefined : recording, startedAt: new Date(sessionStart).toISOString() });

    let responseId = null, token = null, saving = Promise.resolve(), finished = false;
    const send = (payload, complete) => {
      const events = pending.splice(0);
      const body = Object.assign({}, payload, { version: survey.version, complete, events, session: session() });
      saving = saving.catch(() => {}).then(async () => {
        try {
          if (responseId) {
            await request('PUT', api + '/responses/' + encodeURIComponent(responseId), Object.assign({ token }, body));
          } else {
            const out = await request('POST', api + '/responses', body);
            responseId = out.responseId; token = out.token;
          }
          if (complete) finished = true;
        } catch (e) {
          pending = events.concat(pending);   // try again with the next save
          throw e;
        }
      });
      return saving;
    };

    main.innerHTML = '';
    // The participant's random seed is kept in this browser for this survey, so a
    // reload keeps the same randomly assigned condition.
    let seed = null;
    const seedKey = 'metacode_seed_' + survey.publicId;
    try { seed = localStorage.getItem(seedKey); if (!seed) { seed = SurveyLogic.newSeed(); localStorage.setItem(seedKey, seed); } } catch (e) { seed = null; }
    const params = {};
    new URLSearchParams(location.search).forEach((v, k) => { if (!(k in params)) params[k] = v; });
    const rt = SurveyRuntime.mount(main, doc, {
      mode: 'live',
      seed: seed || undefined,
      balance: survey.balance || {},
      params,
      onEvent: record,
      onProgress: payload => send(payload, false),
      onSubmit: payload => send(payload, true)
    });

    // Leaving the survey tab (and coming back) is part of the timeline.
    document.addEventListener('visibilitychange', () => {
      if (finished) return;
      record({ type: document.visibilityState === 'hidden' ? 'away' : 'back', at: Date.now() });
    });
    window.addEventListener('pageshow', e => { if (e.persisted && !finished) record({ type: 'resume', at: Date.now() }); });
    // Leaving before the end: the last events (and answers given so far) are sent
    // with keepalive so they arrive even though the page is closing.
    window.addEventListener('pagehide', () => {
      if (finished) return;
      rt.flushEvents();
      record({ type: 'abandon', at: Date.now(), page: rt.currentPage() });
      const events = pending.splice(0);
      const post = (url, body) => { try { fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { /* the page is closing */ } };
      if (responseId) { if (events.length) post(api + '/responses/' + encodeURIComponent(responseId) + '/events', { token, events }); }
      else if (rt.answeredCount() > 0) post(api + '/responses', Object.assign({}, rt.snapshot(), { version: survey.version, complete: false, events, session: session() }));
    });
  }
  start();
})();
