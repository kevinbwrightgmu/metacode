// Shared bits of the dashboard: formatting, safe links, small components.
import type { ReactNode } from 'react';
import type { JobState } from '../types';
import { isRedditHost, safeHttpUrl } from '../lib/urls';

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + (s % 60) + ' s';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

export function fmtBytes(n: number | null): string {
  if (n === null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(1) : String(v)) + ' ' + units[i];
}

const STATE_LABEL: Record<JobState, string> = {
  running: 'Running', paused: 'Paused', stopping: 'Stopping', completed: 'Completed', stopped: 'Stopped', failed: 'Failed'
};
export function StateChip({ state }: { state: JobState }) {
  return <span className={'chip chip-' + state}>{STATE_LABEL[state]}</span>;
}

/**
 * A link to a Reddit page (opened in a new tab without access back to this
 * page). Anything that isn't an http(s) Reddit address is shown as text.
 */
export function RedditLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  const safe = safeHttpUrl(href);
  if (!safe || !isRedditHost(new URL(safe).hostname)) return <>{children}</>;
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** An outside link from scraped data: http(s) only, shown with its domain, no referrer. */
export function ExternalLink({ href }: { href: string | null | undefined }) {
  const safe = safeHttpUrl(href);
  if (!safe) return <span className="muted">—</span>;
  const host = new URL(safe).hostname;
  return <a href={safe} target="_blank" rel="noopener noreferrer nofollow" title={safe}>{host}</a>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className={'stat' + (tone ? ' stat-' + tone : '')}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={'notice notice-' + tone} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}
