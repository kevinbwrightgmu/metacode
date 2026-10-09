// The dashboard: wires the store, the Scramjet browser, the bot and the views.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionError, JobConfig, JobProgress, JobRecord, LogEntry, Settings } from '../types';
import { CollectorStore, type Counts } from '../store/db';
import { ScramjetBrowser, supportProblem } from '../browser/scramjet';
import { CollectorJob } from '../bot/bot';
import { DEFAULT_SETTINGS, cleanSettings, fetchServerInfo, type ServerInfo } from '../lib/settings';
import { navigationProblem, parseRedditBase, type Site } from '../lib/urls';
import { stopExportWorker } from '../export/client';
import { BrowserPanel } from './BrowserPanel';
import { Overview } from './Overview';
import { NewJob } from './NewJob';
import { Monitor } from './Monitor';
import { Explorer } from './Explorer';
import { SettingsView } from './SettingsView';
import { Notice } from './common';

type View = 'overview' | 'new' | 'monitor' | 'data' | 'settings';
const VIEWS: [View, string][] = [['overview', 'Overview'], ['new', 'New job'], ['monitor', 'Monitor'], ['data', 'Data'], ['settings', 'Settings']];
const EMPTY_COUNTS: Counts = { posts: 0, comments: 0, jobs: 0, errors: 0 };

function viewFromHash(): View {
  const h = location.hash.replace('#', '');
  return (VIEWS.some(([v]) => v === h) ? h : 'overview') as View;
}

