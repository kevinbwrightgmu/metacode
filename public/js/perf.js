/* ══════════════════════════════════════════════
   perf.js — performance profiles (loaded first, so the page never flashes)

   Potato       very old or low-memory devices: no animations, transitions, shadows or blur; charts drawn
                without animation; a quicker network-graph layout; background sync every 5 minutes.
   Balanced     the usual MetaCode (big network graphs skip the slowest layout step).
   Performance  everything, always (the full network-graph layout however big the graph).
   Auto (default) picks one from the device: its memory and CPU cores (Chromium browsers say), and data saver.
   Every feature works in every profile. The choice is this browser's (Settings → Performance).
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const KEY = 'metacode_perf';
  const PROFILES = ['potato', 'balanced', 'performance'];
  const NAMES = { potato: 'Potato', balanced: 'Balanced', performance: 'Performance' };

  function detect() {
    const mem = Number(navigator.deviceMemory) || 0;            // GB, rounded (Chromium); 0 when not said
    const cores = Number(navigator.hardwareConcurrency) || 0;
    const conn = navigator.connection || {};
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if ((mem && mem <= 2) || (cores && cores <= 2) || conn.saveData === true) return 'potato';
    if (mem >= 8 && cores >= 8 && !reduced) return 'performance';
    return 'balanced';
  }
  function setting() {
    try { const v = localStorage.getItem(KEY); return PROFILES.includes(v) ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function profile() { const s = setting(); return s === 'auto' ? detect() : s; }
  function apply() { document.documentElement.setAttribute('data-perf', profile()); }

  window.MetaPerf = {
    PROFILES, NAMES, detect, setting, profile,
    is: p => profile() === p,
    set(v) {
      try { if (v === 'auto' || !PROFILES.includes(v)) localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* private mode: this page only */ }
      apply();
      window.dispatchEvent(new CustomEvent('metacode-perf', { detail: profile() }));
    },
    describe() { const p = profile(); return NAMES[p] + (setting() === 'auto' ? ' (picked for this device)' : ''); },
  };
  apply();
})();
