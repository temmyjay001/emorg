import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { leadTimeStats, type KeyedUsd, type Report, type RoleTokenStats } from '../domain/report';
import { isRework } from '../domain/states';
import type {
  AcceptanceCriterion,
  Meeting,
  MeetingMessage,
  MeetingStatus,
  AgentRunRecord,
  Artifact,
  ArtifactAuthor,
  ArtifactKind,
  DraftMessageSender,
  Epic,
  EpicState,
  PlannedSubticket,
  Run,
  RunLogLine,
  RunStatus,
  Ticket,
  TicketDraftMessage,
  TicketRelation,
  TicketRelationType,
  TicketState,
  Transition,
  Verdict,
} from '../domain/types';
import { createSchema } from './schema';

interface EpicRow {
  id: number;
  key: string;
  title: string;
  description: string;
  status: string;
  plan: string | null;
  plan_json: string | null;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}

interface TicketRow {
  id: number;
  key: string;
  title: string;
  description: string;
  status: string;
  attempt: number;
  branch: string | null;
  base_sha: string | null;
  merged_sha: string | null;
  jira_key: string | null;
  has_ui: number;
  run_command: string | null;
  app_url: string | null;
  epic_id: number | null;
  seq: number | null;
  depends_on: string | null;
  feedback: string | null;
  gate: string | null;
  priority: string;
  labels: string;
  created_at: string;
  updated_at: string;
}

interface TicketRelationRow {
  id: number;
  ticket_id: number;
  other_ticket_id: number;
  relation_type: string;
  created_at: string;
}

interface CriterionRow {
  id: number;
  ticket_id: number;
  idx: number;
  text: string;
  is_ui: number;
  met: number;
}

interface ArtifactRow {
  id: number;
  ticket_id: number;
  kind: string;
  version: number;
  role: string;
  content: string;
  data: string | null;
  created_at: string;
}

interface TransitionRow {
  id: number;
  ticket_id: number;
  from_state: string;
  to_state: string;
  role: string | null;
  verdict: string | null;
  note: string | null;
  created_at: string;
}

