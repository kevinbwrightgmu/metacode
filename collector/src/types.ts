// ── Data schema ───────────────────────────────────────────────────────────────
// Every record the collector stores and exports. Values that Reddit didn't
// show are `null` — never guessed — so a missing number is never confused
// with a real 0. Timestamps are ISO 8601 in UTC. See SCHEMA.md.

export const SCHEMA_VERSION = 1;

export type PostType = 'text' | 'link' | 'image' | 'video' | 'gallery' | 'poll' | 'crosspost' | 'other';

export interface PostRecord {
  record_type: 'post';
  /** Reddit's base-36 id without the "t3_" prefix; the deduplication key. */
  id: string;
  /** "t3_" + id */
  fullname: string;
  /** Canonical https://www.reddit.com/r/<sub>/comments/<id>/<slug>/ address. */
  url: string;
  /** Subreddit name without "r/". */
  subreddit: string | null;
  title: string | null;
  /** The post's text as plain text; null for posts without text, or when only the listing was read and it showed none. */
  body: string | null;
  /** Username without "u/", as displayed ("[deleted]" stays as shown); null when not displayed. */
  author: string | null;
  created_at: string | null;
  /** Displayed score; null when hidden or not shown. */
  score: number | null;
  num_comments: number | null;
  /** True when score or num_comments was read from a rounded display such as "1.2k". */
  counts_approximate: boolean;
  /** Where the post links (http/https only); null for text posts. */
  link_url: string | null;
  post_type: PostType | null;
  flair: string | null;
  over_18: boolean | null;
  /** Whether the post's own page was read (full text, exact details), not only a listing. */
  details_collected: boolean;
  /** The page the latest values were read from. */
  source_url: string;
  first_collected_at: string;
  /** Last time this post was seen. */
  collected_at: string;
  /** Jobs that saw this post. */
  job_ids: string[];
}

export interface CommentRecord {
  record_type: 'comment';
  /** Base-36 id without "t1_"; the deduplication key. */
  id: string;
  fullname: string;
  /** The post's id (without "t3_"). */
  post_id: string;
  /** The parent comment's id, or null for a top-level comment. */
  parent_comment_id: string | null;
  subreddit: string | null;
  author: string | null;
  body: string | null;
  created_at: string | null;
  score: number | null;
  counts_approximate: boolean;
  /** 0 for top-level comments. */
  depth: number | null;
  /** Canonical permalink, when the page showed one. */
  url: string | null;
  source_url: string;
  first_collected_at: string;
  collected_at: string;
  job_ids: string[];
}

export type CollectedRecord = PostRecord | CommentRecord;

// ── Jobs ──────────────────────────────────────────────────────────────────────
export type CollectMode = 'posts' | 'comments' | 'both';
export type ListingSort = 'hot' | 'new' | 'top' | 'rising';
export type TopTime = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface JobConfig {
  targetType: 'subreddit' | 'search';
  /** Subreddit names (without "r/") for targetType "subreddit". */
  subreddits: string[];
  sort: ListingSort;
  time: TopTime;
  /** Search text for targetType "search". */
  query: string;
  /** Limit a search to one subreddit (optional). */
  searchSubreddit: string;
  /** posts: listing data only · comments: comments only (opens each post) · both: posts with full details + comments */
  mode: CollectMode;
  maxPosts: number;
  maxCommentsPerPost: number;
  /** Optional YYYY-MM-DD bounds (inclusive, UTC) on the post's creation date. */
  dateFrom: string;
  dateTo: string;
  /** Pages or scroll steps per listing (and per post page, for comments). */
  maxDepth: number;
  maxRuntimeMinutes: number;
}

export type JobState = 'running' | 'paused' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface JobStats {
  postsCollected: number;
  commentsCollected: number;
  postsSkipped: number;
  pagesVisited: number;
  errors: number;
  retries: number;
}

export interface JobRecord {
  id: string;
  config: JobConfig;
  state: JobState;
  /** Why the job ended (limit reached, stopped, Reddit refused…). */
  outcome: string | null;
  startedAt: string;
  finishedAt: string | null;
  stats: JobStats;
  /** The robots.txt check made before the job, as shown to the user. */
  robots: RobotsDecision | null;
}

export interface CollectionError {
  id?: number;
  jobId: string;
  at: string;
  url: string | null;
  kind: string;
  message: string;
}

export interface RobotsDecision {
  checked: boolean;
  allowed: boolean;
  /** The rule that decided it, e.g. "Disallow: /"; null when no rule matched. */
  rule: string | null;
  policy: RobotsPolicy;
  note: string;
}

export type RobotsPolicy = 'obey' | 'warn';

// ── Settings ──────────────────────────────────────────────────────────────────
export interface Settings {
  /** Base address the bot opens: https://www.reddit.com, https://old.reddit.com, or a mirror the server allows. */
  redditBase: string;
  /** Wait between page loads (ms). */
  pageDelayMs: number;
  /** Wait after each scroll for new content (ms). */
  scrollDelayMs: number;
  /** How long a page may take to load (ms). */
  pageTimeoutMs: number;
  /** Retries of a failed page load, with exponential backoff. */
  maxRetries: number;
  robotsPolicy: RobotsPolicy;
  /** Delete records not seen for this many days (0 = keep). */
  retentionDays: number;
  defaultMaxPosts: number;
  defaultMaxComments: number;
  exportFormat: ExportFormat;
  /** Byte-order mark at the start of CSV files (helps Excel read UTF-8). */
  csvBom: boolean;
  /** How the browser panel reaches Reddit (applies when the page loads). */
  connection: ConnectionMode;
}

export type ExportFormat = 'json' | 'jsonl' | 'csv';
/** auto: Wisp (WebSocket) when it opens, else MetaCode's HTTP relay · wisp: Wisp only · http: HTTP relay only */
export type ConnectionMode = 'auto' | 'wisp' | 'http';

// ── Bot events ────────────────────────────────────────────────────────────────
export interface JobProgress {
  jobId: string;
  state: JobState;
  operation: string;
  currentUrl: string | null;
  target: string | null;
  stats: JobStats;
  limits: { maxPosts: number; maxRuntimeMs: number };
  startedAt: string;
  elapsedMs: number;
}

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry { at: string; level: LogLevel; message: string }
