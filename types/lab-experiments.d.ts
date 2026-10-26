// Types for the AI Coding Lab's code experiments (ai-lab/experiments*.js,
// ai-lab/code-sandbox.js, ai-lab/code-policy.js). A user picks a variable
// (a Codebook dimension), asks an AI for a coding rule — a function that
// assigns one of the variable's codes to a record — edits it, runs it in
// the isolated sandbox against a read-only snapshot of records, compares
// versions and sends the chosen one to the Codebook.
//
// Used through JSDoc by the `// @ts-check` modules; `npm run typecheck`
// checks them. Every shape that crosses the API is listed here.

import type { Id, LabPrincipal, MessageUsage } from './ai-lab';

export type CodeLanguage = 'javascript' | 'typescript' | 'python';

/* ── Sandbox data ───────────────────────────────────────────── */

/** One code of a variable (a Codebook dimension's code). Ids match /^[a-z0-9_-]{1,64}$/i. */
export interface VariableCode { id: string; label: string; description: string }

/** The variable (Codebook dimension) an experiment improves. */
export interface SandboxVariable {
  /** The Codebook dimension id (stable across renames). */
  id: string;
  name: string;
  description: string;
  codes: VariableCode[];
}

/** One record as stored in a sandbox version (server-side only). */
export interface SandboxRecord {
  /** Unique within the version, /^[A-Za-z0-9_.:-]{1,120}$/. */
  id: string;
  text: string;
  author: string;
  timestamp: string;
  /** Small, flat, non-identifying extras (engagement counts, platform). */
  meta: Record<string, string | number | boolean | null>;
  /** The reference label (adjudicated or human code) — never passed to code under test. */
  reference: string | null;
  /** Where the reference came from. */
  referenceSource: 'adjudicated' | 'agreed' | 'coder1' | 'coder2' | 'dataset' | null;
  /** MetaCode's current AI Coding label (the existing implementation) — never passed to code under test. */
  baseline: string | null;
  /** Deterministic split: 'dev' records may be shown to the AI as examples; 'test' records never are. */
  split: 'dev' | 'test';
}

