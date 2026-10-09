// Settings: pacing, limits, robots.txt policy, storage, retention, exports.
import { useEffect, useState, type FormEvent } from 'react';
import type { Settings } from '../types';
import type { CollectorStore, Counts } from '../store/db';
import { storageEstimate } from '../store/db';
import { DEFAULT_SETTINGS, SETTING_LIMITS, cleanSettings } from '../lib/settings';
import { isRedditHost, parseRedditBase } from '../lib/urls';
import { Notice, fmtBytes, fmtNum } from './common';

interface Props {
  settings: Settings;
  allowedHosts: string[];
  minPageDelayMs: number;
  store: CollectorStore;
  counts: Counts;
  jobRunning: boolean;
  onSave: (s: Settings) => Promise<void>;
  onDataChanged: () => void;
}

const PRESETS = ['https://www.reddit.com', 'https://old.reddit.com'];

export function SettingsView({ settings, allowedHosts, minPageDelayMs, store, counts, jobRunning, onSave, onDataChanged }: Props) {
  const [form, setForm] = useState<Settings>(settings);
  const [other, setOther] = useState(PRESETS.includes(settings.redditBase) ? '' : settings.redditBase);
  const [usage, setUsage] = useState<{ usage: number | null; quota: number | null; persisted: boolean | null } | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  useEffect(() => { setForm(settings); }, [settings]);
  useEffect(() => { storageEstimate().then(setUsage).catch(() => setUsage(null)); }, [counts]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(f => ({ ...f, [k]: v }));
  const mirrors = allowedHosts.filter(h => !isRedditHost(h));
  const usingOther = !PRESETS.includes(form.redditBase);

  async function save(e: FormEvent) {
    e.preventDefault();
    let base = form.redditBase;
    if (usingOther) {
      try { base = parseRedditBase(other, allowedHosts).origin; } catch (err) { setMessage({ tone: 'error', text: (err as Error).message }); return; }
    }
    const clean = cleanSettings({ ...form, redditBase: base }, allowedHosts, minPageDelayMs);
    await onSave(clean);
    setMessage({ tone: 'ok', text: 'Settings saved.' + (clean.pageDelayMs !== form.pageDelayMs ? ' The page delay was raised to the minimum (' + clean.pageDelayMs + ' ms).' : '') });
  }

  async function applyRetention() {
    const r = await store.applyRetention(form.retentionDays);
    setMessage({ tone: 'ok', text: form.retentionDays ? 'Removed ' + r.posts + ' posts and ' + r.comments + ' comments not seen for ' + form.retentionDays + ' days.' : 'Retention is off (0 days): nothing removed.' });
    onDataChanged();
  }
  async function clearAll() {
    if (!window.confirm('Delete ALL collected posts, comments, jobs and errors from this browser? This can\'t be undone. (Settings are kept.)')) return;
    await store.clearAll();
    setMessage({ tone: 'ok', text: 'All collected data was deleted.' });
    onDataChanged();
  }
  function clearBrowsing() {
    // Scramjet's controller keeps the proxied site's cookies in its own IndexedDB database.
    const req = indexedDB.deleteDatabase('__scramjet_controller');
    req.onsuccess = () => setMessage({ tone: 'ok', text: 'Reddit browsing data (cookies Reddit set in the Scramjet frame) was cleared. Reload the page to start a fresh session.' });
    req.onblocked = () => setMessage({ tone: 'warn', text: 'The browsing data is in use; it will be cleared when you reload the page.' });
    req.onerror = () => setMessage({ tone: 'error', text: 'The browsing data couldn\'t be cleared.' });
  }

  const numberField = (key: keyof typeof SETTING_LIMITS, label: string, hint?: string) => (
    <label className="field">{label}{hint ? <span className="muted"> {hint}</span> : null}
      <input className="input" type="number" min={SETTING_LIMITS[key][0]} max={SETTING_LIMITS[key][1]} value={form[key]}
        onChange={e => set(key, Number(e.target.value))} id={'set-' + key} />
    </label>
  );

  return (
    <form className="card form" onSubmit={save}>
      <h2>Settings</h2>
      <fieldset>
        <legend>Reddit</legend>
        <label className="field">Reddit address the bot opens
          <select className="input" id="set-base" value={usingOther ? 'other' : form.redditBase} onChange={e => set('redditBase', e.target.value === 'other' ? 'other' : e.target.value)}>
            <option value="https://www.reddit.com">www.reddit.com (current design)</option>
            <option value="https://old.reddit.com">old.reddit.com (classic design, numbered pages)</option>
            {mirrors.length ? <option value="other">Another address the server allows ({mirrors.join(', ')})</option> : null}
          </select>
        </label>
        {usingOther ? <label className="field">Address<input className="input" id="set-base-other" value={other} onChange={e => setOther(e.target.value)} placeholder="http://localhost:4000" /></label> : null}
        <div className="row">
          {numberField('pageDelayMs', 'Delay between page loads (ms)', '— at least ' + Math.max(SETTING_LIMITS.pageDelayMs[0], minPageDelayMs))}
          {numberField('scrollDelayMs', 'Wait after each scroll (ms)')}
          {numberField('pageTimeoutMs', 'Page load timeout (ms)')}
          {numberField('maxRetries', 'Retries per page')}
        </div>
      </fieldset>

      <fieldset>
        <legend>robots.txt</legend>
        <p className="hint">The bot reads the current robots.txt of the Reddit address (through Scramjet) before each job and records its decision with the job. When this collector was written, Reddit's robots.txt disallowed automated access for all user agents (User-agent: * / Disallow: /) and pointed researchers to Reddit's Data API — so with "Obey", jobs on reddit.com don't run unless that has changed.</p>
        <label className="radio"><input type="radio" name="robots" checked={form.robotsPolicy === 'obey'} onChange={() => set('robotsPolicy', 'obey')} /> <b>Obey</b> (default): don't run a job on pages robots.txt disallows.</label>
        <label className="radio"><input type="radio" name="robots" id="set-robots-warn" checked={form.robotsPolicy === 'warn'} onChange={() => set('robotsPolicy', 'warn')} /> <b>Warn and continue</b>: record the decision with the job and run it anyway. Only for collection Reddit has permitted (e.g. under its research program, or your own content).</label>
      </fieldset>

      <fieldset>
        <legend>Defaults for new jobs</legend>
        <div className="row">
          {numberField('defaultMaxPosts', 'Max posts')}
          {numberField('defaultMaxComments', 'Max comments per post')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Exports</legend>
        <div className="row">
          <label className="field">Default format
            <select className="input" value={form.exportFormat} onChange={e => set('exportFormat', e.target.value as Settings['exportFormat'])}>
              <option value="json">JSON</option><option value="jsonl">JSON Lines</option><option value="csv">CSV</option>
            </select>
          </label>
          <label className="check-field"><input type="checkbox" checked={form.csvBom} onChange={e => set('csvBom', e.target.checked)} /> Start CSV files with a byte-order mark (helps Excel read UTF-8)</label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Storage</legend>
        <p className="hint">Everything is stored in this browser (IndexedDB) and never sent anywhere. {fmtNum(counts.posts)} posts, {fmtNum(counts.comments)} comments, {fmtNum(counts.jobs)} jobs.
          {usage ? ' This site uses ' + fmtBytes(usage.usage) + (usage.quota ? ' of ' + fmtBytes(usage.quota) + ' available' : '') + '.' : ''}</p>
        <div className="row">
          {numberField('retentionDays', 'Delete records not seen for (days)', '— 0 keeps everything')}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={applyRetention}>Apply retention now</button>
          <button type="button" className="btn btn-danger" id="clear-all" onClick={clearAll} disabled={jobRunning}>Delete all collected data</button>
          <button type="button" className="btn" onClick={clearBrowsing} disabled={jobRunning}>Clear Reddit browsing data</button>
        </div>
      </fieldset>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="actions">
        <button className="btn btn-primary" type="submit" id="settings-save">Save settings</button>
        <button className="btn btn-ghost" type="button" onClick={() => { setForm({ ...DEFAULT_SETTINGS }); setOther(''); }}>Reset to defaults</button>
      </div>
    </form>
  );
}
