// ── Building an export from the local store ───────────────────────────────────
// Used by the export Web Worker (and directly where workers aren't available).
// Records are streamed from IndexedDB with cursors, one at a time.

import type { CommentRecord, ExportFormat, PostRecord } from '../types';
import type { CollectorStore, RecordFilter } from '../store/db';
import { ExportBuilder } from './format';

export interface ExportRequest {
  format: ExportFormat;
  /** all = every post and comment; filtered = the records matching `filter` (of its type). */
  scope: 'all' | 'filtered';
  filter: RecordFilter | null;
  bom: boolean;
  exportedAt: string;
}

export interface ExportResult { files: { name: string; blob: Blob }[]; posts: number; comments: number }

export async function buildExport(store: CollectorStore, request: ExportRequest): Promise<ExportResult> {
  const builder = new ExportBuilder(request.format, {
    exportedAt: request.exportedAt, scope: request.scope, bom: request.bom,
    filter: request.scope === 'filtered' && request.filter ? { ...request.filter } : null
  });
  const wantPosts = request.scope === 'all' || !request.filter || request.filter.type === 'post';
  const wantComments = request.scope === 'all' || !request.filter || request.filter.type === 'comment';
  const filter = request.scope === 'filtered' && request.filter ? request.filter : {};
  if (wantPosts) await store.each('post', filter, r => builder.addPost(r as PostRecord));
  if (wantComments) await store.each('comment', filter, r => builder.addComment(r as CommentRecord));
  const files = builder.finish().map(f => ({ name: f.name, blob: new Blob(f.parts, { type: f.type }) }));
  return { files, posts: builder.postCount, comments: builder.commentCount };
}
