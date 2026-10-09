// Live job monitor: what the bot is doing, counts, controls, and its log.
import { useEffect, useRef } from 'react';
import type { JobProgress, JobRecord, LogEntry } from '../types';
import { describeJob } from '../bot/validate';
import { Notice, Stat, StateChip, fmtDate, fmtDuration, fmtNum } from './common';

interface Props {
  progress: JobProgress | null;
  job: JobRecord | null;            // the active job's config (or the last finished job)
  logs: LogEntry[];
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onNewJob: () => void;
}

export function Monitor({ progress, job, logs, onPause, onResume, onStop, onNewJob }: Props) {
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  if (!progress || !job) {
    return (
      <section className="card">
        <h2>Job monitor</h2>
        <p className="muted">No job has run in this window yet.</p>
        <button className="btn btn-primary" onClick={onNewJob}>New job</button>
      </section>
    );
  }

  const active = progress.state === 'running' || progress.state === 'paused' || progress.state === 'stopping';
  const s = progress.stats;
  const postShare = Math.min(1, s.postsCollected / Math.max(1, progress.limits.maxPosts));
  const timeShare = Math.min(1, progress.elapsedMs / Math.max(1, progress.limits.maxRuntimeMs));
  const collectsPosts = job.config.mode !== 'comments';

  return (
    <section className="card monitor" aria-label="Job monitor">
      <div className="monitor-head">
        <div>
          <h2>{describeJob(job.config)}</h2>
          <div className="muted small">Started {fmtDate(progress.startedAt)} · {fmtDuration(progress.elapsedMs)}</div>
        </div>
        <StateChip state={progress.state} />
      </div>

      <div className="op" role="status" aria-live="polite">
        <div className="op-main" id="monitor-operation">{progress.operation}</div>
        {progress.target ? <div className="muted small">Working on {progress.target}</div> : null}
        {progress.currentUrl ? <div className="op-url" title={progress.currentUrl}>{progress.currentUrl}</div> : null}
      </div>

      <div className="bars">
        {collectsPosts ? (
          <div className="bar-block">
            <div className="bar-label"><span>Posts saved: <b id="monitor-posts">{fmtNum(s.postsCollected)}</b></span><span className="muted">limit {fmtNum(progress.limits.maxPosts)}</span></div>
            <div className={'bar' + (active ? ' is-active' : '')} role="progressbar" aria-label="Posts saved toward the limit" aria-valuemin={0} aria-valuemax={progress.limits.maxPosts} aria-valuenow={s.postsCollected}>
              <span style={{ width: postShare * 100 + '%' }} />
            </div>
          </div>
        ) : null}
        <div className="bar-block">
          <div className="bar-label"><span>Run time</span><span className="muted">limit {fmtDuration(progress.limits.maxRuntimeMs)}</span></div>
          <div className="bar bar-time" role="progressbar" aria-label="Run time toward the limit" aria-valuemin={0} aria-valuemax={progress.limits.maxRuntimeMs} aria-valuenow={progress.elapsedMs}>
            <span style={{ width: timeShare * 100 + '%' }} />
          </div>
        </div>
        <p className="hint">How many posts exist isn't known in advance, so these bars show progress toward your limits, not toward the end of the data. A job can finish early when a listing runs out.</p>
      </div>

      <div className="stats stats-6">
        <Stat label="Posts saved" value={fmtNum(s.postsCollected)} />
        <Stat label="Comments saved" value={fmtNum(s.commentsCollected)} />
        <Stat label="Posts skipped" value={fmtNum(s.postsSkipped)} sub="date range, unreadable" />
        <Stat label="Pages loaded" value={fmtNum(s.pagesVisited)} />
        <Stat label="Errors" value={fmtNum(s.errors)} tone={s.errors ? 'bad' : undefined} />
        <Stat label="Retries" value={fmtNum(s.retries)} />
      </div>

      {active ? (
        <div className="actions">
          {progress.state === 'paused'
            ? <button className="btn btn-primary" id="job-resume" onClick={onResume}>Resume</button>
            : <button className="btn" id="job-pause" onClick={onPause} disabled={progress.state === 'stopping'}>Pause</button>}
          <button className="btn btn-danger" id="job-stop" onClick={onStop} disabled={progress.state === 'stopping'}>Stop</button>
        </div>
      ) : (
        <>
          {job.outcome ? <Notice tone={progress.state === 'failed' ? 'error' : progress.state === 'stopped' ? 'warn' : 'ok'}><span id="monitor-outcome">{job.outcome}</span></Notice> : null}
          <div className="actions"><button className="btn btn-primary" onClick={onNewJob}>New job</button></div>
        </>
      )}

      {job.robots ? <p className="hint">robots.txt: {job.robots.note}</p> : null}

      <h3>Log</h3>
      <ol className="log" ref={logRef} aria-label="Job log">
        {logs.map((l, i) => (
          <li key={i} className={'log-' + l.level}><time>{new Date(l.at).toLocaleTimeString()}</time> <span>{l.message}</span></li>
        ))}
        {!logs.length ? <li className="muted">No log for this job in this window.</li> : null}
      </ol>
    </section>
  );
}
