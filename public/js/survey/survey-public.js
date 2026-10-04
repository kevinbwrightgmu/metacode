/* ══════════════════════════════════════════════
   survey-public.js — the published survey page (/s/<publicId>)
   Loads the published version and records the response through the
   public API. No editor code or editor data is loaded here.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const main = document.getElementById('svp-main');
  const publicId = (location.pathname.match(/\/s\/([A-Za-z0-9]{4,40})/) || [])[1];
  const api = '/api/public/surveys/' + encodeURIComponent(publicId || '');

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
    if (!survey.open) return stateBox(doc.title || 'Survey closed', 'This survey isn\'t accepting responses right now.');

    let responseId = null, token = null, saving = Promise.resolve();
    const send = (payload, complete) => {
      const body = Object.assign({}, payload, { version: survey.version, complete });
      saving = saving.catch(() => {}).then(async () => {
        if (responseId) {
          await request('PUT', api + '/responses/' + encodeURIComponent(responseId), Object.assign({ token }, body));
        } else {
          const out = await request('POST', api + '/responses', body);
          responseId = out.responseId; token = out.token;
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
    SurveyRuntime.mount(main, doc, {
      mode: 'live',
      seed: seed || undefined,
      balance: survey.balance || {},
      onProgress: payload => send(payload, false),
      onSubmit: payload => send(payload, true)
    });
  }
  start();
})();
