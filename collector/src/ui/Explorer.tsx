// Data explorer: search and filter collected records, inspect them, delete, export.
import { useCallback, useEffect, useState } from 'react';
import type { CommentRecord, ExportFormat, JobRecord, PostRecord } from '../types';
import { EMPTY_FILTER, type CollectorStore, type RecordFilter, type RecordSort } from '../store/db';
import { describeJob } from '../bot/validate';
import { download, runExport } from '../export/client';
import { ExternalLink, Notice, RedditLink, fmtDate, fmtNum } from './common';

const PAGE = 50;

interface Props {
  store: CollectorStore;
  jobs: JobRecord[];
  defaultFormat: ExportFormat;
  bom: boolean;
  /** Changes when records change (a job saved more), to refresh the list. */
  version: number;
  onChanged: () => void;
  /** Inside MetaCode: send the matching records to the project → a message. */
  onAddToProject?: (filter: RecordFilter) => Promise<string>;
}

type Row = PostRecord | CommentRecord;

export function Explorer({ store, jobs, defaultFormat, bom, version, onChanged, onAddToProject }: Props) {
  const [filter, setFilter] = useState<RecordFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<RecordSort>('collected_desc');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Row | null>(null);
  const [subs, setSubs] = useState<string[]>([]);
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await store.query(filter, sort, page * PAGE, PAGE);
      setRows(r.rows);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }, [store, filter, sort, page]);

  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => { store.subreddits().then(setSubs).catch(() => {}); }, [store, version]);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [filter, sort]);

  const set = <K extends keyof RecordFilter>(k: K, v: RecordFilter[K]) => setFilter(f => ({ ...f, [k]: v }));
  const isFiltered = !!(filter.text || filter.subreddit || filter.jobId || filter.collectedFrom || filter.collectedTo);

  async function remove(ids: string[], what: string) {
    if (!ids.length || !window.confirm('Delete ' + what + '? This can\'t be undone.' + (filter.type === 'post' ? ' Their collected comments are deleted too.' : ''))) return;
    await store.deleteRecords(filter.type, ids);
    setSelected(new Set());
    setDetail(null);
    setMessage({ tone: 'ok', text: 'Deleted ' + ids.length + ' record' + (ids.length === 1 ? '' : 's') + '.' });
    onChanged();
  }
  async function removeMatching() {
    const ids: string[] = [];
    await store.each(filter.type, filter, r => ids.push(r.id));
    await remove(ids, 'all ' + ids.length + ' matching ' + filter.type + 's');
  }

  async function doExport(scope: 'all' | 'filtered') {
    setExporting(true);
    setMessage(null);
    try {
      const result = await runExport({ format, scope, filter: scope === 'filtered' ? filter : null, bom, exportedAt: new Date().toISOString() }, store);
      result.files.forEach(download);
      setMessage({ tone: 'ok', text: 'Exported ' + fmtNum(result.posts) + ' posts and ' + fmtNum(result.comments) + ' comments (' + result.files.map(f => f.name).join(', ') + ').' });
    } catch (err) {
      setMessage({ tone: 'error', text: 'The export failed: ' + (err as Error).message });
    } finally {
      setExporting(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="explorer">
      <section className="card">
        <h2>Collected data</h2>
        <div className="filters">
          <div className="seg" role="radiogroup" aria-label="Record type">
            {(['post', 'comment'] as const).map(t => (
              <label key={t} className={filter.type === t ? 'on' : ''}><input type="radio" name="rtype" checked={filter.type === t} onChange={() => { set('type', t); setDetail(null); }} /> {t === 'post' ? 'Posts' : 'Comments'}</label>
            ))}
          </div>
          <input className="input grow" id="explorer-search" type="search" placeholder={filter.type === 'post' ? 'Search titles, text, subreddits, usernames' : 'Search comment text, subreddits, usernames'}
            value={filter.text} onChange={e => set('text', e.target.value)} aria-label="Search" />
          <select className="input" value={filter.subreddit} onChange={e => set('subreddit', e.target.value)} aria-label="Subreddit">
            <option value="">All subreddits</option>
            {subs.map(s => <option key={s} value={s}>r/{s}</option>)}
          </select>
          <select className="input" value={filter.jobId} onChange={e => set('jobId', e.target.value)} aria-label="Job">
            <option value="">All jobs</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{fmtDate(j.startedAt)} — {describeJob(j.config)}</option>)}
          </select>
          <label className="inline">Collected from <input className="input" type="date" value={filter.collectedFrom} onChange={e => set('collectedFrom', e.target.value)} /></label>
          <label className="inline">to <input className="input" type="date" value={filter.collectedTo} onChange={e => set('collectedTo', e.target.value)} /></label>
          <select className="input" value={sort} onChange={e => setSort(e.target.value as RecordSort)} aria-label="Sort">
            <option value="collected_desc">Recently collected</option>
            <option value="created_desc">Newest on Reddit</option>
            <option value="created_asc">Oldest on Reddit</option>
            <option value="score_desc">Highest score</option>
            <option value="subreddit_asc">Subreddit A–Z</option>
          </select>
          {isFiltered ? <button className="btn btn-ghost" onClick={() => setFilter({ ...EMPTY_FILTER, type: filter.type })}>Clear filters</button> : null}
        </div>

        <div className="toolbar">
          <span className="muted" id="explorer-count" aria-live="polite">{loading ? 'Loading…' : fmtNum(total) + ' ' + filter.type + (total === 1 ? '' : 's') + (isFiltered ? ' match' : '')}</span>
          <span className="grow" />
          <select className="input" value={format} onChange={e => setFormat(e.target.value as ExportFormat)} aria-label="Export format">
            <option value="json">JSON</option><option value="jsonl">JSON Lines</option><option value="csv">CSV (posts and comments files)</option>
          </select>
          {onAddToProject ? (
            <button className="btn btn-primary" id="add-to-project" disabled={exporting || !total} onClick={async () => {
              setExporting(true);
              try { setMessage({ tone: 'ok', text: await onAddToProject(filter) }); } catch (err) { setMessage({ tone: 'error', text: (err as Error).message }); } finally { setExporting(false); }
            }}>Add these {fmtNum(total)} to project</button>
          ) : null}
          <button className="btn" id="export-all" onClick={() => doExport('all')} disabled={exporting}>Export all data</button>
          <button className="btn" id="export-filtered" onClick={() => doExport('filtered')} disabled={exporting || !total}>Export these {fmtNum(total)}</button>
          <button className="btn btn-danger" onClick={() => remove(Array.from(selected), selected.size + ' selected ' + filter.type + (selected.size === 1 ? '' : 's'))} disabled={!selected.size}>Delete selected</button>
          {isFiltered ? <button className="btn btn-danger" onClick={removeMatching} disabled={!total}>Delete all matching</button> : null}
        </div>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

        <div className="table-wrap">
          <table className="table" id="explorer-table">
            <thead><tr>
              <th className="check"><input type="checkbox" aria-label="Select all on this page" checked={!!rows.length && rows.every(r => selected.has(r.id))}
                onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></th>
              <th>{filter.type === 'post' ? 'Post' : 'Comment'}</th><th>Subreddit</th><th>Author</th><th className="num">Score</th>
              {filter.type === 'post' ? <th className="num">Comments</th> : <th className="num">Depth</th>}<th>Created</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={'clickable' + (detail && detail.id === r.id ? ' is-selected' : '')} onClick={() => setDetail(r)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setDetail(r); }}>
                  <td className="check" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select" checked={selected.has(r.id)} onChange={e => { const n = new Set(selected); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSelected(n); }} />
                  </td>
                  <td className="clip-2">{r.record_type === 'post' ? (r.title || '(no title)') : (r.body || '(no text)')}</td>
                  <td>{r.subreddit ? 'r/' + r.subreddit : '—'}</td>
                  <td>{r.author || '—'}</td>
                  <td className="num">{fmtNum(r.score)}{r.counts_approximate ? '≈' : ''}</td>
                  <td className="num">{r.record_type === 'post' ? fmtNum(r.num_comments) : fmtNum(r.depth)}</td>
                  <td className="nowrap">{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !loading ? <p className="muted pad">{total ? '' : 'Nothing here yet.'}</p> : null}
        </div>
        {pages > 1 ? (
          <div className="pager">
            <button className="btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>Previous</button>
            <span className="muted">Page {page + 1} of {pages}</span>
            <button className="btn" onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next</button>
          </div>
        ) : null}
      </section>
      {detail ? <RecordDetail store={store} record={detail} onClose={() => setDetail(null)} onDelete={() => remove([detail.id], 'this ' + detail.record_type)} /> : null}
    </div>
  );
}

