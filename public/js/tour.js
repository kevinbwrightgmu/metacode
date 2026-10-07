/* ══════════════════════════════════════════════
   tour.js — guided tours

   A spotlight moves from one part of the page to the next, with a card that
   explains it. Tours are lists of steps:

     { target: '#run-btn' | ['#a', '.b'] | () => element | null,   first one found; null = centred card
       title, text (HTML),
       before: async () => {},                    e.g. open the page the step is about
       placement: 'right' | 'left' | 'bottom' | 'top' (default: whichever fits),
       buttons: [{ label, onClick, primary }],    extra buttons on the card
       // Hands-on steps (tutorials):
       interactive: true,                         the page stays usable (only keys aimed at the card are handled)
       until: () => boolean,                      checked every 1/4 s; when it turns true the step
       done: 'Nice!' }                            says so and moves on by itself

   Tour.define(name, steps) · Tour.start(name, { at }) · Tour.stop()
   Tour.invite(name, { title, text })  — a small, non-blocking "take the tour?" card
   Tour.seen(name) — whether it was finished or dismissed (kept in localStorage)

   Keys: → / Enter next, ← back, Esc closes. The page underneath can't be
   clicked while a tour runs, so nothing changes by accident — except in
   interactive steps, where doing the thing is the point.
   ══════════════════════════════════════════════ */