interface RunRow {
  id: number;
  target: string;
  status: string;
  pid: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface RunLogRow {
  id: number;
  run_id: number;
  line: string;
  created_at: string;
}

interface AgentRunRow {
  id: number;
  ticket_id: number | null;
  epic_id: number | null;
  role: string;
  runner: string | null;
  model: string | null;
  status: string;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  error: string | null;
  created_at: string;
}

const toEpic = (r: EpicRow): Epic => ({
  id: r.id,
  key: r.key,
  title: r.title,
  description: r.description,
  status: r.status as EpicState,
  plan: r.plan,
  feedback: r.feedback,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  key: r.key,
  title: r.title,
  description: r.description,
  status: r.status as TicketState,
  attempt: r.attempt,
  branch: r.branch,
  baseSha: r.base_sha,
  mergedSha: r.merged_sha,
  jiraKey: r.jira_key,
  hasUi: !!r.has_ui,
  runCommand: r.run_command,
  appUrl: r.app_url,
  epicId: r.epic_id,
  seq: r.seq,
  dependsOn: r.depends_on ? (JSON.parse(r.depends_on) as number[]) : [],
  feedback: r.feedback,
  gate: r.gate,
  priority: r.priority,
  labels: JSON.parse(r.labels) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTicketRelation = (r: TicketRelationRow): TicketRelation => ({
  id: r.id,
  ticketId: r.ticket_id,
  otherTicketId: r.other_ticket_id,
  relationType: r.relation_type as TicketRelationType,
  createdAt: r.created_at,
});

const toCriterion = (r: CriterionRow): AcceptanceCriterion => ({
  id: r.id,
  ticketId: r.ticket_id,
  idx: r.idx,
  text: r.text,
  isUi: !!r.is_ui,
  met: !!r.met,
});

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  ticketId: r.ticket_id,
  kind: r.kind as ArtifactKind,
  version: r.version,
  role: r.role as ArtifactAuthor,
  content: r.content,
  data: r.data,
  createdAt: r.created_at,
});

const toTransition = (r: TransitionRow): Transition => ({
  id: r.id,
  ticketId: r.ticket_id,
  fromState: r.from_state as TicketState,
  toState: r.to_state as TicketState,
  role: r.role,
  verdict: r.verdict as Verdict | null,
  note: r.note,
  createdAt: r.created_at,
});

const toRun = (r: RunRow): Run => ({
  id: r.id,
  target: r.target,
  status: r.status as RunStatus,
  pid: r.pid,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toRunLog = (r: RunLogRow): RunLogLine => ({
  id: r.id,
  runId: r.run_id,
  line: r.line,
  createdAt: r.created_at,
});

const toAgentRun = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id,
  ticketId: r.ticket_id,
  epicId: r.epic_id,
  role: r.role,
  runner: r.runner,
  model: r.model,
  status: r.status as 'OK' | 'ERROR',
  costUsd: r.cost_usd,
  numTurns: r.num_turns,
  durationMs: r.duration_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  error: r.error,
  createdAt: r.created_at,
});

interface MeetingRow {
  id: number;
  title: string;
  participants: string;
  ticket_id: number | null;
  epic_id: number | null;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingMessageRow {
  id: number;
  meeting_id: number;
  speaker: string;
  text: string;
  created_at: string;
}

const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  title: r.title,
  participants: JSON.parse(r.participants) as string[],
  ticketId: r.ticket_id,
  epicId: r.epic_id,
  status: r.status as MeetingStatus,
  summary: r.summary,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMeetingMessage = (r: MeetingMessageRow): MeetingMessage => ({
  id: r.id,
  meetingId: r.meeting_id,
  speaker: r.speaker,
  text: r.text,
  createdAt: r.created_at,
});

interface TicketDraftMessageRow {
  id: number;
  ticket_id: number;
  sender: string;
  text: string;
  created_at: string;
}

const toTicketDraftMessage = (r: TicketDraftMessageRow): TicketDraftMessage => ({
  id: r.id,
  ticketId: r.ticket_id,
  sender: r.sender as DraftMessageSender,
  text: r.text,
  createdAt: r.created_at,
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const INTERRUPTED_RUN_ERROR = 'interrupted: owning process gone';

export interface StoreOptions {
  ticketPrefix?: string;
  epicPrefix?: string;
}

export class Store {
  private readonly db: Database.Database;
  private readonly ticketPrefix: string;
  private readonly epicPrefix: string;

  constructor(path: string, options: StoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.ticketPrefix = options.ticketPrefix ?? 'EM';
    this.epicPrefix = options.epicPrefix ?? 'EP';
    createSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  createEpic(input: { title: string; description: string }): Epic {
    const create = this.db.transaction(() => {
      const info = this.db
        .prepare(`INSERT INTO epics (key, title, description) VALUES ('', ?, ?)`)
        .run(input.title, input.description);
      const id = Number(info.lastInsertRowid);
      this.db.prepare(`UPDATE epics SET key = ? WHERE id = ?`).run(`${this.epicPrefix}-${id}`, id);
      return id;
    });
    return this.getEpicById(create())!;
  }

  getEpicById(id: number): Epic | undefined {
    const row = this.db.prepare(`SELECT * FROM epics WHERE id = ?`).get(id) as EpicRow | undefined;
    return row ? toEpic(row) : undefined;
  }

  getEpicByKey(key: string): Epic | undefined {
    const row = this.db.prepare(`SELECT * FROM epics WHERE key = ?`).get(key) as EpicRow | undefined;
    return row ? toEpic(row) : undefined;
  }

  listEpics(): Epic[] {
    return (this.db.prepare(`SELECT * FROM epics ORDER BY id`).all() as EpicRow[]).map(toEpic);
  }

  setEpicStatus(id: number, status: EpicState): void {
    this.db.prepare(`UPDATE epics SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }

  setEpicPlan(id: number, plan: string, subtickets: PlannedSubticket[]): void {
    this.db
      .prepare(`UPDATE epics SET plan = ?, plan_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(plan, JSON.stringify(subtickets), id);
  }

  plannedSubtickets(id: number): PlannedSubticket[] | null {
    const row = this.db.prepare(`SELECT plan_json FROM epics WHERE id = ?`).get(id) as
      | { plan_json: string | null }
      | undefined;
    if (!row?.plan_json) return null;
    return JSON.parse(row.plan_json) as PlannedSubticket[];
  }

  setEpicFeedback(id: number, feedback: string | null): void {
    this.db.prepare(`UPDATE epics SET feedback = ?, updated_at = datetime('now') WHERE id = ?`).run(feedback, id);
  }

  createTicket(input: {
    title: string;
    description: string;
    epicId?: number;
    seq?: number;
    dependsOn?: number[];
    priority?: string;
    labels?: string[];
    jiraKey?: string;
  }): Ticket {
    const create = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO tickets (key, title, description, epic_id, seq, depends_on, priority, labels, jira_key) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.description,
          input.epicId ?? null,
          input.seq ?? null,
          input.dependsOn?.length ? JSON.stringify(input.dependsOn) : null,
          input.priority ?? 'medium',
          JSON.stringify(input.labels ?? []),
          input.jiraKey ?? null,
        );
      const id = Number(info.lastInsertRowid);
      this.db.prepare(`UPDATE tickets SET key = ? WHERE id = ?`).run(`${this.ticketPrefix}-${id}`, id);
      return id;
    });
    return this.getTicketById(create())!;
  }

  createDraftTicket(input: { description: string }): Ticket {
    const create = this.db.transaction(() => {
      const info = this.db
        .prepare(`INSERT INTO tickets (key, title, description, status) VALUES ('', '', ?, 'DRAFT')`)
        .run(input.description);
      const id = Number(info.lastInsertRowid);
      this.db.prepare(`UPDATE tickets SET key = ? WHERE id = ?`).run(`${this.ticketPrefix}-${id}`, id);
      return id;
    });
    return this.getTicketById(create())!;
  }

  getTicketById(id: number): Ticket | undefined {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as TicketRow | undefined;
    return row ? toTicket(row) : undefined;
  }

  getTicketByJiraKey(jiraKey: string): Ticket | undefined {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE jira_key = ?`).get(jiraKey) as TicketRow | undefined;
    return row ? toTicket(row) : undefined;
  }

  getTicketByKey(key: string): Ticket | undefined {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE key = ?`).get(key) as TicketRow | undefined;
    return row ? toTicket(row) : undefined;
  }

  listTickets(): Ticket[] {
    return (this.db.prepare(`SELECT * FROM tickets ORDER BY id`).all() as TicketRow[]).map(toTicket);
  }

  getSubtickets(epicId: number): Ticket[] {
    return (
      this.db.prepare(`SELECT * FROM tickets WHERE epic_id = ? ORDER BY seq, id`).all(epicId) as TicketRow[]
    ).map(toTicket);
  }

  ticketsInStatuses(statuses: TicketState[]): Ticket[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE status IN (${placeholders}) ORDER BY id`)
      .all(...statuses) as TicketRow[];
    return rows.map(toTicket);
  }

  setTitle(id: number, title: string): void {
    this.db.prepare(`UPDATE tickets SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, id);
  }

