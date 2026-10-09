// ── Export formats ────────────────────────────────────────────────────────────
// JSON (one document with "posts" and "comments" arrays), JSON Lines (one
// record per line, each with its record_type) and CSV (one file per record
// type — posts.csv and comments.csv). Every field of the schema is exported:
// the CSV columns are the record's fields, arrays are joined with ";", and
// booleans/numbers are written as-is. Text is UTF-8; timestamps are the
// stored ISO 8601 UTC values. See SCHEMA.md.

import { SCHEMA_VERSION, type CommentRecord, type ExportFormat, type PostRecord } from '../types';

export const POST_COLUMNS: (keyof PostRecord)[] = [
  'record_type', 'id', 'fullname', 'url', 'subreddit', 'title', 'body', 'author', 'created_at', 'score', 'num_comments',
  'counts_approximate', 'link_url', 'post_type', 'flair', 'over_18', 'details_collected', 'source_url',
  'first_collected_at', 'collected_at', 'job_ids'
];
export const COMMENT_COLUMNS: (keyof CommentRecord)[] = [
  'record_type', 'id', 'fullname', 'post_id', 'parent_comment_id', 'subreddit', 'author', 'body', 'created_at', 'score',
  'counts_approximate', 'depth', 'url', 'source_url', 'first_collected_at', 'collected_at', 'job_ids'
];

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with
 * = + - @ or a tab/return) gets a leading apostrophe, because scraped text is
 * untrusted. Quotes are doubled; cells with commas, quotes or line breaks are quoted.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (Array.isArray(value)) s = value.join(';');
  else if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  else s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

export interface ExportFile { name: string; type: string; parts: string[] }

export interface ExportMeta {
  exportedAt: string;
  scope: 'all' | 'filtered';
  filter: Record<string, unknown> | null;
  bom: boolean;
}

function stamp(iso: string): string {
  return iso.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

/** Builds export files from records added one at a time (posts, then comments). */
export class ExportBuilder {
  private posts: string[] = [];
  private comments: string[] = [];
  postCount = 0;
  commentCount = 0;

  constructor(private format: ExportFormat, private meta: ExportMeta) {}

  addPost(r: PostRecord): void {
    this.postCount++;
    if (this.format === 'csv') this.posts.push(csvRow(POST_COLUMNS.map(c => r[c])));
    else if (this.format === 'jsonl') this.posts.push(JSON.stringify(ordered(r, POST_COLUMNS)) + '\n');
    else this.posts.push((this.postCount > 1 ? ',\n    ' : '\n    ') + JSON.stringify(ordered(r, POST_COLUMNS)));
  }

  addComment(r: CommentRecord): void {
    this.commentCount++;
    if (this.format === 'csv') this.comments.push(csvRow(COMMENT_COLUMNS.map(c => r[c])));
    else if (this.format === 'jsonl') this.comments.push(JSON.stringify(ordered(r, COMMENT_COLUMNS)) + '\n');
    else this.comments.push((this.commentCount > 1 ? ',\n    ' : '\n    ') + JSON.stringify(ordered(r, COMMENT_COLUMNS)));
  }

  finish(): ExportFile[] {
    const base = 'reddit-collector-' + stamp(this.meta.exportedAt) + (this.meta.scope === 'filtered' ? '-filtered' : '');
    if (this.format === 'csv') {
      const bom = this.meta.bom ? '﻿' : '';
      const files: ExportFile[] = [];
      if (this.postCount || !this.commentCount) files.push({ name: base + '-posts.csv', type: 'text/csv;charset=utf-8', parts: [bom + csvRow(POST_COLUMNS), ...this.posts] });
      if (this.commentCount) files.push({ name: base + '-comments.csv', type: 'text/csv;charset=utf-8', parts: [bom + csvRow(COMMENT_COLUMNS), ...this.comments] });
      return files;
    }
    if (this.format === 'jsonl') {
      return [{ name: base + '.jsonl', type: 'application/x-ndjson;charset=utf-8', parts: [...this.posts, ...this.comments] }];
    }
    const head = '{\n  "schema_version": ' + SCHEMA_VERSION + ',\n  "exported_at": ' + JSON.stringify(this.meta.exportedAt) +
      ',\n  "scope": ' + JSON.stringify(this.meta.scope) + ',\n  "filter": ' + JSON.stringify(this.meta.filter) +
      ',\n  "counts": ' + JSON.stringify({ posts: this.postCount, comments: this.commentCount }) + ',\n  "posts": [';
    return [{
      name: base + '.json', type: 'application/json;charset=utf-8',
      parts: [head, ...this.posts, (this.postCount ? '\n  ' : '') + '],\n  "comments": [', ...this.comments, (this.commentCount ? '\n  ' : '') + ']\n}\n']
    }];
  }
}

/** The record with its fields in schema order (and nothing else). */
function ordered<T extends object>(r: T, columns: (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c as string] = r[c] === undefined ? null : r[c];
  return out;
}
