// Types for the AI Coding Lab (ai-lab/). Used through JSDoc by the
// `// @ts-check` modules; `npm run typecheck` checks them.

export type Id = string;

/** Who a request belongs to, decided on the server (ai-lab/policy.js). */
export interface LabPrincipal {
  /** Stable, opaque key for the user's data folder (never an email). */
  key: string;
  /** The account id when accounts are on (for usage meters); else the browser owner hash. */
  userId: string;
  plan: string;
  limits: Record<string, number>;
  /** Accounts are off and the operator allowed the Lab without them. */
  anonymousMode: boolean;
}

export interface LabProject {
  id: Id;
  name: string;
  description: string;
  languages: string[];
  frameworks: string[];
  instructions: string;
  repository: { url: string | null; branch: string | null; notes: string } ;
  defaultProfileId: Id | null;
  defaultModel: { provider: string; model: string } | null;
  defaultDatasetId: Id | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Verbosity = 'concise' | 'balanced' | 'detailed';
export type ExplanationDepth = 'none' | 'brief' | 'thorough';

/** The structured fields of a coding profile (one version). */
export interface ProfileFields {
  description: string;
  language: string;
  frameworks: string[];
  conventions: string;
  architecture: string;
  naming: string;
  errorHandling: string;
  testing: string;
  documentation: string;
  security: string;
  dependencies: string;
  performance: string;
  verbosity: Verbosity;
  explanationDepth: ExplanationDepth;
  formatting: string;
  restrictions: string;
  reviewSteps: string[];
  extraInstructions: string;
  /** Inference settings that belong to the profile. */
  temperature: number | null;
  maxTokens: number | null;
}

export type ProfileVersionStatus = 'active' | 'candidate' | 'rejected' | 'superseded';

export interface ProfileVersion {
  version: number;
  createdAt: string;
  note: string;
  source: 'manual' | 'import' | 'optimization' | 'restore' | 'duplicate';
  status: ProfileVersionStatus;
  parentVersion: number | null;
  fields: ProfileFields;
  /** For optimization candidates: why each change was proposed, and from which run. */
  rationale?: { summary: string; changes: { field: string; reason: string }[]; fromRunId: Id | null; model: string | null } | null;
}

export interface CodingProfile {
  id: Id;
  name: string;
  projectId: Id | null;
  archived: boolean;
  currentVersion: number;
  versions: ProfileVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  /** true: reported by the provider; false: estimated by MetaCode (characters / 4). */
  measured: boolean;
}

export interface ContextReport {
  profile: { id: Id; version: number } | null;
  projectInstructions: boolean;
  documents: { docId: Id; name: string; chunk: number; score: number }[];
  messagesIncluded: number;
  messagesLeftOut: number;
  summaryUsed: boolean;
  estimatedInputTokens: number;
  budgetTokens: number;
}

export interface LabMessage {
  id: Id;
  role: 'user' | 'assistant';
  content: string;
  taskType: string | null;
  createdAt: string;
  provider?: string;
  model?: string;
  usage?: MessageUsage;
  cost?: CostEstimate;
  latencyMs?: number;
  stopped?: boolean;
  error?: { type: string; message: string } | null;
  context?: ContextReport;
}

export interface Conversation {
  id: Id;
  projectId: Id | null;
  title: string;
  profileId: Id | null;
  profileVersion: number | null;
  provider: string;
  model: string | null;
  summary: { text: string; coversMessages: number; createdAt: string } | null;
  messages: LabMessage[];
  createdAt: string;
  updatedAt: string;
}

export type IngestionStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface KnowledgeChunk {
  index: number;
  text: string;
  heading: string | null;
  startLine: number;
  endLine: number;
}

export interface KnowledgeDocument {
  id: Id;
  projectId: Id;
  name: string;
  kind: 'markdown' | 'text' | 'code' | 'data';
  language: string | null;
  bytes: number;
  sha256: string;
  status: IngestionStatus;
  error: string | null;
  warnings: string[];
  chunks: KnowledgeChunk[];
  createdAt: string;
  updatedAt: string;
}

export type CheckType = 'contains' | 'not_contains' | 'regex' | 'exact' | 'code_block' | 'json_schema' | 'syntax' | 'required_symbols' | 'max_length' | 'unit_tests' | 'ai_rubric';

export interface CheckSpec {
  type: CheckType;
  label?: string;
  value?: string;
  values?: string[];
  pattern?: string;
  flags?: string;
  language?: string;
  schema?: unknown;
  caseSensitive?: boolean;
  max?: number;
  tests?: string;
  criteria?: string;
  threshold?: number;
}

export interface CheckResult {
  type: CheckType;
  label: string;
  status: 'pass' | 'fail' | 'skipped' | 'error';
  detail: string;
  /** How the check decides: deterministic, or AI-graded (not ground truth). */
  method: 'deterministic' | 'ai_graded' | 'not_run';
  score?: number;
}

export interface DatasetExample {
  id: Id;
  task: string;
  input: string;
  expected: string;
  reference: string;
  language: string;
  framework: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard' | '';
  tags: string[];
  source: string;
  quality: 'unreviewed' | 'approved' | 'needs_work' | 'rejected';
  notes: string;
  split: 'train' | 'validation' | 'test' | null;
  weight: number;
  checks: CheckSpec[];
  createdAt: string;
  updatedAt: string;
}

export interface DatasetVersionInfo {
  version: number;
  createdAt: string;
  note: string;
  count: number;
  sha256: string;
}

export interface Dataset {
  id: Id;
  name: string;
  description: string;
  projectId: Id | null;
  draft: DatasetExample[];
  versions: DatasetVersionInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface SuiteConfig {
  datasetId: Id;
  datasetVersion: number;
  split: 'all' | 'train' | 'validation' | 'test';
  /** Checks applied to every task, besides each task's own. */
  checks: CheckSpec[];
  repeats: number;
  retrieval: { enabled: boolean; k: number };
  judgeModel: string | null;
}

export interface EvaluationSuite {
  id: Id;
  name: string;
  projectId: Id | null;
  currentVersion: number;
  versions: { version: number; createdAt: string; note: string; config: SuiteConfig }[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface CostEstimate {
  /** measured usage × configured prices; null when the price isn't known */
  amount: number | null;
  currency: string | null;
  basis: 'estimated' | 'unknown';
  pricingAsOf: string | null;
}

export interface RunMetrics {
  tasks: number;
  attempts: number;
  completed: number;
  errored: number;
  /** answers with at least one check that ran (pass or fail) */
  graded: number;
  passed: number;
  passRate: number | null;
  weightedPassRate: number | null;
  byCheck: Record<string, { pass: number; fail: number; skipped: number; error: number }>;
  aiGraded: { graded: number; meanScore: number | null } | null;
  consistency: { tasks: number; consistent: number } | null;
  failureCategories: Record<string, number>;
  latency: { p50Ms: number | null; p95Ms: number | null };
  tokens: { prompt: number; completion: number; measuredShare: number };
  cost: CostEstimate;
}

export interface EvaluationRun {
  id: Id;
  suiteId: Id;
  suiteVersion: number;
  datasetId: Id;
  datasetVersion: number;
  profileId: Id | null;
  profileVersion: number | null;
  projectId: Id | null;
  provider: string;
  model: string;
  settings: { temperature: number | null; maxTokens: number; repeats: number; retrieval: { enabled: boolean; k: number }; judgeModel: string | null; checks: number };
  status: RunStatus;
  error: { type: string; message: string } | null;
  progress: { done: number; total: number };
  metrics: RunMetrics | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  note: string;
}

export interface TaskResult {
  key: string;
  taskId: Id;
  repeat: number;
  output: string;
  checks: CheckResult[];
  passed: boolean;
  latencyMs: number | null;
  usage: MessageUsage | null;
  error: { type: string; message: string } | null;
  retrieved: { docId: Id; chunk: number }[];
}