function RecordDetail({ store, record, onClose, onDelete }: { store: CollectorStore; record: Row; onClose: () => void; onDelete: () => void }) {
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  const [parent, setParent] = useState<PostRecord | null>(null);
  useEffect(() => {
    setComments(null);
    setParent(null);
    if (record.record_type === 'post') store.commentsForPost(record.id).then(setComments).catch(() => setComments([]));
    else store.getPost(record.post_id).then(p => setParent(p || null)).catch(() => {});
  }, [store, record]);

  const fields: [string, React.ReactNode][] = record.record_type === 'post' ? [
    ['Post ID', record.id], ['Type', record.post_type || '—'], ['Flair', record.flair || '—'], ['NSFW', record.over_18 === null ? '—' : record.over_18 ? 'yes' : 'no'],
    ['Links to', <ExternalLink key="l" href={record.link_url} />], ['Full details read', record.details_collected ? 'yes (post page)' : 'no (listing only)'],
    ['Collected', fmtDate(record.collected_at)], ['First collected', fmtDate(record.first_collected_at)], ['Read from', record.source_url]
  ] : [
    ['Comment ID', record.id], ['Post ID', record.post_id], ['Parent comment', record.parent_comment_id || '— (top level)'], ['Depth', fmtNum(record.depth)],
    ['Collected', fmtDate(record.collected_at)], ['Read from', record.source_url]
  ];

  return (
    <section className="card detail" aria-label="Record details" id="record-detail">
      <div className="card-head">
        <h2 className="detail-title">{record.record_type === 'post' ? (record.title || '(no title)') : 'Comment by ' + (record.author || 'unknown')}</h2>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <div className="muted small">
        {record.subreddit ? 'r/' + record.subreddit + ' · ' : ''}{record.author ? 'u/' + record.author + ' · ' : ''}{fmtDate(record.created_at)} · score {fmtNum(record.score)}{record.counts_approximate ? ' (rounded)' : ''}
        {record.record_type === 'post' ? ' · ' + fmtNum(record.num_comments) + ' comments' : ''}
      </div>
      {record.body ? <div className="body-text">{record.body}</div> : <p className="muted">{record.record_type === 'post' ? 'No text (a link or media post, or only the listing was read).' : 'No text.'}</p>}
      <dl className="kv">{fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className="actions">
        <RedditLink href={record.url}><span className="btn">Open on Reddit ↗</span></RedditLink>
        <button className="btn btn-danger" onClick={onDelete}>Delete</button>
      </div>
      {record.record_type === 'comment' && parent ? <p className="hint">On the post: {parent.title || parent.id}</p> : null}
      {record.record_type === 'post' ? (
        <>
          <h3>Collected comments {comments ? '(' + comments.length + ')' : ''}</h3>
          {comments && comments.length ? (
            <ol className="thread">
              {comments.slice(0, 300).map(c => (
                <li key={c.id} style={{ marginLeft: Math.min(8, c.depth || 0) * 16 }}>
                  <div className="muted small">{c.author || '[unknown]'} · {fmtNum(c.score)} · {fmtDate(c.created_at)}</div>
                  <div className="body-text">{c.body || '—'}</div>
                </li>
              ))}
            </ol>
          ) : <p className="muted">{comments ? 'None collected for this post.' : 'Loading…'}</p>}
        </>
      ) : null}
    </section>
  );
}
