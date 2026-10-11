// New AI job: say what you want; the AI on the MetaCode server finds and picks the posts.
import { useState, type FormEvent } from 'react';
import type { AiJobConfig, RedditAccess, Settings } from '../types';
import { SETTING_LIMITS, clampInt, type AccessOption } from '../lib/settings';
import { Notice } from './common';

const EXAMPLES = [
  'Posts where people describe side effects after switching to a heat pump, from the last year',
  'How r/teachers talks about AI tools in grading — 40 posts with their top comments',
  'First-hand accounts of long COVID fatigue from r/covidlonghaulers and r/cfs, newest first'
];

interface Props {
  settings: Settings;
  access: AccessOption[];
  /** The AI model MetaCode uses for the AI Scraper ("" = the server's default). */
  model: string;
  canStart: boolean;
  startProblem: string | null;
  onStart: (config: AiJobConfig) => Promise<void>;
}

export function NewJob({ settings, access, model, canStart, startProblem, onStart }: Props) {
  const [goal, setGoal] = useState('');
  const [maxPosts, setMaxPosts] = useState(settings.defaultMaxPosts);
  const [comments, setComments] = useState(settings.defaultCommentsPerPost);
  const [steps, setSteps] = useState(settings.defaultMaxSteps);
  const [minutes, setMinutes] = useState(settings.defaultMaxMinutes);
  const [via, setVia] = useState<RedditAccess>(access[0] ? access[0].value : 'server');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = access.find(a => a.value === via) || access[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const g = goal.replace(/\s+/g, ' ').trim();
    if (g.length < 10) { setError('Describe what to collect in a sentence or two.'); return; }
    if (!canStart) return;
    setError(null);
    setBusy(true);
    try {
      await onStart({
        goal: g,
        maxPosts: clampInt(maxPosts, SETTING_LIMITS.defaultMaxPosts, settings.defaultMaxPosts),
        commentsPerPost: clampInt(comments, SETTING_LIMITS.defaultCommentsPerPost, 0),
        maxSteps: clampInt(steps, SETTING_LIMITS.defaultMaxSteps, settings.defaultMaxSteps),
        maxMinutes: clampInt(minutes, SETTING_LIMITS.defaultMaxMinutes, settings.defaultMaxMinutes),
        access: chosen ? chosen.value : 'server',
        model
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num = (set: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value === '' ? NaN : Number(e.target.value));

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>Ask the AI</h2>
      <p className="muted">Describe the posts you need. The AI works out where they're discussed, searches, reads posts when it's unsure,
        and keeps the ones that fit — you watch each step in the Monitor.</p>

      <label className="field">What should it collect?
        <textarea className="input goal" id="job-goal" value={goal} onChange={e => setGoal(e.target.value)} rows={4} maxLength={2000}
          placeholder="e.g. Posts where people describe side effects after switching to a heat pump, from the last year" />
      </label>
      <div className="examples" aria-label="Examples">
        {EXAMPLES.map(x => <button key={x} type="button" className="btn btn-ghost btn-sm" onClick={() => setGoal(x)}>{x}</button>)}
      </div>

      <fieldset>
        <legend>Limits</legend>
        <div className="row">
          <label className="field">Posts to keep (max)<input className="input" id="job-max-posts" type="number" min={1} max={SETTING_LIMITS.defaultMaxPosts[1]}
            value={Number.isNaN(maxPosts) ? '' : maxPosts} onChange={num(setMaxPosts)} /></label>
          <label className="field">Comments per post<input className="input" id="job-comments" type="number" min={0} max={SETTING_LIMITS.defaultCommentsPerPost[1]}
            value={Number.isNaN(comments) ? '' : comments} onChange={num(setComments)} /></label>
          <label className="field">AI steps (max)<input className="input" id="job-max-steps" type="number" min={SETTING_LIMITS.defaultMaxSteps[0]} max={SETTING_LIMITS.defaultMaxSteps[1]}
            value={Number.isNaN(steps) ? '' : steps} onChange={num(setSteps)} /></label>
          <label className="field">Run time (min)<input className="input" id="job-max-minutes" type="number" min={1} max={SETTING_LIMITS.defaultMaxMinutes[1]}
            value={Number.isNaN(minutes) ? '' : minutes} onChange={num(setMinutes)} /></label>
        </div>
        <p className="hint">A step is one thing the AI does: a search, a subreddit listing, reading a post, or keeping posts. It stops at whichever limit comes first, or when it judges the goal met.</p>
      </fieldset>

      <fieldset>
        <legend>Reaching Reddit</legend>
        <label className="field">Through
          <select className="input" id="job-access" value={chosen ? chosen.value : ''} onChange={e => setVia(e.target.value as RedditAccess)}>
            {access.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        {chosen ? <p className="hint" id="job-access-note">{chosen.note}</p> : null}
        {!access.some(a => a.value === 'own') ? (
          <p className="hint">Your own Reddit API keys give your jobs their own limit and work when Reddit blocks the server: add them on MetaCode's
            {' '}<b>Reddit Scraper</b> page → <b>Reddit API access</b> (they stay in this browser).</p>
        ) : null}
        <p className="hint">AI model: <b>{model || 'the server\'s default'}</b> — change it in MetaCode's Settings → AI models → AI Scraper.</p>
      </fieldset>

      {error ? <Notice tone="error"><span id="job-error">{error}</span></Notice> : null}
      {startProblem ? <Notice tone="warn"><span id="job-start-problem">{startProblem}</span></Notice> : null}
      <div className="actions">
        <button className="btn btn-primary" id="job-start" type="submit" disabled={!canStart || busy}>{busy ? 'Starting…' : 'Start'}</button>
      </div>
    </form>
  );
}
