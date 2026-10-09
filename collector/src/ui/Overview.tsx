// Overview: totals, jobs, recent activity.
import type { CollectionError, JobRecord } from '../types';
import type { Counts } from '../store/db';
import { describeJob } from '../bot/validate';
import { Stat, StateChip, fmtDate, fmtDuration, fmtNum } from './common';

interface Props {
  counts: Counts;
  jobs: JobRecord[];
  errors: CollectionError[];
  onOpenJob: (job: JobRecord) => void;
  onNewJob: () => void;
}

export function Overview({ counts, jobs, errors, onOpenJob, onNewJob }: Props) {
  const active = jobs.filter(j => j.state === 'running' || j.state === 'paused' || j.state === 'stopping').length;
  const completed = jobs.filter(j => j.state === 'completed').length;
  const failed = jobs.filter(j => j.state === 'failed').length;
  const stopped = jobs.filter(j => j.state === 'stopped').length;
  const pagesOk = jobs.reduce((n, j) => n + j.stats.pagesVisited, 0);

  return (
    <>
      <section className="card">
        <div className="stats stats-4" id="overview-stats">
          <Stat label="Posts collected" value={fmtNum(counts.posts)} />
          <Stat label="Comments collected" value={fmtNum(counts.comments)} />
          <Stat label="Jobs" value={fmtNum(jobs.length)} sub={active + ' active · ' + completed + ' completed · ' + failed + ' failed · ' + stopped + ' stopped'} />
          <Stat label="Collection errors" value={fmtNum(counts.errors)} sub={fmtNum(pagesOk) + ' pages loaded in all'} tone={counts.errors ? 'bad' : undefined} />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent jobs</h2>
          <button className="btn btn-primary" onClick={onNewJob}>New job</button>
        </div>
        {jobs.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>State</th><th>Job</th><th>Started</th><th>Duration</th><th className="num">Posts</th><th className="num">Comments</th><th>Outcome</th></tr></thead>
              <tbody>
                {jobs.slice(0, 15).map(j => (
                  <tr key={j.id} className="clickable" tabIndex={0} onClick={() => onOpenJob(j)} onKeyDown={e => { if (e.key === 'Enter') onOpenJob(j); }}>
                    <td><StateChip state={j.state} /></td>
                    <td>{describeJob(j.config)}</td>
                    <td className="nowrap">{fmtDate(j.startedAt)}</td>
                    <td className="nowrap">{j.finishedAt ? fmtDuration(Date.parse(j.finishedAt) - Date.parse(j.startedAt)) : '—'}</td>
                    <td className="num">{fmtNum(j.stats.postsCollected)}</td>
                    <td className="num">{fmtNum(j.stats.commentsCollected)}</td>
                    <td className="clip">{j.outcome || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No jobs yet. Start one to collect posts and comments from public subreddits or a search.</p>}
      </section>

      {errors.length ? (
        <section className="card">
          <h2>Recent problems</h2>
          <ul className="errors">
            {errors.slice(0, 8).map(e => (
              <li key={e.id}><span className="muted small">{fmtDate(e.at)} · {e.kind}</span><div>{e.message}</div>{e.url ? <div className="op-url">{e.url}</div> : null}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
