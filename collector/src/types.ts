// ── Data schema ───────────────────────────────────────────────────────────────
// Every record the AI Scraper stores and exports. Values Reddit didn't give
// are `null` — never guessed — so a missing number is never confused with a
// real 0. Timestamps are ISO 8601 in UTC. See SCHEMA.md.

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

// ── Jobs (the AI Scraper) ─────────────────────────────────────────────────────
/** How the server reaches Reddit for a job: your own Reddit API keys, the server (its keys, or public pages), or RedditAPIs.com. */
export type RedditAccess = 'own' | 'server' | 'redditapis';

/** What the user asked for. The AI agent on the MetaCode server does the rest. */
export interface AiJobConfig {
  /** The goal, in the user's words. */
  goal: string;
  maxPosts: number;
  /** Comments saved with each kept post (0 = none). */
  commentsPerPost: number;
  /** Tool calls the AI may make. */
  maxSteps: number;
  maxMinutes: number;
  access: RedditAccess;
  /** The AI model ("" = the server's default). */
  model: string;
}

export type JobState = 'running' | 'paused' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface JobStats {
  postsCollected: number;
  commentsCollected: number;
  /** Tool calls the AI made. */
  steps: number;
  aiCalls: number;
  /** Requests to Reddit (or RedditAPIs.com). */
  requests: number;
  errors: number;
}

/** One thing the AI did, as shown in the job's timeline. */
export interface AiStep {
  step: number;
  tool: string;
  /** The call's arguments, summarized ("climate" · r/science · top week). */
  args: string;
  thought: string;
  /** What came back, summarized; null while it runs. */
  result: string | null;
  error: boolean;
}

export interface JobRecord {
  /** The MetaCode server's job id. */
  id: string;
  config: AiJobConfig;
  state: JobState;
  /** Why the job ended (finished, limit, stopped, an error…). */
  outcome: string | null;
  /** The AI's own summary of what it collected. */
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  stats: JobStats;
  steps: AiStep[];
  /** How many of the job's records have been copied into this browser. */
  synced: number;
}

export interface CollectionError {
  id?: number;
  jobId: string;
  at: string;
  url: string | null;
  kind: string;
  message: string;
}

// ── Settings ──────────────────────────────────────────────────────────────────
export interface Settings {
  /** Delete records not seen for this many days (0 = keep). */
  retentionDays: number;
  defaultMaxPosts: number;
  defaultCommentsPerPost: number;
  defaultMaxSteps: number;
  defaultMaxMinutes: number;
  exportFormat: ExportFormat;
  /** Byte-order mark at the start of CSV files (helps Excel read UTF-8). */
  csvBom: boolean;
}

export type ExportFormat = 'json' | 'jsonl' | 'csv';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry { at: string; level: LogLevel; message: string }