export function App() {
  const browser = useMemo(() => new ScramjetBrowser(), []);
  const [store, setStore] = useState<CollectorStore | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>(viewFromHash);
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [errors, setErrors] = useState<CollectionError[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [shownJob, setShownJob] = useState<JobRecord | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [browserState, setBrowserState] = useState(browser.getStatus().state);
  const jobRef = useRef<CollectorJob | null>(null);
  const refreshTimer = useRef<number | null>(null);

  // ── Start-up: storage, server, settings ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let s: CollectorStore;
      try {
        s = await CollectorStore.open();
      } catch (err) {
        setFatal('Local storage (IndexedDB) isn\'t available: ' + (err as Error).message + ' Private windows and some privacy settings block it.');
        return;
      }
      if (cancelled) return;
      await s.closeInterruptedJobs();
      const info = await fetchServerInfo();
      const saved = await s.loadSettings();
      const clean = cleanSettings(saved, info.allowedHosts, info.minDelayMs);
      if (clean.retentionDays) await s.applyRetention(clean.retentionDays);
      if (cancelled) return;
      setServer(info);
      setSettings(clean);
      setStore(s);
    })();
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => { cancelled = true; window.removeEventListener('hashchange', onHash); };
  }, []);

  useEffect(() => browser.subscribe(s => setBrowserState(s.state)), [browser]);

  const site: Site | null = useMemo(() => {
    if (!server) return null;
    try { return { base: parseRedditBase(settings.redditBase, server.allowedHosts), extraHosts: server.allowedHosts }; } catch { return null; }
  }, [server, settings.redditBase]);

  // Pages reached by clicking around in the frame follow the same rules as the bot
  useEffect(() => { browser.guard = site ? (url => navigationProblem(url, site)) : null; }, [browser, site]);

  const refresh = useCallback(async () => {
    if (!store) return;
    const [c, j, e] = await Promise.all([store.counts(), store.listJobs(), store.listErrors(undefined, 20)]);
    setCounts(c);
    setJobs(j);
    setErrors(e);
    setDataVersion(v => v + 1);
  }, [store]);
  useEffect(() => { void refresh(); }, [refresh]);

  /** Refreshes counts at most every second while a job writes records. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void refresh(); }, 1000);
  }, [refresh]);

  useEffect(() => () => {
    jobRef.current?.stop();
    stopExportWorker();
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
  }, []);

  // Leaving the page during a job: the browser asks first (records saved so far are kept either way)
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (jobRef.current && progress && ['running', 'paused', 'stopping'].includes(progress.state)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [progress]);

  function go(v: View) {
    if (location.hash !== '#' + v) location.hash = v;
    setView(v);
  }

  const jobActive = !!progress && ['running', 'paused', 'stopping'].includes(progress.state);
  const blocker = fatal || (server && server.problem) || supportProblem() || (server && !site ? 'The Reddit address in Settings isn\'t allowed by this server.' : null);
  const startProblem = blocker ? blocker
    : jobActive ? 'A job is already running (one at a time: the bot uses the browser panel).'
    : !browser.isReady || browserState === 'initializing' ? 'Waiting for the Scramjet browser to start…'
    : null;

  function startJob(config: JobConfig) {
    if (!store || !site || startProblem) return;
    const job = new CollectorJob(config, { driver: browser.driver(() => settings.pageTimeoutMs), store, settings, site });
    jobRef.current = job;
    setLogs([]);
    setShownJob({ id: job.id, config, state: 'running', outcome: null, startedAt: new Date().toISOString(), finishedAt: null, stats: job.progress.stats, robots: null });
    setProgress(job.progress);
    let pending: JobProgress | null = null;
    let frame = 0;
    job.on(e => {
      if (e.type === 'progress') {
        pending = e.progress;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pending) setProgress(pending); });
        if (e.progress.stats.postsCollected || e.progress.stats.commentsCollected) scheduleRefresh();
      } else if (e.type === 'log') {
        setLogs(l => (l.length > 500 ? l.slice(-400) : l).concat(e.entry));
      } else if (e.type === 'done') {
        if (frame) cancelAnimationFrame(frame);
        setProgress(job.progress);
        setShownJob(e.job);
        jobRef.current = null;
        void refresh();
      }
    });
    go('monitor');
  }

  function openJob(job: JobRecord) {
    if (jobActive) { go('monitor'); return; }
    setShownJob(job);
    setLogs([]);
    setProgress({ jobId: job.id, state: job.state, operation: job.outcome || '', currentUrl: null, target: null, stats: job.stats,
      limits: { maxPosts: job.config.maxPosts, maxRuntimeMs: job.config.maxRuntimeMinutes * 60000 }, startedAt: job.startedAt,
      elapsedMs: (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt) });
    go('monitor');
  }

  async function saveSettings(s: Settings) {
    if (!store) return;
    await store.saveSettings(s);
    setSettings(s);
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">RC</span>
          <div><div className="brand-name">Reddit Collector</div><div className="brand-sub">MetaCode · Scramjet</div></div>
        </div>
        <nav aria-label="Sections">
          {VIEWS.map(([v, label]) => (
            <a key={v} href={'#' + v} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined}
              onClick={e => { e.preventDefault(); go(v); }}>{label}{v === 'monitor' && jobActive ? <span className="pulse" aria-label="(running)" /> : null}</a>
          ))}
        </nav>
        <a className="back" href="/app.html">MetaCode ↗</a>
      </header>

      <div className="layout">
        <main className="main" id="main">
          {fatal ? <Notice tone="error">{fatal}</Notice> : null}
          {!store && !fatal ? <p className="muted">Opening local storage…</p> : null}
          {store ? (
            <>
              {view === 'overview' ? <Overview counts={counts} jobs={jobs} errors={errors} onOpenJob={openJob} onNewJob={() => go('new')} /> : null}
              {view === 'new' ? <NewJob settings={settings} canStart={!startProblem} startProblem={startProblem} onStart={startJob} /> : null}
              {view === 'monitor' ? <Monitor progress={progress} job={shownJob} logs={logs} onPause={() => jobRef.current?.pause()} onResume={() => jobRef.current?.resume()}
                onStop={() => jobRef.current?.stop()} onNewJob={() => go('new')} /> : null}
              {view === 'data' ? <Explorer store={store} jobs={jobs} defaultFormat={settings.exportFormat} bom={settings.csvBom} version={dataVersion} onChanged={refresh} /> : null}
              {view === 'settings' ? <SettingsView settings={settings} allowedHosts={server?.allowedHosts || []} minPageDelayMs={server?.minDelayMs || 0} store={store}
                counts={counts} jobRunning={jobActive} onSave={saveSettings} onDataChanged={refresh} /> : null}
            </>
          ) : null}
        </main>
        <aside className="side">
          <BrowserPanel browser={browser} site={site} busy={jobActive} blocker={blocker} />
        </aside>
      </div>
    </div>
  );
}