/** What code under test receives for each record: no labels, no split. */
export interface SandboxInputRecord {
  id: string;
  text: string;
  author: string;
  timestamp: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface SandboxVersionInfo {
  version: number;
  createdAt: string;
  /** sha256 of the canonical JSON of {variable, records}. Re-verified before every run. */
  sha256: string;
  count: number;
  referenceCount: number;
  baselineCount: number;
  devCount: number;
  testCount: number;
  note: string;
}

export interface SandboxSource {
  kind: 'project' | 'dataset';
  /** The MetaCode project's name when the records came from the app (display only). */
  projectName: string | null;
  datasetId: Id | null;
  datasetVersion: number | null;
}

export interface Sandbox {
  id: Id;
  schemaVersion: 1;
  name: string;
  source: SandboxSource;
  /** The variable as of the latest version (each version also stores its own copy). */
  variable: SandboxVariable;
  versions: SandboxVersionInfo[];
  createdAt: string;
  updatedAt: string;
}

/** Sidecar sandboxes/<id>/v<n>.json */
export interface SandboxVersionFile { version: number; variable: SandboxVariable; records: SandboxRecord[] }

/* ── Security ───────────────────────────────────────────────── */

export interface PolicyFinding {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  line: number | null;
  column: number | null;
  excerpt: string;
}

/** Stage 3: deterministic policy and static analysis. Authoritative: errors always block. */
export interface PolicyReport {
  ok: boolean;
  policyVersion: string;
  language: CodeLanguage;
  /** 'acorn' (JavaScript/TypeScript, on the server) or 'python-ast' (Python, inside the sandbox before any user code). */
  engine: 'acorn' | 'python-ast';
  codeHash: string;
  findings: PolicyFinding[];
  checkedAt: string;
}

export type ReviewDecision = 'approved' | 'rejected' | 'needs_review' | 'unavailable';

export interface ReviewRisk {
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  line: number | null;
  excerpt: string;
  explanation: string;
}

/** Stage 2: AI security review. One layer of defence, never the boundary. */
export interface SecurityReview {
  decision: ReviewDecision;
  risks: ReviewRisk[];
  summary: string;
  saferAlternative: string;
  codeHash: string;
  provider: string | null;
  model: string | null;
  method: 'ai-review-v1';
  reviewedAt: string;
  /** Why the review couldn't be made (decision 'unavailable'). */
  error: string | null;
}

/** How the run was isolated (reported, never assumed). */
export interface IsolationReport {
  engine: string;
  process: string;
  network: string;
  filesystem: string;
  environment: string;
  limits: string;
  /** OS-level network isolation was in effect. */
  networkNamespace: boolean;
}

/* ── Experiments and versions ───────────────────────────────── */

export type VersionOrigin = 'generated' | 'edited' | 'duplicated' | 'reverted' | 'imported';

export interface GenerationInfo {
  provider: string;
  model: string;
  prompt: string;
  mode: 'new' | 'alternative' | 'refine';
  summary: string;
  proposedImprovement: string;
  reasoning: string;
  assumptions: string[];
  expectedTradeoffs: string[];
  usage: MessageUsage | null;
}

export interface ExperimentVersion {
  version: number;
  parent: number | null;
  origin: VersionOrigin;
  label: string;
  annotation: string;
  candidate: boolean;
  language: CodeLanguage;
  code: string;
  codeHash: string;
  createdAt: string;
  /** The prompt that produced this version (generated) or null. */
  prompt: string | null;
  generation: GenerationInfo | null;
  policy: PolicyReport | null;
  review: SecurityReview | null;
  /** The user ran a version whose review said needs_review/unavailable after reading it. */
  reviewAck: { at: string; codeHash: string } | null;
  runIds: Id[];
  lastRun: { id: Id; status: ExecutionStatus; finishedAt: string | null } | null;
  evaluation: AiEvaluation | null;
}

export type MetricKey =
  | 'accuracy' | 'macroF1' | 'kappa' | 'coverage' | 'errorRate' | 'baselineAgreement'
  | 'consistency' | 'runtime' | `precision:${string}` | `recall:${string}` | `f1:${string}`;

export interface SuccessCriterion { metric: MetricKey; weight: number }

export interface ThreadMessage {
  id: Id;
  role: 'user' | 'assistant';
  kind: 'generate' | 'ask' | 'note';
  text: string;
  version: number | null;
  createdAt: string;
  model: string | null;
}

export interface CodebookSubmission {
  id: Id;
  idempotencyKey: string;
  version: number;
  codeHash: string;
  status: 'pending' | 'applied' | 'failed';
  createdAt: string;
  resolvedAt: string | null;
  /** Set when an explicit Send/Retry put the submission back to pending. */
  resentAt?: string | null;
  dimensionId: string | null;
  error: string | null;
  payload: CodingRule;
}

export interface Experiment {
  id: Id;
  name: string;
  notes: string;
  archived: boolean;
  sandboxId: Id;
  sandboxVersion: number;
  variable: SandboxVariable;
  language: CodeLanguage;
  objective: { text: string; criteria: SuccessCriterion[] };
  versions: ExperimentVersion[];
  thread: ThreadMessage[];
  selected: { version: number; codeHash: string; runId: Id; rationale: string; selectedAt: string } | null;
  submissions: CodebookSubmission[];
  createdAt: string;
  updatedAt: string;
}

/* ── Execution ──────────────────────────────────────────────── */

export type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
export type ExecutionStage = 'input' | 'review' | 'policy' | 'execution' | 'output' | 'metrics' | 'done';

export interface TerminalLine {
  seq: number;
  /** Milliseconds since the run started. */
  t: number;
  stream: 'system' | 'stdout' | 'stderr';
  level: 'info' | 'warn' | 'error' | 'success';
  stage: ExecutionStage;
  text: string;
}

export interface ExecutionRequest {
  version: number;
  /** Must equal the stored version's code hash (stale-editor guard). */
  codeHash: string;
  split: 'all' | 'test' | 'dev';
}

/** What the sandbox runner returns (ai-lab/code-sandbox.js). */
export interface SandboxOutcome {
  ok: boolean;
  /** Raw per-record outputs, as returned by the code (validated later). */
  outputs: RawRecordOutput[];
  failure: { type: string; message: string } | null;
  policy: PolicyFinding[] | null;
  durationMs: number;
  bootMs: number;
  resources: { rssBytes: number | null; engineMemoryBytes: number | null; outputBytes: number; logBytes: number };
  isolation: IsolationReport;
  engine: { name: string; version: string };
}

export interface RawRecordOutput { id: string; out?: unknown; error?: string; ms?: number }

/** One validated result (sidecar xruns/<id>/results.json → { results }). */
export interface RecordResult {
  id: string;
  code: string | null;
  confidence: number | null;
  reason: string;
  error: string | null;
  ms: number | null;
}

export interface OutputValidation {
  valid: boolean;
  checked: number;
  invalid: number;
  missing: number;
  unexpected: number;
  problems: { id: string | null; problem: string }[];
}

export interface ClassScores { precision: number | null; recall: number | null; f1: number | null; support: number }

export interface ReferenceScores {
  n: number;
  accuracy: number | null;
  macroF1: number | null;
  kappa: number | null;
  kappaReason: string | null;
  perCode: Record<string, ClassScores>;
  confusion: { categories: string[]; matrix: number[][] } | null;
}

export interface ExecutionMetrics {
  records: number;
  processed: number;
  errors: number;
  errorRate: number | null;
  coverage: number | null;
  distribution: Record<string, number>;
  /** Against reference labels: on held-out (test) records, on dev records, on all. null = no reference labels. */
  reference: { test: ReferenceScores | null; dev: ReferenceScores | null; all: ReferenceScores | null } | null;
  /** Against MetaCode's current AI Coding labels (agreement, not correctness). */
  baseline: { n: number; agreement: number | null; kappa: number | null; changed: number } | null;
  consistency: { groups: number; inconsistent: number; score: number | null };
  runtime: { durationMs: number; perRecordMeanMs: number | null };
}

export interface ExecutionRun {
  id: Id;
  experimentId: Id;
  version: number;
  codeHash: string;
  language: CodeLanguage;
  status: ExecutionStatus;
  stage: ExecutionStage;
  failure: { type: string; message: string; stage: ExecutionStage } | null;
  sandbox: { id: Id; version: number; sha256: string; split: 'all' | 'test' | 'dev'; recordCount: number; recordIdsHash: string };
  config: { timeoutMs: number; memoryMb: number; maxOutputKb: number; policyVersion: string; contract: 'classify/1'; node: string };
  engine: { name: string; version: string } | null;
  isolation: IsolationReport | null;
  security: { policy: PolicyReport | null; review: SecurityReview | null; acknowledged: boolean };
  /** The last lines only (≤ 20); the whole log is the sidecar xruns/<id>/log.json, served by GET /xruns/:id?since. */
  log: TerminalLine[];
  logTotal?: number;
  logTruncated: boolean;
  timing: { queuedAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null; bootMs: number | null };
  resources: SandboxOutcome['resources'] | null;
  output: OutputValidation | null;
  metrics: ExecutionMetrics | null;
  createdAt: string;
}

/* ── Evaluation and comparison ──────────────────────────────── */

export interface AiEvaluation {
  runId: Id;
  against: { kind: 'baseline' | 'version' | 'none'; version: number | null; runId: Id | null };
  proposedImprovement: string;
  reasoning: string;
  observedResults: string;
  comparison: string;
  tradeoffs: string;
  limitations: string;
  recommendation: 'retain' | 'revise' | 'reject';
  /** Numbers in the AI's text that don't match a measured value. */
  unverifiedNumbers: string[];
  provider: string;
  model: string;
  method: 'ai-eval-v1';
  createdAt: string;
}

/* ── Codebook ───────────────────────────────────────────────── */

/** What the Codebook keeps on the dimension (dim.codingRule), written by the app after the user confirms. */
export interface CodingRule {
  schema: 'metacode.coding-rule/1';
  submissionId: Id;
  status: 'experimental';
  dimensionId: string;
  experiment: { id: Id; name: string };
  version: number;
  codeHash: string;
  language: CodeLanguage;
  code: string;
  contract: { name: 'classify/1'; input: Record<string, unknown>; output: Record<string, unknown> };
  prompts: { original: string; final: string };
  rationale: string;
  evaluation: {
    runId: Id;
    finishedAt: string | null;
    /** The records the run covered. */
    split: 'all' | 'test' | 'dev';
    /** The records accuracy, macro-F1 and κ are measured on: 'test' (held-out) when the run had labelled ones. */
    referenceSplit: 'all' | 'test' | 'dev';
    records: number;
    accuracy: number | null;
    macroF1: number | null;
    kappa: number | null;
    referenceN: number;
    coverage: number | null;
    errorRate: number | null;
    baselineAgreement: number | null;
    recommendation: AiEvaluation['recommendation'] | null;
  };
  security: { policy: 'passed'; review: ReviewDecision; reviewedAt: string | null };
  sandbox: { id: Id; name: string; version: number; sha256: string; source?: { kind: SandboxSource['kind']; projectName: string | null } | null };
  selectedAt: string;
  sentAt: string;
}

export type { Id, LabPrincipal };