  setDescription(id: number, description: string): void {
    this.db
      .prepare(`UPDATE tickets SET description = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(description, id);
  }

  setWorktree(id: number, branch: string, baseSha: string): void {
    this.db
      .prepare(`UPDATE tickets SET branch = ?, base_sha = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(branch, baseSha, id);
  }

  setMergedSha(id: number, sha: string): void {
    this.db.prepare(`UPDATE tickets SET merged_sha = ?, updated_at = datetime('now') WHERE id = ?`).run(sha, id);
  }

  setUiInfo(id: number, hasUi: boolean, runCommand: string | null, appUrl: string | null): void {
    this.db
      .prepare(
        `UPDATE tickets SET has_ui = ?, run_command = ?, app_url = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(hasUi ? 1 : 0, runCommand, appUrl, id);
  }

  setFeedback(id: number, feedback: string | null): void {
    this.db.prepare(`UPDATE tickets SET feedback = ?, updated_at = datetime('now') WHERE id = ?`).run(feedback, id);
  }

  resetAttempt(id: number): void {
    this.db.prepare(`UPDATE tickets SET attempt = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  setPriority(id: number, priority: string): void {
    this.db.prepare(`UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?`).run(priority, id);
  }

  setLabels(id: number, labels: string[]): void {
    this.db
      .prepare(`UPDATE tickets SET labels = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(labels), id);
  }

  listLabels(): string[] {
    const rows = this.db.prepare(`SELECT labels FROM tickets`).all() as { labels: string }[];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const label of JSON.parse(row.labels) as string[]) seen.add(label);
    }
    return [...seen].sort();
  }

  addTicketRelation(ticketId: number, otherTicketId: number, relationType: TicketRelationType): TicketRelation {
    const info = this.db
      .prepare(`INSERT INTO ticket_relations (ticket_id, other_ticket_id, relation_type) VALUES (?, ?, ?)`)
      .run(ticketId, otherTicketId, relationType);
    const row = this.db
      .prepare(`SELECT * FROM ticket_relations WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as TicketRelationRow;
    return toTicketRelation(row);
  }

  getTicketRelations(ticketId: number): TicketRelation[] {
    const rows = this.db
      .prepare(`SELECT * FROM ticket_relations WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as TicketRelationRow[];
    return rows.map(toTicketRelation);
  }

  deleteTicketRelation(ticketId: number, relationId: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM ticket_relations WHERE id = ? AND ticket_id = ?`)
      .run(relationId, ticketId);
    return info.changes > 0;
  }

  openBlockersFor(ticketId: number): Ticket[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM ticket_relations r JOIN tickets t ON t.id = r.ticket_id
         WHERE r.other_ticket_id = ? AND r.relation_type = 'blocks' AND t.status != 'DONE'
         ORDER BY r.id`,
      )
      .all(ticketId) as TicketRow[];
    return rows.map(toTicket);
  }

  setCriteria(ticketId: number, items: { text: string; isUi: boolean }[]): void {
    const replace = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM acceptance_criteria WHERE ticket_id = ?`).run(ticketId);
      const ins = this.db.prepare(
        `INSERT INTO acceptance_criteria (ticket_id, idx, text, is_ui) VALUES (?, ?, ?, ?)`,
      );
      items.forEach((it, i) => ins.run(ticketId, i + 1, it.text, it.isUi ? 1 : 0));
    });
    replace();
  }

  getCriteria(ticketId: number): AcceptanceCriterion[] {
    const rows = this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE ticket_id = ? ORDER BY idx`)
      .all(ticketId) as CriterionRow[];
    return rows.map(toCriterion);
  }

  setCriteriaResults(ticketId: number, results: { idx: number; met: boolean }[]): void {
    const apply = this.db.transaction(() => {
      const upd = this.db.prepare(
        `UPDATE acceptance_criteria SET met = ? WHERE ticket_id = ? AND idx = ?`,
      );
      for (const r of results) upd.run(r.met ? 1 : 0, ticketId, r.idx);
    });
    apply();
  }

  addArtifact(
    ticketId: number,
    kind: ArtifactKind,
    role: ArtifactAuthor,
    content: string,
    data?: unknown,
  ): Artifact {
    const { v } = this.db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE ticket_id = ? AND kind = ?`)
      .get(ticketId, kind) as { v: number };
    const info = this.db
      .prepare(`INSERT INTO artifacts (ticket_id, kind, version, role, content, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(ticketId, kind, v + 1, role, content, data === undefined ? null : JSON.stringify(data));
    const row = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(Number(info.lastInsertRowid)) as ArtifactRow;
    return toArtifact(row);
  }

  latestArtifact(ticketId: number, kind: ArtifactKind): Artifact | undefined {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE ticket_id = ? AND kind = ? ORDER BY version DESC LIMIT 1`)
      .get(ticketId, kind) as ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }

