export type TicketState =
  | 'DRAFT'
  | 'BACKLOG'
  | 'AWAIT_APPROVAL'
  | 'DESIGN'
  | 'READY'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'UAT'
  | 'READY_TO_LAND'
  | 'NEEDS_INTEGRATION'
  | 'DONE'
  | 'CLOSED'
  | 'BLOCKED';

export type EpicState = 'PLANNING' | 'AWAIT_PLAN' | 'BUILDING' | 'DONE' | 'BLOCKED';

export interface Ticket {
  id: number;
  key: string;
  title: string;
  description: string;
  status: TicketState;
  attempt: number;
  hasUi: boolean;
  epicId: number | null;
  seq: number | null;
  dependsOn: number[];
  feedback: string | null;
  gate: string | null;
  priority: string;
  labels: string[];
  interrupted: boolean;
}

export type TicketRelationType = 'blocks' | 'relates-to';

export interface TicketRelation {
  id: number;
  ticketId: number;
  otherTicketId: number;
  relationType: TicketRelationType;
  createdAt: string;
}

export interface Epic {
  id: number;
  key: string;
  title: string;
  description: string;
  status: EpicState;
  plan: string | null;
}

export interface Criterion {
  id: number;
  idx: number;
  text: string;
  isUi: boolean;
  met: boolean;
}

export interface Transition {
  id: number;
  fromState: TicketState;
  toState: TicketState;
  role: string | null;
  verdict: 'PASS' | 'FAIL' | null;
  note: string | null;
  createdAt: string;
}

export interface Artifact {
  id: number;
  kind: string;
  version: number;
  role: string;
  content: string;
  data: string | null;
  createdAt: string;
}

export interface AgentRun {
  id: number;
  role: string;
  runner: string | null;
  model: string | null;
  status: 'OK' | 'ERROR';
  costUsd: number;
  numTurns: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  error: string | null;
}

export interface TicketDetail extends Ticket {
  unblockRole: string | null;
  criteria: Criterion[];
  transitions: Transition[];
  artifacts: Artifact[];
  agentRuns: AgentRun[];
  costUsd: number;
  leadTimeMs: number | null;
  agentTimeMs: number;
  running: boolean;
  runStartedAt: string | null;
  runCommand: string | null;
  appUrl: string | null;
  relations: TicketRelation[];
}

export interface EpicDetail extends Epic {
  subtickets: Ticket[];
  agentRuns: AgentRun[];
  costUsd: number;
  leadTimeMs: number | null;
  agentTimeMs: number;
  running: boolean;
  runStartedAt: string | null;
  feedback: string | null;
}

export interface BoardData {
  epics: (Epic & { subtickets: Ticket[]; costUsd: number; leadTimeMs: number | null })[];
  standaloneTickets: Ticket[];
  pipeline: string[];
}

export interface RoleOverride {
  runner?: string;
  model?: string;
  escalation?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: string[];
}

export interface EmConfig {
  runCommand: string | null;
  appUrl: string | null;
  verifyCommand: string | null;
  mergeStrategy: 'merge' | 'pr' | 'none';
  ticketPrefix: string;
  epicPrefix: string;
  baseBranch: string | null;
  maxParallelSubtickets: number;
  maxAttempts: number;
  maxTicketBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  meetingModel: string | null;
  meetingMaxTurns: number | null;
  approvalMode: 'always' | 'epic-once' | 'never';
  autoResumeInterrupted: boolean;
  opencodeServerUrl: string | null;
  conventionFiles: string[];
  otelEndpoint: string | null;
  otelHeaders: Record<string, string>;
  mcpServers: Record<string, unknown>;
  pipeline: string[];
  roles: Record<string, RoleOverride>;
  runners: Record<string, unknown>;
}

export interface ConfigResponse {
  config: EmConfig;
  availableRunners: string[];
  roles: string[];
  defaults: { models: Record<string, string>; maxTurns: Record<string, number>; meetingMaxTurns: number };
}

export type RunEvent =
  | { type: 'log'; line: string }
  | { type: 'done'; status: string }
  | { type: 'error'; message: string }
  | { type: 'idle' };

export interface Report {
  windowDays: number | null;
  lifetime: { totalTokens: number; runs: number; totalUsd: number };
  tickets: {
    done: number;
    open: number;
    blocked: number;
    firstPass: number;
    avgAttempts: number | null;
    leadTime: { avgMs: number; p50Ms: number; p90Ms: number } | null;
    agentTimeMs: number;
  };
  throughput: Array<{ bucket: string; done: number }>;
  gates: {
    reviewFails: number;
    uatFails: number;
    humanRejections: number;
    autoApprovals: number;
  };
  spend: {
    totalUsd: number;
    perDoneTicketUsd: number | null;
    byRole: Array<{ key: string; usd: number }>;
    byRunner: Array<{ key: string; usd: number }>;
    byModel: Array<{ key: string; usd: number }>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    tokensByRole: Array<{ role: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  };
  runs: {
    total: number;
    errors: number;
    byRole: Array<{ role: string; runs: number; errors: number; avgDurationMs: number }>;
  };
  month: { spentUsd: number; budgetUsd: number | null };
  advice?: string[];
}
