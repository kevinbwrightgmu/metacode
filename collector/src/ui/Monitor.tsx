// Live view of an AI job: what the AI is doing, step by step, and what it kept.
import { useEffect, useRef, useState } from 'react';
import type { JobRecord, LogEntry } from '../types';
import { describeJob, ACCESS_LABEL } from '../lib/jobs';
import { Notice, Stat, StateChip, fmtDate, fmtDuration, fmtNum } from './common';

const TOOL_LABEL: Record<string, string> = {
  find_subreddits: 'Find communities', search_posts: 'Search', list_posts: 'Browse subreddit', read_post: 'Read post',
  keep: 'Keep posts', finish: 'Finish'
};

interface Props {
  job: JobRecord | null;
  logs: LogEntry[];
  onStop: () => void;
  onNewJob: () => void;
  /** Inside MetaCode: send this job's records to the project. */
  onAddToProject?: () => Promise<string>;
}

export function Monitor({ job, logs, onStop, onNewJob, onAddToProject }: Props) {
  const stepsRef = useRef<HTMLOListElement>(null);
  const [added, setAdded] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = !!job && (job.state === 'running' || job.state === 'stopping');
  // (jobs of the earlier in-browser bot, still in this browser, have no steps)
  const steps = (job && Array.isArray(job.steps) ? job.steps : []);
  useEffect(() => { setAdded(null); }, [job && job.id]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => {
    const el = stepsRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (!job) {
    return (
      <section className="card">
        <h2>Monitor</h2>
        <p className="muted">No job is open. Ask the AI for posts and follow it here.</p>
        <button className="btn btn-primary" onClick={onNewJob}>New job</button>
      </section>
    );
  }

  const s = job.stats;
  const c = job.config;
  const elapsed = (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt);
  const current = active && steps.length ? steps[steps.length - 1] : null;
  const legacy = !c || typeof c.goal !== 'string';

  return (
    <section className="card monitor" aria-label="Job monitor">
      <div className="monitor-head">
        <div>
          <h2 id="monitor-goal">{describeJob(c)}</h2>
          <div className="muted small">Started {fmtDate(job.startedAt)} · {fmtDuration(elapsed)}
            {!legacy ? ' · through ' + ACCESS_LABEL[c.access] + ' · model ' + (c.model || 'server default') : ''}</div>
        </div>
        <StateChip state={job.state} />
      </div>

      {active ? (
        <div className="op" role="status" aria-live="polite">
          <div className="op-main" id="monitor-operation">{job.state === 'stopping' ? 'Stopping…' : current ? (TOOL_LABEL[current.tool] || current.tool) + (current.args ? ': ' + current.args : '') : 'The AI is planning…'}</div>
          {current && current.thought ? <div className="muted small">{current.thought}</div> : null}
        </div>
      ) : null}

      <div className="stats stats-6">
        <Stat label="Posts kept" value={<span id="monitor-posts">{fmtNum(s.postsCollected)}</span>} sub={legacy ? undefined : 'limit ' + fmtNum(c.maxPosts)} />
        <Stat label="Comments" value={fmtNum(s.commentsCollected)} />
        <Stat label="AI steps" value={fmtNum(s.steps)} sub={legacy ? undefined : 'limit ' + fmtNum(c.maxSteps)} />
        <Stat label="AI requests" value={fmtNum(s.aiCalls)} />
        <Stat label="Reddit requests" value={fmtNum(s.requests)} />
        <Stat label="Errors" value={fmtNum(s.errors)} tone={s.errors ? 'bad' : undefined} />
      </div>

      {active ? (
        <div className="actions">
          <button className="btn btn-danger" id="job-stop" onClick={onStop} disabled={job.state === 'stopping'}>Stop</button>
        </div>
      ) : (
        <>
          {job.outcome ? <Notice tone={job.state === 'failed' ? 'error' : job.state === 'stopped' ? 'warn' : 'ok'}><span id="monitor-outcome">{job.outcome}</span></Notice> : null}
          {job.summary ? <p className="summary" id="monitor-summary"><b>The AI's summary:</b> {job.summary}</p> : null}
          <div className="actions">
            {onAddToProject && (s.postsCollected || s.commentsCollected) ? (
              <button className="btn btn-primary" id="job-add-to-project" disabled={adding} onClick={async () => {
                setAdding(true);
                try { setAdded({ tone: 'ok', text: await onAddToProject() }); } catch (err) { setAdded({ tone: 'error', text: (err as Error).message }); } finally { setAdding(false); }
              }}>Add this job's posts{s.commentsCollected ? ' and comments' : ''} to project</button>
            ) : null}
            <button className={'btn' + (onAddToProject ? '' : ' btn-primary')} onClick={onNewJob}>New job</button>
          </div>
          {added ? <Notice tone={added.tone}><span id="job-added">{added.text}</span></Notice> : null}
        </>
      )}

      <h3>What the AI did</h3>
      {steps.length ? (
        <ol className="steps" id="monitor-steps" ref={stepsRef} aria-label="The AI's steps">
          {steps.map(st => (
            <li key={st.step} className={st.error ? 'step-error' : ''}>
              <div className="step-head"><span className="step-n">{st.step}</span><b>{TOOL_LABEL[st.tool] || st.tool}</b>{st.args ? <span className="step-args"> {st.args}</span> : null}</div>
              {st.thought ? <div className="step-thought">{st.thought}</div> : null}
              {st.result ? <div className="step-result">→ {st.result}</div> : null}
            </li>
          ))}
        </ol>
      ) : <p className="muted">{active ? 'Waiting for the AI\'s first step…' : 'No steps recorded.'}</p>}

      <details className="log-wrap">
        <summary>Log</summary>
        <ol className="log" aria-label="Job log">
          {logs.map((l, i) => (
            <li key={i} className={'log-' + l.level}><time>{new Date(l.at).toLocaleTimeString()}</time> <span>{l.message}</span></li>
          ))}
          {!logs.length ? <li className="muted">No log for this job in this window.</li> : null}
        </ol>
      </details>
    </section>
  );
}
