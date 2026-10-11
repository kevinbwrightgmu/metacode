// Settings: defaults for new jobs, exports, storage and retention.
import { useEffect, useState, type FormEvent } from 'react';
import type { Settings } from '../types';
import type { CollectorStore, Counts } from '../store/db';
import { storageEstimate } from '../store/db';
import { DEFAULT_SETTINGS, SETTING_LIMITS, cleanSettings } from '../lib/settings';
import { Notice, fmtBytes, fmtNum } from './common';

interface Props {
  settings: Settings;
  store: CollectorStore;
  counts: Counts;
  jobRunning: boolean;
  onSave: (s: Settings) => Promise<void>;
  onDataChanged: () => void;
}

export function SettingsView({ settings, store, counts, jobRunning, onSave, onDataChanged }: Props) {
  const [form, setForm] = useState<Settings>(settings);
  const [usage, setUsage] = useState<{ usage: number | null; quota: number | null; persisted: boolean | null } | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  useEffect(() => { setForm(settings); }, [settings]);
  useEffect(() => { storageEstimate().then(setUsage).catch(() => setUsage(null)); }, [counts]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(f => ({ ...f, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    await onSave(cleanSettings(form));
    setMessage({ tone: 'ok', text: 'Settings saved.' });
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
        <legend>Defaults for new jobs</legend>
        <div className="row">
          {numberField('defaultMaxPosts', 'Posts to keep')}
          {numberField('defaultCommentsPerPost', 'Comments per post')}
          {numberField('defaultMaxSteps', 'AI steps')}
          {numberField('defaultMaxMinutes', 'Run time (min)')}
        </div>
        <p className="hint">The AI model is chosen in MetaCode's Settings → AI models → AI Scraper. Your own Reddit API keys are added on MetaCode's Reddit Scraper page → Reddit API access.</p>
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
        <p className="hint">Collected posts are copied into this browser (IndexedDB) and stay here after the MetaCode server forgets the job (about two hours after it ends).
          {' '}{fmtNum(counts.posts)} posts, {fmtNum(counts.comments)} comments, {fmtNum(counts.jobs)} jobs.
          {usage ? ' This site uses ' + fmtBytes(usage.usage) + (usage.quota ? ' of ' + fmtBytes(usage.quota) + ' available' : '') + '.' : ''}</p>
        <div className="row">
          {numberField('retentionDays', 'Delete records not seen for (days)', '— 0 keeps everything')}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={applyRetention}>Apply retention now</button>
          <button type="button" className="btn btn-danger" id="clear-all" onClick={clearAll} disabled={jobRunning}>Delete all collected data</button>
        </div>
      </fieldset>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="actions">
        <button className="btn btn-primary" type="submit" id="settings-save">Save settings</button>
        <button className="btn btn-ghost" type="button" onClick={() => setForm({ ...DEFAULT_SETTINGS })}>Reset to defaults</button>
      </div>
    </form>
  );
}