  getArtifacts(ticketId: number): Artifact[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  transition(p: {
    ticketId: number;
    from: TicketState;
    to: TicketState;
    role: string | null;
    verdict: Verdict | null;
    note: string | null;
    gate?: string | null;
  }): void {
    const move = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tickets SET status = ?, attempt = attempt + ?, gate = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(p.to, isRework(p.to) ? 1 : 0, p.gate ?? null, p.ticketId);
      this.db
        .prepare(
          `INSERT INTO transitions (ticket_id, from_state, to_state, role, verdict, note) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(p.ticketId, p.from, p.to, p.role, p.verdict, p.note);
    });
    move();
  }

  blockedFrom(ticketId: number): { from: TicketState; role: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT from_state, role FROM transitions WHERE ticket_id = ? AND to_state = 'BLOCKED' ORDER BY id DESC LIMIT 1`,
      )
      .get(ticketId) as { from_state: string; role: string | null } | undefined;
    return row ? { from: row.from_state as TicketState, role: row.role } : null;
  }

  listTransitions(ticketId: number): Transition[] {
    const rows = this.db
      .prepare(`SELECT * FROM transitions WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as TransitionRow[];
    return rows.map(toTransition);
  }

  startRun(target: string): Run | null {
    const insert = (): Run | null => {
      try {
        const info = this.db.prepare(`INSERT INTO runs (target, pid) VALUES (?, ?)`).run(target, process.pid);
        return this.getRun(Number(info.lastInsertRowid));
      } catch (err) {
        if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return null;
        throw err;
      }
    };
    const first = insert();
    if (first) return first;
    const active = this.activeRun(target);
    if (active && !pidAlive(active.pid)) {
      this.db
        .prepare(`UPDATE runs SET status = 'ERROR', error = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(INTERRUPTED_RUN_ERROR, active.id);
      return insert();
    }
    return null;
  }

  sweepDeadRuns(): string[] {
    const active = this.db.prepare(`SELECT id, pid, target FROM runs WHERE status = 'RUNNING'`).all() as Array<{
      id: number;
      pid: number;
      target: string;
    }>;
    const reap = this.db.prepare(
      `UPDATE runs SET status = 'ERROR', error = ?, finished_at = datetime('now') WHERE id = ?`,
    );
    const reaped: string[] = [];
    for (const r of active) {
      if (pidAlive(r.pid)) continue;
      reap.run(INTERRUPTED_RUN_ERROR, r.id);
      reaped.push(r.target);
    }
    return reaped;
  }

  interruptedTargets(): string[] {
    const rows = this.db
      .prepare(
        `SELECT target FROM runs r1
         WHERE status = 'ERROR' AND error = ?
           AND id = (SELECT MAX(id) FROM runs r2 WHERE r2.target = r1.target)
         ORDER BY target`,
      )
      .all(INTERRUPTED_RUN_ERROR) as Array<{ target: string }>;
    return rows.map((r) => r.target);
  }

  finishRun(id: number, status: Exclude<RunStatus, 'RUNNING'>, error?: string): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`)
      .run(status, error ?? null, id);
  }

  requestCancel(target: string): boolean {
    const info = this.db
      .prepare(`UPDATE runs SET cancel_requested = 1 WHERE target = ? AND status = 'RUNNING'`)
      .run(target);
    return info.changes > 0;
  }

  isCancelRequested(id: number): boolean {
    const row = this.db.prepare(`SELECT cancel_requested FROM runs WHERE id = ?`).get(id) as
      | { cancel_requested: number }
      | undefined;
    return row?.cancel_requested === 1;
  }

  getRun(id: number): Run | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  activeRun(target: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE target = ? AND status = 'RUNNING'`)
      .get(target) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  latestRun(target: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE target = ? ORDER BY id DESC LIMIT 1`)
      .get(target) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  revision(): string {
    const r = this.db
      .prepare(
        `SELECT
          (SELECT COALESCE(MAX(id), 0) FROM transitions) AS t,
          (SELECT COALESCE(MAX(id), 0) FROM run_logs) AS l,
          (SELECT COUNT(*) FROM tickets) AS tc,
          (SELECT COUNT(*) FROM epics) AS ec,
          (SELECT COUNT(*) FROM runs WHERE status != 'RUNNING') AS rf,
          (SELECT COALESCE(MAX(updated_at), '') FROM epics) AS eu`,
      )
      .get() as { t: number; l: number; tc: number; ec: number; rf: number; eu: string };
    return `${r.t}.${r.l}.${r.tc}.${r.ec}.${r.rf}.${r.eu}`;
  }

  appendRunLog(runId: number, line: string): void {
    this.db.prepare(`INSERT INTO run_logs (run_id, line) VALUES (?, ?)`).run(runId, line);
  }

  getRunLogs(runId: number, afterId = 0): RunLogLine[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id`)
      .all(runId, afterId) as RunLogRow[];
    return rows.map(toRunLog);
  }

