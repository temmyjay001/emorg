import type { Role } from '../config';

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

export type Verdict = 'PASS' | 'FAIL';

export type TicketRelationType = 'blocks' | 'relates-to';

export type ArtifactKind =
  | 'TICKET'
  | 'PLAN'
  | 'DIFF'
  | 'REVIEW'
  | 'UAT'
  | 'EVIDENCE'
  | 'ATTACHMENT'
  | 'GUIDANCE'
  | 'VERIFY';

export type ArtifactAuthor = Role | 'human' | (string & {});

export interface Epic {
  id: number;
  key: string;
  title: string;
  description: string;
  status: EpicState;
  plan: string | null;
  feedback: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  id: number;
  key: string;
  title: string;
  description: string;
  status: TicketState;
  attempt: number;
  branch: string | null;
  baseSha: string | null;
  mergedSha: string | null;
  jiraKey: string | null;
  hasUi: boolean;
  runCommand: string | null;
  appUrl: string | null;
  epicId: number | null;
  seq: number | null;
  dependsOn: number[];
  feedback: string | null;
  gate: string | null;
  priority: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TicketRelation {
  id: number;
  ticketId: number;
  otherTicketId: number;
  relationType: TicketRelationType;
  createdAt: string;
}

export interface AcceptanceCriterion {
  id: number;
  ticketId: number;
  idx: number;
  text: string;
  isUi: boolean;
  met: boolean;
}

export interface Artifact {
  id: number;
  ticketId: number;
  kind: ArtifactKind;
  version: number;
  role: ArtifactAuthor;
  content: string;
  data: string | null;
  createdAt: string;
}

export interface Transition {
  id: number;
  ticketId: number;
  fromState: TicketState;
  toState: TicketState;
  role: string | null;
  verdict: Verdict | null;
  note: string | null;
  createdAt: string;
}

export type RunStatus = 'RUNNING' | 'OK' | 'ERROR' | 'CANCELLED';

export interface Run {
  id: number;
  target: string;
  status: RunStatus;
  pid: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunLogLine {
  id: number;
  runId: number;
  line: string;
  createdAt: string;
}

export interface AgentRunRecord {
  id: number;
  ticketId: number | null;
  epicId: number | null;
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
  createdAt: string;
}

export interface GateResult {
  verdict: Verdict;
  summary: string;
  artifact?: { kind: ArtifactKind; content: string; data?: unknown };
  criteria?: { idx: number; met: boolean; note?: string }[];
}

export interface PlannedSubticket {
  title: string;
  description: string;
  dependsOn: number[];
}

export type MeetingStatus = 'OPEN' | 'ENDED';

export interface Meeting {
  id: number;
  title: string;
  participants: string[];
  ticketId: number | null;
  epicId: number | null;
  status: MeetingStatus;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingMessage {
  id: number;
  meetingId: number;
  speaker: string;
  text: string;
  createdAt: string;
}

export type DraftMessageSender = 'stakeholder' | 'pm';

export interface TicketDraftMessage {
  id: number;
  ticketId: number;
  sender: DraftMessageSender;
  text: string;
  createdAt: string;
}