const Tour = (() => {
  'use strict';
  const tours = {};
  const hooks = {};      // name → { onFinish, onClose }
  const KEY = name => 'metacode_tour_' + name;
  let run = null;          // { name, steps, i, token }
  let els = null;
  let raf = 0;

  const seen = name => { try { return !!localStorage.getItem(KEY(name)); } catch (e) { return false; } };
  const remember = (name, how) => { try { localStorage.setItem(KEY(name), how); } catch (e) { /* ignore */ } };
  const reset = name => { try { localStorage.removeItem(KEY(name)); } catch (e) { /* ignore */ } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function define(name, steps, opts) { tours[name] = steps; hooks[name] = opts || {}; }

  function find(target) {
    const list = Array.isArray(target) ? target : [target];
    for (const sel of list) {
      if (!sel) continue;
      let el;
      try { el = typeof sel === 'string' ? document.querySelector(sel) : typeof sel === 'function' ? sel() : sel; } catch (e) { el = null; }
      if (el && el.getClientRects().length) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }
  async function waitFor(target, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const el = find(target);
      if (el || Date.now() > end) return el;
      await sleep(60);
    }
  }

  /* ── DOM ─────────────────────────────────── */
  function build() {
    if (els) return els;
    const shield = document.createElement('div');
    shield.className = 'tour-shield';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const pop = document.createElement('div');
    pop.className = 'tour-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'tour-title');
    pop.setAttribute('aria-describedby', 'tour-text');
    pop.tabIndex = -1;
    document.body.append(shield, spot, pop);
    shield.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    spot.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    pop.addEventListener('click', e => {
      const b = e.target.closest('[data-tour]');
      if (!b) return;
      const act = b.dataset.tour;
      if (act === 'next') go(run.i + 1);
      else if (act === 'back') go(run.i - 1);
      else if (act === 'close') stop(true);
      else if (act === 'custom') { const s = run.steps[run.i]; const btn = s.buttons && s.buttons[Number(b.dataset.idx)]; if (btn && btn.onClick) btn.onClick(); }
    });
    els = { shield, spot, pop };
    return els;
  }
  function onKey(e) {
    if (!run) return;
    // In a hands-on step the page is being used: only keys aimed at the card count
    if (run.steps[run.i] && run.steps[run.i].interactive && !(els && els.pop.contains(e.target))) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(true); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('button'))) { e.preventDefault(); e.stopPropagation(); go(run.i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (run.i > 0) go(run.i - 1); }
    else if (e.key === 'Tab') {
      // keep focus inside the card
      const f = Array.from(els.pop.querySelectorAll('button'));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    }
  }
  function onMove() { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); }

  /* ── Running ─────────────────────────────── */
  function start(name, opts) {
    const steps = tours[name];
    if (!steps || !steps.length) return false;
    closeInvite();
    stop(false);
    build();
    run = { name, steps, i: -1, token: 0, target: null };
    document.documentElement.classList.add('tour-on');
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    go(Math.max(0, Math.min(steps.length - 1, (opts && opts.at) || 0)));
    return true;
  }

  // Hands-on steps: watch for the action, keep the spotlight on its (moving) target
  let watch = null;
  function watchStep(step, token) {
    clearInterval(watch);
    if (!step.until && !step.interactive) return;
    let wasDone = false;
    try { wasDone = !!(step.until && step.until()); } catch (e) { wasDone = false; }
    if (wasDone) markDone(step, false);
    watch = setInterval(() => {
      if (!run || run.token !== token) { clearInterval(watch); return; }
      if (step.target) {
        const el = find(step.target);
        if (el && el !== run.target) { run.target = el; }
        place();
      }
      if (!step.until || els.pop.classList.contains('is-done')) return;
      let ok = false;
      try { ok = !!step.until(); } catch (e) { ok = false; }
      if (!ok) return;
      markDone(step, true);
      const at = run.i;
      setTimeout(() => { if (run && run.token === token && run.i === at) go(at + 1); }, step.doneDelay || 1100);
    }, 250);
  }
  function markDone(step, fresh) {
    els.pop.classList.add('is-done');
    const live = els.pop.querySelector('.tour-done');
    if (live) live.textContent = '✓ ' + (step.done || 'Done!') + (fresh ? '' : ' (already done)');
    const next = els.pop.querySelector('[data-tour="next"]');
    if (next && next.dataset.skip) { next.textContent = 'Next'; delete next.dataset.skip; }
  }

  async function go(i) {
    if (!run) return;
    clearInterval(watch);
    if (i >= run.steps.length) { const n = run.name; remember(n, 'done'); stop(false); if (hooks[n] && hooks[n].onFinish) hooks[n].onFinish(); return; }
    if (i < 0) return;
    const token = ++run.token;
    run.i = i;
    const step = run.steps[i];
    els.pop.classList.add('is-busy');
    els.pop.classList.remove('is-done');
    document.documentElement.classList.toggle('tour-interactive', !!step.interactive);
    els.pop.setAttribute('aria-modal', step.interactive ? 'false' : 'true');
    try { if (step.before) await step.before(); } catch (e) { console.warn('[tour] step setup failed', e); }
    if (!run || run.token !== token) return;
    const el = step.target ? await waitFor(step.target, step.wait || 2500) : null;
    if (!run || run.token !== token) return;
    run.target = el;
    if (el) {
      // Bring it into view vertically only — scrolling sideways could shift a whole
      // layout (e.g. a side panel that is still sliding in)
      const r = el.getBoundingClientRect();
      const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
      if (r.top < 0 || r.bottom > vh) {
        let box = el.parentElement;
        while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
        const want = r.height > vh * 0.7 ? 'start' : 'center';
        if (box && box !== document.body) {
          const b = box.getBoundingClientRect();
          box.scrollTop += want === 'start' ? r.top - b.top - 8 : (r.top + r.height / 2) - (b.top + b.height / 2);
        } else window.scrollBy(0, want === 'start' ? r.top - 8 : (r.top + r.height / 2) - vh / 2);
        await sleep(30);
      }
    }
    render(step);
    els.pop.classList.remove('is-busy');
    place();
    if (!step.interactive) {
      const next = els.pop.querySelector('[data-tour="next"]') || els.pop.querySelector('button');
      if (next) next.focus({ preventScroll: true });
    } else els.pop.focus({ preventScroll: true });     // screen readers read the instruction; the page keeps working
    watchStep(step, token);
  }

  function render(step) {
    const n = run.steps.length, i = run.i;
    const last = i === n - 1;
    const custom = (step.buttons || []).map((b, k) => '<button type="button" class="tour-btn ' + (b.primary ? 'is-primary' : '') + '" data-tour="custom" data-idx="' + k + '">' + esc(b.label) + '</button>').join('');
    const skip = step.until && !last;
    els.pop.innerHTML =
      '<div class="tour-head"><span class="tour-count">' + (step.kicker ? esc(step.kicker) + ' · ' : '') + (i + 1) + ' of ' + n + '</span>' +
        '<button type="button" class="tour-x" data-tour="close" aria-label="Close the tour" title="Close the tour (Esc)">✕</button></div>' +
      '<h2 class="tour-title" id="tour-title">' + esc(step.title) + '</h2>' +
      '<div class="tour-text" id="tour-text">' + (step.text || '') + '</div>' +
      (step.until ? '<div class="tour-done" role="status" aria-live="polite"></div>' : '') +
      '<div class="tour-progress" aria-hidden="true"><span style="width:' + Math.round((i + 1) / n * 100) + '%"></span></div>' +
      '<div class="tour-foot">' +
        (i > 0 ? '<button type="button" class="tour-btn" data-tour="back">Back</button>' : '<button type="button" class="tour-btn" data-tour="close">Skip tour</button>') +
        '<span class="tour-gap"></span>' + custom +
        (step.hideNext ? '' : '<button type="button" class="tour-btn ' + (skip ? '' : 'is-primary') + '" data-tour="next"' + (skip ? ' data-skip="1" title="Go on without doing this step"' : '') + '>' + (last ? 'Finish' : skip ? 'Skip step' : (i === 0 ? 'Start' : 'Next')) + '</button>') +
      '</div>';
    els.pop.setAttribute('data-step', String(i));
  }

  function place() {
    if (!run || !els) return;
    const step = run.steps[run.i];
    const el = run.target && document.contains(run.target) ? run.target : null;
    const pop = els.pop, spot = els.spot;
    // The part of the page on screen (on phones the page can be wider than the screen)
    const vv = window.visualViewport;
    const vw = vv ? vv.width : document.documentElement.clientWidth || innerWidth;
    const vh = vv ? vv.height : document.documentElement.clientHeight || innerHeight;
    const gap = 14, margin = 12;
    const mobile = vw < 640;
    // Docked (phones): across the screen, at the bottom (or top), sized to what's visible
    const dock = top => {
      pop.classList.add('is-docked');
      pop.classList.toggle('is-top', !!top);
      pop.style.width = (vw - 24) + 'px';
      pop.style.left = (12 + (vv ? vv.offsetLeft : 0)) + 'px';
      pop.style.maxHeight = Math.round(vh * 0.45) + 'px';
      pop.style.top = (top ? 12 : Math.max(12, vh - pop.offsetHeight - 12)) + (vv ? vv.offsetTop : 0) + 'px';
    };
    const undock = () => { pop.classList.remove('is-docked', 'is-top'); pop.style.width = ''; pop.style.maxHeight = ''; };
    if (!el) {
      spot.classList.add('is-hidden');
      els.shield.classList.add('is-dim');
      if (mobile) { dock(false); return; }
      undock();
      pop.style.left = Math.max(margin, (vw - pop.offsetWidth) / 2) + 'px';
      pop.style.top = Math.max(margin, (vh - pop.offsetHeight) / 2) + 'px';
      return;
    }
    els.shield.classList.remove('is-dim');
    spot.classList.remove('is-hidden');
    const pad = step.padding !== undefined ? step.padding : 6;
    const r = el.getBoundingClientRect();
    const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(vw - 4, r.right + pad), bottom: Math.min(vh - 4, r.bottom + pad) };
    Object.assign(spot.style, { left: box.left + 'px', top: box.top + 'px', width: Math.max(0, box.right - box.left) + 'px', height: Math.max(0, box.bottom - box.top) + 'px' });
    if (mobile) { dock((box.top + box.bottom) / 2 > vh * 0.55); return; }   // at the top when the target is down there
    undock();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const fits = {
      right: vw - box.right - gap >= pw + margin,
      left: box.left - gap >= pw + margin,
      bottom: vh - box.bottom - gap >= ph + margin,
      top: box.top - gap >= ph + margin
    };
    let side = step.placement && fits[step.placement] ? step.placement : ['right', 'bottom', 'left', 'top'].find(k => fits[k]);
    let x, y;
    const clampX = v => Math.max(margin, Math.min(vw - pw - margin, v));
    const clampY = v => Math.max(margin, Math.min(vh - ph - margin, v));
    if (side === 'right') { x = box.right + gap; y = clampY(box.top + (box.bottom - box.top) / 2 - ph / 2); }
    else if (side === 'left') { x = box.left - gap - pw; y = clampY(box.top + (box.bottom - box.top) / 2 - ph / 2); }
    else if (side === 'bottom') { y = box.bottom + gap; x = clampX(box.left + (box.right - box.left) / 2 - pw / 2); }
    else if (side === 'top') { y = box.top - gap - ph; x = clampX(box.left + (box.right - box.left) / 2 - pw / 2); }
    else { x = clampX(vw - pw - margin * 2); y = clampY(vh - ph - margin * 2); }   // big target: the card sits in a corner over it
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.setAttribute('data-side', side || 'over');
  }

  function stop(dismissed) {
    if (!run) return;
    const name = run.name;
    if (dismissed) remember(name, 'dismissed');
    run = null;
    if (dismissed && hooks[name] && hooks[name].onClose) hooks[name].onClose();
    clearInterval(watch);
    document.documentElement.classList.remove('tour-on', 'tour-interactive');
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    if (els) { els.shield.remove(); els.spot.remove(); els.pop.remove(); els = null; }
  }

  /* ── Invite (first visit) ────────────────── */
  let invite = null;
  function closeInvite() { if (invite) { invite.remove(); invite = null; } }
  function inviteTo(name, opts) {
    opts = opts || {};
    if (!tours[name] || run || invite) return;
    invite = document.createElement('div');
    invite.className = 'tour-invite';
    invite.setAttribute('role', 'dialog');
    invite.setAttribute('aria-labelledby', 'tour-invite-title');
    invite.innerHTML = '<div class="tour-invite-title" id="tour-invite-title">' + esc(opts.title || 'New here?') + '</div>' +
      '<div class="tour-invite-text">' + esc(opts.text || 'Take a short tour — it shows each part of the page and what it does.') + '</div>' +
      '<div class="tour-invite-foot"><button type="button" class="tour-btn" data-act="no">No thanks</button><button type="button" class="tour-btn is-primary" data-act="go">' + esc(opts.goLabel || 'Take the tour') + '</button></div>';
    invite.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'go') { closeInvite(); if (opts.onGo) opts.onGo(); else start(name); }
      else { remember(name, 'dismissed'); closeInvite(); }
    });
    document.body.appendChild(invite);
  }
  // Offers the tour once per browser. Automated browsers (tests, screenshot
  // tools — navigator.webdriver) aren't offered it, so it never gets in their way.
  function offerOnce(name, opts) {
    if (seen(name) || navigator.webdriver) return;
    setTimeout(() => inviteTo(name, opts), (opts && opts.delay) || 600);
  }

  return {
    define, start, stop: () => stop(true), invite: inviteTo, offerOnce, seen, reset,
    steps: name => (tours[name] || []).map(st => ({ title: st.title, spotlight: !!st.target })),
    get running() { return run ? { name: run.name, step: run.i } : null },
    next: () => run && go(run.i + 1), back: () => run && go(run.i - 1)
  };
})();
window.Tour = Tour;