  recordAgentRun(rec: {
    ticketId?: number;
    epicId?: number;
    role: string;
    runner?: string;
    model?: string;
    status: 'OK' | 'ERROR';
    costUsd: number;
    numTurns: number;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (ticket_id, epic_id, role, runner, model, status, cost_usd, num_turns, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.ticketId ?? null,
        rec.epicId ?? null,
        rec.role,
        rec.runner ?? null,
        rec.model ?? null,
        rec.status,
        rec.costUsd,
        rec.numTurns,
        rec.durationMs,
        rec.inputTokens ?? null,
        rec.outputTokens ?? null,
        rec.cacheReadTokens ?? null,
        rec.cacheWriteTokens ?? null,
        rec.error ?? null,
      );
  }

  agentRunsForTicket(ticketId: number): AgentRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as AgentRunRow[];
    return rows.map(toAgentRun);
  }

  agentRunsForEpic(epicId: number): AgentRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs WHERE epic_id = ? ORDER BY id`)
      .all(epicId) as AgentRunRow[];
    return rows.map(toAgentRun);
  }

  ticketAgentTimeMs(ticketId: number): number {
    const { t } = this.db
      .prepare(`SELECT COALESCE(SUM(duration_ms), 0) AS t FROM agent_runs WHERE ticket_id = ?`)
      .get(ticketId) as { t: number };
    return t;
  }

  epicAgentTimeMs(epicId: number): number {
    const { t } = this.db
      .prepare(
        `SELECT COALESCE(SUM(duration_ms), 0) AS t FROM agent_runs
         WHERE epic_id = ? OR ticket_id IN (SELECT id FROM tickets WHERE epic_id = ?)`,
      )
      .get(epicId, epicId) as { t: number };
    return t;
  }

  createMeeting(input: { title: string; participants: string[]; ticketId?: number | null; epicId?: number | null }): Meeting {
    const info = this.db
      .prepare(`INSERT INTO meetings (title, participants, ticket_id, epic_id) VALUES (?, ?, ?, ?)`)
      .run(input.title, JSON.stringify(input.participants), input.ticketId ?? null, input.epicId ?? null);
    return this.getMeeting(Number(info.lastInsertRowid))!;
  }

  getMeeting(id: number): Meeting | undefined {
    const row = this.db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as MeetingRow | undefined;
    return row ? toMeeting(row) : undefined;
  }

  listMeetings(): Meeting[] {
    return (this.db.prepare(`SELECT * FROM meetings ORDER BY id DESC`).all() as MeetingRow[]).map(toMeeting);
  }

  addMeetingMessage(meetingId: number, speaker: string, text: string): MeetingMessage {
    const info = this.db
      .prepare(`INSERT INTO meeting_messages (meeting_id, speaker, text) VALUES (?, ?, ?)`)
      .run(meetingId, speaker, text);
    this.db.prepare(`UPDATE meetings SET updated_at = datetime('now') WHERE id = ?`).run(meetingId);
    const row = this.db
      .prepare(`SELECT * FROM meeting_messages WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as MeetingMessageRow;
    return toMeetingMessage(row);
  }

  meetingMessages(meetingId: number): MeetingMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY id`)
      .all(meetingId) as MeetingMessageRow[];
    return rows.map(toMeetingMessage);
  }

  endMeeting(id: number, summary: string): void {
    this.db
      .prepare(`UPDATE meetings SET status = 'ENDED', summary = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(summary, id);
  }

  addDraftMessage(ticketId: number, sender: DraftMessageSender, text: string): TicketDraftMessage {
    const info = this.db
      .prepare(`INSERT INTO ticket_draft_messages (ticket_id, sender, text) VALUES (?, ?, ?)`)
      .run(ticketId, sender, text);
    const row = this.db
      .prepare(`SELECT * FROM ticket_draft_messages WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as TicketDraftMessageRow;
    return toTicketDraftMessage(row);
  }

  draftMessages(ticketId: number): TicketDraftMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM ticket_draft_messages WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as TicketDraftMessageRow[];
    return rows.map(toTicketDraftMessage);
  }

  acquireSlot(kind: string, limit: number): number | null {
    const attempt = this.db.transaction(() => {
      const stale = this.db.prepare(`SELECT id, pid FROM agent_slots WHERE kind = ?`).all(kind) as Array<{
        id: number;
        pid: number;
      }>;
      for (const row of stale) {
        if (!pidAlive(row.pid)) this.db.prepare(`DELETE FROM agent_slots WHERE id = ?`).run(row.id);
      }
      const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_slots WHERE kind = ?`).get(kind) as { n: number };
      if (n >= limit) return null;
      const info = this.db.prepare(`INSERT INTO agent_slots (pid, kind) VALUES (?, ?)`).run(process.pid, kind);
      return Number(info.lastInsertRowid);
    });
    return attempt();
  }

  releaseSlot(id: number): void {
    this.db.prepare(`DELETE FROM agent_slots WHERE id = ?`).run(id);
  }

  buildReport(windowDays: number | null, monthlyBudgetUsd: number | null = null): Report {
    const { m } = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS m FROM agent_runs WHERE created_at >= strftime('%Y-%m-01 00:00:00', 'now')`,
      )
      .get() as { m: number };
    const month = { spentUsd: m, budgetUsd: monthlyBudgetUsd };
    const lifetimeRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(
                  COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) +
                  COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)
                ), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS usd,
                COUNT(*) AS runs
         FROM agent_runs`,
      )
      .get() as { tokens: number; usd: number; runs: number };
    const lifetime = { totalTokens: lifetimeRow.tokens, runs: lifetimeRow.runs, totalUsd: lifetimeRow.usd };
    const since = windowDays === null ? null : `-${windowDays} days`;
    const bucketFormat = windowDays !== null && windowDays <= 31 ? '%Y-%m-%d' : '%Y-W%W';
    const doneWhere = since === null ? '' : `AND d.done_at >= datetime('now', ?)`;
    const doneParams = since === null ? [bucketFormat] : [bucketFormat, since];

    // One row per DONE ticket, stamped with its completion time.
    const doneRows = this.db
      .prepare(
        `WITH d AS (
           SELECT t.id, t.attempt, t.created_at, MAX(tr.created_at) AS done_at
           FROM tickets t JOIN transitions tr ON tr.ticket_id = t.id AND tr.to_state = 'DONE'
           WHERE t.status = 'DONE'
           GROUP BY t.id
         )
         SELECT d.id, d.attempt, d.done_at, strftime(?, d.done_at) AS bucket,
                CAST((julianday(d.done_at) - julianday(d.created_at)) * 86400000 AS INTEGER) AS lead_ms,
                NOT EXISTS (
                  SELECT 1 FROM transitions r WHERE r.ticket_id = d.id AND r.to_state = 'IN_PROGRESS'
                ) AS first_pass
         FROM d WHERE 1=1 ${doneWhere}`,
      )
      .all(...doneParams) as Array<{
      id: number;
      attempt: number;
      done_at: string;
      bucket: string;
      lead_ms: number;
      first_pass: number;
    }>;

    const throughputMap = new Map<string, number>();
    for (const row of doneRows) {
      throughputMap.set(row.bucket, (throughputMap.get(row.bucket) ?? 0) + 1);
    }

    const statusCounts = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const blocked = statusCounts.find((s) => s.status === 'BLOCKED')?.n ?? 0;
    const doneTotal = statusCounts.find((s) => s.status === 'DONE')?.n ?? 0;
    const open = statusCounts.reduce((sum, s) => sum + s.n, 0) - blocked - doneTotal;

    const trWhere = since === null ? '' : `AND created_at >= datetime('now', ?)`;
    const trParams = since === null ? [] : [since];
    const gateRow = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN role = 'reviewer' AND verdict = 'FAIL' THEN 1 ELSE 0 END) AS review_fails,
           SUM(CASE WHEN role = 'uat' AND verdict = 'FAIL' THEN 1 ELSE 0 END) AS uat_fails,
           SUM(CASE WHEN role IS NULL AND verdict = 'FAIL' THEN 1 ELSE 0 END) AS human_rejections,
           SUM(CASE WHEN note LIKE 'auto-approved%' THEN 1 ELSE 0 END) AS auto_approvals
         FROM transitions WHERE 1=1 ${trWhere}`,
      )
      .get(...trParams) as {
      review_fails: number | null;
      uat_fails: number | null;
      human_rejections: number | null;
      auto_approvals: number | null;
    };

    const runWhere = since === null ? '' : `AND created_at >= datetime('now', ?)`;
    const runParams = since === null ? [] : [since];
    const spendTotals = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS usd,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
                COALESCE(SUM(duration_ms), 0) AS agent_ms,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors
         FROM agent_runs WHERE 1=1 ${runWhere}`,
      )
      .get(...runParams) as {
      usd: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      agent_ms: number;
      total: number;
      errors: number | null;
    };

    const keyed = (column: string): KeyedUsd[] =>
      (
        this.db
          .prepare(
            `SELECT COALESCE(${column}, '(unknown)') AS key, SUM(cost_usd) AS usd
             FROM agent_runs WHERE 1=1 ${runWhere} GROUP BY COALESCE(${column}, '(unknown)') ORDER BY usd DESC`,
          )
          .all(...runParams) as KeyedUsd[]
      ).filter((row) => row.usd > 0);

    const runsByRole = this.db
      .prepare(
        `SELECT role, COUNT(*) AS runs,
                SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors,
                CAST(AVG(duration_ms) AS INTEGER) AS avgDurationMs
         FROM agent_runs WHERE 1=1 ${runWhere} GROUP BY role ORDER BY runs DESC`,
      )
      .all(...runParams) as Array<{ role: string; runs: number; errors: number | null; avgDurationMs: number }>;

    const tokensByRole = (
      this.db
        .prepare(
          `SELECT role,
                  COALESCE(SUM(input_tokens), 0) AS inputTokens,
                  COALESCE(SUM(output_tokens), 0) AS outputTokens,
                  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
           FROM agent_runs WHERE 1=1 ${runWhere} GROUP BY role ORDER BY role`,
        )
        .all(...runParams) as RoleTokenStats[]
    ).filter((row) => row.inputTokens > 0 || row.outputTokens > 0 || row.cacheReadTokens > 0 || row.cacheWriteTokens > 0);

    const leadMs = doneRows.map((r) => r.lead_ms).filter((v) => v >= 0);
    const firstPass = doneRows.filter((r) => r.first_pass === 1).length;
    const avgAttempts =
      doneRows.length === 0 ? null : doneRows.reduce((sum, r) => sum + r.attempt, 0) / doneRows.length;

    return {
      windowDays,
      lifetime,
      tickets: {
        done: doneRows.length,
        open,
        blocked,
        firstPass,
        avgAttempts,
        leadTime: leadTimeStats(leadMs),
        agentTimeMs: spendTotals.agent_ms,
      },
      throughput: [...throughputMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, done]) => ({ bucket, done })),
      gates: {
        reviewFails: gateRow.review_fails ?? 0,
        uatFails: gateRow.uat_fails ?? 0,
        humanRejections: gateRow.human_rejections ?? 0,
        autoApprovals: gateRow.auto_approvals ?? 0,
      },
      spend: {
        totalUsd: spendTotals.usd,
        perDoneTicketUsd: doneRows.length === 0 ? null : spendTotals.usd / doneRows.length,
        byRole: keyed('role'),
        byRunner: keyed('runner'),
        byModel: keyed('model'),
        inputTokens: spendTotals.input,
        outputTokens: spendTotals.output,
        cacheReadTokens: spendTotals.cache_read,
        cacheWriteTokens: spendTotals.cache_write,
        tokensByRole,
      },
      runs: {
        total: spendTotals.total,
        errors: spendTotals.errors ?? 0,
        byRole: runsByRole.map((r) => ({ ...r, errors: r.errors ?? 0 })),
      },
      month,
    };
  }

  ticketCostUsd(ticketId: number): number {
    const { c } = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs WHERE ticket_id = ?`)
      .get(ticketId) as { c: number };
    return c;
  }

  epicCostUsd(epicId: number): number {
    const { c } = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs
         WHERE epic_id = ? OR ticket_id IN (SELECT id FROM tickets WHERE epic_id = ?)`,
      )
      .get(epicId, epicId) as { c: number };
    return c;
  }

  totalCostUsd(): number {
    const { c } = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs`)
      .get() as { c: number };
    return c;
  }
}
