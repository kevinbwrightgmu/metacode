// New scraping job: what to collect, limits, dates.
import { useState, type FormEvent } from 'react';
import type { JobConfig, Settings } from '../types';
import { LIMITS, defaultJobConfig, validateJob } from '../bot/validate';
import { Notice } from './common';

interface Props {
  settings: Settings;
  canStart: boolean;
  startProblem: string | null;
  onStart: (config: JobConfig) => void;
}

export function NewJob({ settings, canStart, startProblem, onStart }: Props) {
  const [form, setForm] = useState<JobConfig>(() => defaultJobConfig(settings));
  const [subsText, setSubsText] = useState('');
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof JobConfig>(key: K, value: JobConfig[K]) => setForm(f => ({ ...f, [key]: value }));

  const candidate: JobConfig = { ...form, subreddits: subsText.split(/[\s,]+/).filter(Boolean) };
  const result = validateJob(candidate, settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (result.config && canStart) onStart(result.config);
  }

  const num = (key: 'maxPosts' | 'maxCommentsPerPost' | 'maxDepth' | 'maxRuntimeMinutes') => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key, e.target.value === '' ? (NaN as number) : Number(e.target.value));

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>New collection job</h2>

      <fieldset>
        <legend>What to read</legend>
        <div className="seg" role="radiogroup" aria-label="Target">
          <label className={form.targetType === 'subreddit' ? 'on' : ''}><input type="radio" name="target" checked={form.targetType === 'subreddit'} onChange={() => set('targetType', 'subreddit')} /> Subreddits</label>
          <label className={form.targetType === 'search' ? 'on' : ''}><input type="radio" name="target" checked={form.targetType === 'search'} onChange={() => set('targetType', 'search')} /> Search</label>
        </div>
        {form.targetType === 'subreddit' ? (
          <label className="field">Subreddits <span className="muted">(up to {LIMITS.maxSubreddits}, separated by commas or spaces)</span>
            <input className="input" id="job-subreddits" value={subsText} onChange={e => setSubsText(e.target.value)} placeholder="technology, programming, science" autoComplete="off" spellCheck={false} />
          </label>
        ) : (
          <div className="row">
            <label className="field grow">Search for
              <input className="input" id="job-query" value={form.query} onChange={e => set('query', e.target.value)} placeholder="climate policy" maxLength={LIMITS.queryLength} />
            </label>
            <label className="field">Only in subreddit <span className="muted">(optional)</span>
              <input className="input" id="job-search-sub" value={form.searchSubreddit} onChange={e => set('searchSubreddit', e.target.value)} placeholder="science" />
            </label>
          </div>
        )}
        <div className="row">
          <label className="field">Sort
            <select className="input" id="job-sort" value={form.sort} onChange={e => set('sort', e.target.value as JobConfig['sort'])}>
              <option value="new">New</option><option value="hot">Hot</option><option value="top">Top</option>
              {form.targetType === 'subreddit' ? <option value="rising">Rising</option> : null}
            </select>
          </label>
          {form.sort === 'top' ? (
            <label className="field">Time range
              <select className="input" value={form.time} onChange={e => set('time', e.target.value as JobConfig['time'])}>
                {(['hour', 'day', 'week', 'month', 'year', 'all'] as const).map(t => <option key={t} value={t}>{t === 'all' ? 'All time' : 'Past ' + t}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      </fieldset>

      <fieldset>
        <legend>What to collect</legend>
        <div className="seg" role="radiogroup" aria-label="Collect">
          {([['posts', 'Posts'], ['comments', 'Comments'], ['both', 'Posts and comments']] as const).map(([v, label]) => (
            <label key={v} className={form.mode === v ? 'on' : ''}><input type="radio" name="mode" value={v} checked={form.mode === v} onChange={() => set('mode', v)} /> {label}</label>
          ))}
        </div>
        <p className="hint">{form.mode === 'posts' ? 'Reads posts from the listing pages (fast). A post\'s full text is read only when the listing shows it.'
          : 'Opens each post\'s page to read its full text and comments (one extra page load per post).'}</p>
        <div className="row">
          <label className="field">Max posts<input className="input" id="job-max-posts" type="number" min={1} max={LIMITS.maxPosts} value={Number.isNaN(form.maxPosts) ? '' : form.maxPosts} onChange={num('maxPosts')} /></label>
          <label className="field">Max comments per post<input className="input" id="job-max-comments" type="number" min={0} max={LIMITS.maxCommentsPerPost} disabled={form.mode === 'posts'}
            value={Number.isNaN(form.maxCommentsPerPost) ? '' : form.maxCommentsPerPost} onChange={num('maxCommentsPerPost')} /></label>
          <label className="field">Max pages / scrolls<input className="input" id="job-max-depth" type="number" min={1} max={LIMITS.maxDepth} value={Number.isNaN(form.maxDepth) ? '' : form.maxDepth} onChange={num('maxDepth')} /></label>
          <label className="field">Max run time (min)<input className="input" id="job-max-runtime" type="number" min={1} max={LIMITS.maxRuntimeMinutes} value={Number.isNaN(form.maxRuntimeMinutes) ? '' : form.maxRuntimeMinutes} onChange={num('maxRuntimeMinutes')} /></label>
        </div>
        <div className="row">
          <label className="field">Created from <span className="muted">(optional)</span><input className="input" id="job-date-from" type="date" value={form.dateFrom} onChange={e => set('dateFrom', e.target.value)} /></label>
          <label className="field">Created to<input className="input" id="job-date-to" type="date" value={form.dateTo} onChange={e => set('dateTo', e.target.value)} /></label>
        </div>
      </fieldset>

      {touched && result.errors.length ? <Notice tone="error"><ul>{result.errors.map(e => <li key={e}>{e}</li>)}</ul></Notice> : null}
      {result.warnings.length ? <Notice tone="warn"><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></Notice> : null}
      <Notice tone="info">
        Before opening any page the bot reads {new URL('/robots.txt', settings.redditBase).href} through Scramjet.
        {settings.robotsPolicy === 'obey' ? ' If it disallows these pages, the job doesn\'t run (Settings → robots.txt).' : ' Policy is "warn": the job runs and the decision is recorded — use this only for collection Reddit has permitted.'}
        {' '}Pages load one at a time, {Math.round(settings.pageDelayMs / 100) / 10} s apart.
      </Notice>
      {startProblem ? <Notice tone="warn">{startProblem}</Notice> : null}
      <div className="actions">
        <button className="btn btn-primary" id="job-start" type="submit" disabled={!canStart}>Start job</button>
      </div>
    </form>
  );
}
