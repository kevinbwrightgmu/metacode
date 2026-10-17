// The AI Scraper (beta): wires local storage, the server's AI jobs and the views.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiJobConfig, CollectionError, JobRecord, LogEntry, Settings } from '../types';
import { CollectorStore, type Counts, type RecordFilter } from '../store/db';
import { DEFAULT_SETTINGS, accessOptions, cleanSettings, fetchServerInfo, initialAccess, readOwnKeys, type ServerInfo } from '../lib/settings';
import { jobRequest, startAiJob } from '../lib/ai-jobs';
import { AiJobSession, newJobRecord } from '../lib/session';
import { stopExportWorker } from '../export/client';
import { isEmbedded, sendToProject, toMetaCodePost, type MetaCodePost } from '../lib/metacode';
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

/** The AI model MetaCode uses for the AI Scraper (Settings → AI models), when shown inside MetaCode. */
function metaCodeModel(): string {
  try {
    const host = (window.parent as unknown as { MetaCodeHost?: { aiScraperModel?: () => string } }).MetaCodeHost;
    return window.parent !== window && host && typeof host.aiScraperModel === 'function' ? String(host.aiScraperModel() || '').slice(0, 120) : '';
  } catch {
    return '';             // a parent on another origin: not MetaCode
  }
}

export function App() {
  const embedded = useMemo(() => isEmbedded(), []);
  const [store, setStore] = useState<CollectorStore | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>(viewFromHash);
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [errors, setErrors] = useState<CollectionError[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [shownJob, setShownJob] = useState<JobRecord | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [, setTick] = useState(0);
  const sessions = useRef(new Map<string, AiJobSession>());
  const shownId = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async (s?: CollectorStore | null) => {
    const st = s || store;
    if (!st) return;
    const [c, j, e] = await Promise.all([st.counts(), st.listJobs(), st.listErrors(undefined, 20)]);
    setCounts(c);
    setJobs(j);
    setErrors(e);
    setDataVersion(v => v + 1);
  }, [store]);

  /** Refreshes counts at most every second while a job copies records. */
  const scheduleRefresh = useCallback((s: CollectorStore) => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void refresh(s); }, 1000);
  }, [refresh]);

  // Follows a job: its records are copied into this browser as the AI keeps them.
  const follow = useCallback((s: CollectorStore, record: JobRecord, show: boolean) => {
    const session = new AiJobSession(s, record);
    sessions.current.set(record.id, session);
    session.subscribe(sess => {
      if (shownId.current === sess.record.id) { setShownJob(sess.record); setLogs(sess.logs); }
      setTick(t => t + 1);
      scheduleRefresh(s);
      if (!sess.active) sessions.current.delete(sess.record.id);
    });
    if (show) { shownId.current = record.id; setShownJob(record); setLogs([]); }
    session.watch();
    return session;
  }, [scheduleRefresh]);

  // ── Start-up: storage, server, settings; jobs still running on the server are picked up again ──
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
      const [info, saved] = await Promise.all([fetchServerInfo(), s.loadSettings()]);
      const clean = cleanSettings(saved);
      if (clean.retentionDays) await s.applyRetention(clean.retentionDays);
      if (cancelled) return;
      setServer(info);
      setSettings(clean);
      setStore(s);
      const running = (await s.listJobs()).filter(j => (j.state === 'running' || j.state === 'stopping') && j.config && typeof j.config.goal === 'string');
      running.forEach((j, i) => follow(s, j, i === 0));
      await refresh(s);
    })();
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => { cancelled = true; window.removeEventListener('hashchange', onHash); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    sessions.current.forEach(s => s.detach());
    stopExportWorker();
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
  }, []);

  function go(v: View) {
    if (location.hash !== '#' + v) location.hash = v;
    setView(v);
  }

  const active = Array.from(sessions.current.values()).find(s => s.active) || null;
  const startProblem = fatal || (server && server.problem) || (active ? 'A job is running (one at a time). Stop it in the Monitor, or wait for it to finish.' : null);
  const ownKeys = useMemo(() => readOwnKeys(), [view]);
  const access = server ? accessOptions(ownKeys, server) : [];
  const defaultAccess = initialAccess(access, server);

  async function startJob(config: AiJobConfig) {
    if (!store || startProblem) return;
    const job = await startAiJob(jobRequest(config, readOwnKeys()));
    const record = newJobRecord(job, config, new Date().toISOString());
    await store.saveJob(record);
    follow(store, record, true);
    void refresh();
    go('monitor');
  }

  function openJob(job: JobRecord) {
    const session = sessions.current.get(job.id);
    shownId.current = job.id;
    setShownJob(session ? session.record : job);
    setLogs(session ? session.logs : []);
    go('monitor');
  }

  /** Sends the matching records to the MetaCode project around the app → a message for the user. */
  async function addToProject(filters: Partial<RecordFilter>[]): Promise<string> {
    if (!store) return '';
    const posts: MetaCodePost[] = [];
    for (const f of filters) await store.each(f.type || 'post', f, r => { posts.push(toMetaCodePost(r)); });
    if (!posts.length) return 'Nothing to add.';
    const r = await sendToProject(posts);
    if (!r.added && !r.updated) return 'All ' + posts.length.toLocaleString() + ' are already in the project, with the same numbers.';
    return 'Added ' + r.added.toLocaleString() + ' to the project' + (r.updated ? '; updated the engagement numbers of ' + r.updated.toLocaleString() + ' already there' : '') +
      ' (' + r.total.toLocaleString() + ' posts in the project). Their engagement shows in Metrics.';
  }

  async function saveSettings(s: Settings) {
    if (!store) return;
    await store.saveSettings(s);
    setSettings(s);
  }

  const shownSession = shownJob ? sessions.current.get(shownJob.id) : undefined;

  return (
    <div className={'app' + (embedded ? ' is-embedded' : '')}>
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">AI</span>
          <div><div className="brand-name">AI Scraper <span className="beta">beta</span></div><div className="brand-sub">MetaCode · Reddit</div></div>
        </div>
        <nav aria-label="Sections">
          {VIEWS.map(([v, label]) => (
            <a key={v} href={'#' + v} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined}
              onClick={e => { e.preventDefault(); go(v); }}>{label}{v === 'monitor' && active ? <span className="pulse" aria-label="(running)" /> : null}</a>
          ))}
        </nav>
        <a className="back" href="/app.html">MetaCode ↗</a>
      </header>

      <main className="main single" id="main">
        {fatal ? <Notice tone="error">{fatal}</Notice> : null}
        {!fatal && server && server.networkProblem ? <Notice tone="warn">{server.networkProblem}</Notice> : null}
        {!store && !fatal ? <p className="muted">Opening local storage…</p> : null}
        {store ? (
          <>
            {view === 'overview' ? <Overview counts={counts} jobs={jobs} errors={errors} onOpenJob={openJob} onNewJob={() => go('new')} /> : null}
            {view === 'new' ? <NewJob settings={settings} access={access} defaultAccess={defaultAccess} model={metaCodeModel()} canStart={!startProblem} startProblem={startProblem} onStart={startJob} /> : null}
            {view === 'monitor' ? <Monitor job={shownJob} logs={logs} onStop={() => { if (shownSession) void shownSession.stop().catch(err => setLogs(l => l.concat({ at: new Date().toISOString(), level: 'error', message: (err as Error).message }))); }}
              onNewJob={() => go('new')}
              onAddToProject={embedded && shownJob ? () => addToProject([{ type: 'post', jobId: shownJob.id }, { type: 'comment', jobId: shownJob.id }]) : undefined} /> : null}
            {view === 'data' ? <Explorer store={store} jobs={jobs} defaultFormat={settings.exportFormat} bom={settings.csvBom} version={dataVersion} onChanged={() => void refresh()}
              onAddToProject={embedded ? f => addToProject([f]) : undefined} /> : null}
            {view === 'settings' ? <SettingsView settings={settings} store={store} counts={counts} jobRunning={!!active} onSave={saveSettings} onDataChanged={() => void refresh()} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
