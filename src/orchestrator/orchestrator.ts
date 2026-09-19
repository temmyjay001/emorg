import { spawn } from 'node:child_process';
import { RUNNERS, type RoleRunner } from '../agents';
import { runCustomGate } from '../agents/roles/custom';
import { runPlanner } from '../agents/roles/planner';
import { AgentIdleTimeoutError } from '../agents/runner';
import type { Ctx } from '../ctx';
import type { Store } from '../db/store';
import { failTarget, isTerminal, resolveStage, unblockTarget } from '../domain/states';
import type { Epic, GateResult, Ticket, TicketState } from '../domain/types';
import { commitAll, createWorktree, diff, syncWorktreeWithBase } from '../git/worktree';
import { otelTargetFor, withRunTrace } from '../otel';
import { abortLocalRun, registerRun, unregisterRun, type RunControl } from './cancel';
import { landTicket, type LandResult } from './land';
import { readySubtickets, validateDependencies, type DepNode } from './schedule';

export type Log = (msg: string) => void;

const noop: Log = () => {};
const noControl: RunControl = { signal: new AbortController().signal, aborted: () => false };
const CANCEL_POLL_MS = 1000;

export class RunInProgressError extends Error {
  constructor(target: string) {
    super(`A run is already in progress for ${target}`);
  }
}

export class RunCancelledError extends Error {
  constructor(target: string) {
    super(`Run cancelled for ${target}`);
  }
}

export function cancelRun(store: Store, target: string): boolean {
  const requested = store.requestCancel(target);
  abortLocalRun(target);
  return requested;
}

function stayAwakeCommand(): { command: string; args: string[] } | null {
  const pid = String(process.pid);
  if (process.platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', pid] };
  if (process.platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=em', '--why=agent run active', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  }
  if (process.platform === 'win32') {
    const script =
      `Add-Type -Name P -Namespace Em -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Em.P]::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep -Seconds 30 }`;
    return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return null;
}

function stayAwake(): (() => void) | null {
  if (process.env.VITEST) return null;
  const spec = stayAwakeCommand();
  if (!spec) return null;
  try {
    const child = spawn(spec.command, spec.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
  } catch {
    return null;
  }
}

async function withRunLock<T>(
  store: Store,
  target: string,
  log: Log,
  fn: (log: Log, control: RunControl) => Promise<T>,
  parent?: RunControl,
): Promise<T> {
  const run = store.startRun(target);
  if (!run) throw new RunInProgressError(target);
  const releaseAwake = stayAwake();
  const controller = new AbortController();
  registerRun(target, controller);
  const control: RunControl = {
    signal: controller.signal,
    aborted: () => {
      if (controller.signal.aborted) return true;
      if (parent?.aborted() || store.isCancelRequested(run.id)) {
        controller.abort();
        return true;
      }
      return false;
    },
  };
  const poller = setInterval(() => {
    if (store.isCancelRequested(run.id)) controller.abort();
  }, CANCEL_POLL_MS);
  const persistedLog: Log = (msg) => {
    store.appendRunLog(run.id, msg);
    log(msg);
  };
  try {
    const result = await fn(persistedLog, control);
    store.finishRun(run.id, control.aborted() ? 'CANCELLED' : 'OK');
    return result;
  } catch (err) {
    if (control.aborted() || err instanceof RunCancelledError) {
      store.finishRun(run.id, 'CANCELLED', 'cancelled by request');
    } else {
      store.finishRun(run.id, 'ERROR', (err as Error).message);
    }
    throw err;
  } finally {
    clearInterval(poller);
    unregisterRun(target);
    releaseAwake?.();
  }
}

export function performUnblock(ctx: Ctx, ticket: Ticket, guidance: string): TicketState {
  const { store, project } = ctx;
  store.addArtifact(ticket.id, 'GUIDANCE', 'human', guidance);
  store.resetAttempt(ticket.id);
  const to = unblockTarget(project.config.pipeline, store.blockedFrom(ticket.id), ticket.branch !== null);
  store.transition({ ticketId: ticket.id, from: 'BLOCKED', to, role: null, verdict: null, note: `unblocked: ${guidance}` });
  return to;
}

export interface StepResult {
  moved: boolean;
  done: boolean;
  awaitingHuman: boolean;
  ticket: Ticket;
  message: string;
}

export async function stepOnce(
  ctx: Ctx,
  ticketId: number,
  log: Log = noop,
  control: RunControl = noControl,
): Promise<StepResult> {
  const { store, project } = ctx;
  let ticket = store.getTicketById(ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const stage = resolveStage(project.config.pipeline, ticket);
  if (!stage) {
    return { moved: false, done: true, awaitingHuman: false, ticket, message: `${ticket.key} is ${ticket.status}` };
  }
  if (stage.kind === 'skip') {
    store.transition({
      ticketId: ticket.id,
      from: ticket.status,
      to: stage.to,
      role: null,
      verdict: 'PASS',
      note: `stage skipped: ${stage.note}`,
      gate: stage.gate,
    });
    const skipped = store.getTicketById(ticketId)!;
    log(`${ticket.key} ${ticket.status} -> ${stage.to} [skipped: ${stage.note}]`);
    return { moved: true, done: isTerminal(stage.to), awaitingHuman: false, ticket: skipped, message: `-> ${stage.to}` };
  }
  if (stage.kind === 'land') {
    const landed = await landTicket(ctx, ticketId, log, control);
    const after = store.getTicketById(ticketId)!;
    return { moved: landed.moved, done: after.status === 'DONE', awaitingHuman: false, ticket: after, message: landed.message };
  }
  if (stage.kind === 'human') {
    const mode = project.config.approvalMode;
    const autoApprove = mode === 'never' || (mode === 'epic-once' && ticket.epicId !== null);
    if (autoApprove) {
      store.transition({
        ticketId: ticket.id,
        from: ticket.status,
        to: stage.onApprove,
        role: null,
        verdict: 'PASS',
        note: `auto-approved (approvalMode: ${mode})`,
      });
      const approved = store.getTicketById(ticketId)!;
      log(`${ticket.key} ${ticket.status} -> ${stage.onApprove} [auto-approved, approvalMode: ${mode}]`);
      return { moved: true, done: false, awaitingHuman: false, ticket: approved, message: `-> ${stage.onApprove}` };
    }
    return {
      moved: false,
      done: false,
      awaitingHuman: true,
      ticket,
      message: `${ticket.key} awaits approval (em approve ${ticket.key})`,
    };
  }

  const budget = project.config.maxTicketBudgetUsd;
  if (budget !== null) {
    const spent = store.ticketCostUsd(ticket.id);
    if (spent >= budget) {
      const note = `budget exceeded: $${spent.toFixed(2)} spent of a $${budget.toFixed(2)} cap; raise maxTicketBudgetUsd and unblock to continue`;
      store.transition({ ticketId: ticket.id, from: ticket.status, to: 'BLOCKED', role: null, verdict: 'FAIL', note });
      const blocked = store.getTicketById(ticketId)!;
      log(`${ticket.key} ${ticket.status} -> BLOCKED [${note}]`);
      return { moved: true, done: true, awaitingHuman: false, ticket: blocked, message: `-> BLOCKED (budget)` };
    }
  }

  if (stage.role !== 'pm' && !ticket.branch) {
    const wt = createWorktree(project, ticket.key);
    store.setWorktree(ticket.id, wt.branch, wt.baseSha);
    ticket = store.getTicketById(ticketId)!;
    log(`${ticket.key} worktree ${wt.branch}`);
  }

  if (stage.role === 'developer' && ticket.branch && ticket.baseSha) {
    const sync = syncWorktreeWithBase(project, ticket.key, ticket.baseSha);
    if (sync.updated) {
      store.setWorktree(ticket.id, ticket.branch, sync.baseSha);
      ticket = store.getTicketById(ticketId)!;
      log(`${ticket.key} worktree synced with base ${sync.baseSha.slice(0, 7)}`);
    } else if (sync.conflicted) {
      log(`${ticket.key} base has advanced but merging it into the worktree conflicts; continuing on the recorded base`);
    }
  }

  log(`${ticket.key} ${ticket.status}: running ${stage.role}`);
  const activity = (line: string) => log(`${ticket.key}   ${line}`);
  const builtin: RoleRunner | undefined = (RUNNERS as Record<string, RoleRunner>)[stage.role];
  const runGateOnce = (): Promise<GateResult> =>
    builtin
      ? builtin(ctx, ticket, control.signal, activity)
      : runCustomGate(ctx, ticket, stage.role, control.signal, activity);
  let result: GateResult;
  try {
    result = await runGateOnce();
  } catch (err) {
    if (!(err instanceof AgentIdleTimeoutError)) throw err;
    log(`${ticket.key} ${stage.role} idle-timed out; automatically retrying ${stage.role} once before failing`);
    try {
      result = await runGateOnce();
    } catch (retryErr) {
      if (!(retryErr instanceof AgentIdleTimeoutError)) throw retryErr;
      result = { verdict: 'FAIL', summary: retryErr.message };
    }
  }

  if (result.artifact) {
    store.addArtifact(ticket.id, result.artifact.kind, stage.role, result.artifact.content, result.artifact.data);
  }

  let verdict = result.verdict;
  let note = result.summary;

  if (stage.role === 'developer' && verdict === 'PASS' && ticket.baseSha) {
    commitAll(project, ticket.key, `${ticket.key}: ${result.summary}`.slice(0, 200));
    const d = diff(project, ticket.key, ticket.baseSha);
    store.addArtifact(ticket.id, 'DIFF', 'developer', d);
    if (d.trim() === '') {
      verdict = 'FAIL';
      note = `${result.summary} [rejected: developer produced no changes in the worktree]`;
    }
  }

  const to = verdict === 'PASS' ? stage.onPass : failTarget(stage, ticket.attempt, project.config.maxAttempts);
  store.transition({
    ticketId: ticket.id,
    from: ticket.status,
    to,
    role: stage.role,
    verdict,
    note,
    gate: verdict === 'PASS' ? stage.onPassGate : null,
  });

  const updated = store.getTicketById(ticketId)!;
  log(`${ticket.key} ${ticket.status} -> ${to} [${verdict}] ${note}`);

  return { moved: true, done: isTerminal(to), awaitingHuman: false, ticket: updated, message: `-> ${to}` };
}

async function runInner(ctx: Ctx, ticketId: number, log: Log, control: RunControl): Promise<Ticket> {
  for (;;) {
    if (control.aborted()) {
      const ticket = ctx.store.getTicketById(ticketId)!;
      log(`${ticket.key} run cancelled`);
      return ticket;
    }
    const step = await stepOnce(ctx, ticketId, log, control);
    if (step.done || step.awaitingHuman || !step.moved) return step.ticket;
  }
}

export async function run(ctx: Ctx, ticketId: number, log: Log = noop, parent?: RunControl): Promise<Ticket> {
  const ticket = ctx.store.getTicketById(ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  return withRunTrace(
    otelTargetFor(ctx.project),
    'em.run',
    { 'em.target': `ticket:${ticket.key}` },
    () =>
      withRunLock(
        ctx.store,
        `ticket:${ticket.key}`,
        log,
        (plog, control) => runInner(ctx, ticketId, plog, control),
        parent,
      ),
    (result) => ({ 'em.final_status': result?.status ?? 'unknown' }),
  );
}

export async function landRun(ctx: Ctx, ticketId: number, log: Log = noop): Promise<LandResult> {
  const ticket = ctx.store.getTicketById(ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  return withRunLock(ctx.store, `ticket:${ticket.key}`, log, (plog, control) =>
    landTicket(ctx, ticketId, plog, control),
  );
}

export async function land(ctx: Ctx, ticketId: number, log: Log = noop): Promise<LandResult> {
  const { store } = ctx;
  const ticket = store.getTicketById(ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status !== 'READY_TO_LAND' && ticket.status !== 'NEEDS_INTEGRATION') {
    return {
      status: ticket.status,
      moved: false,
      message: `${ticket.key} is ${ticket.status}; only READY_TO_LAND or NEEDS_INTEGRATION tickets can land`,
    };
  }
  if (ticket.status === 'NEEDS_INTEGRATION') {
    store.transition({
      ticketId: ticket.id,
      from: ticket.status,
      to: 'READY_TO_LAND',
      role: null,
      verdict: null,
      note: 'landing retried',
    });
  }
  return landRun(ctx, ticketId, log);
}

async function planEpicInner(ctx: Ctx, epicId: number, log: Log): Promise<Epic> {
  const { store } = ctx;
  const epic = store.getEpicById(epicId);
  if (!epic) throw new Error(`Epic ${epicId} not found`);
  if (epic.status !== 'PLANNING') {
    log(`${epic.key} is ${epic.status}, not planning`);
    return epic;
  }
  log(`${epic.key} PLANNING: running planner`);
  const res = await runPlanner(ctx, epic, (line) => log(`${epic.key}   ${line}`));
  store.setEpicPlan(epic.id, res.text, res.subtickets);
  store.setEpicFeedback(epic.id, null);
  store.setEpicStatus(epic.id, 'AWAIT_PLAN');
  log(`${epic.key} PLANNING -> AWAIT_PLAN: ${res.subtickets.length} subtickets proposed. ${res.summary}`);
  return store.getEpicById(epicId)!;
}

export async function planEpic(ctx: Ctx, epicId: number, log: Log = noop): Promise<Epic> {
  const epic = ctx.store.getEpicById(epicId);
  if (!epic) throw new Error(`Epic ${epicId} not found`);
  return withRunTrace(
    otelTargetFor(ctx.project),
    'em.plan',
    { 'em.target': `epic:${epic.key}` },
    () => withRunLock(ctx.store, `epic:${epic.key}`, log, (plog) => planEpicInner(ctx, epicId, plog)),
    (result) => ({ 'em.final_status': result?.status ?? 'unknown' }),
  );
}

export function materializeEpic(store: Store, epicId: number): Ticket[] {
  const epic = store.getEpicById(epicId);
  if (!epic) throw new Error(`Epic ${epicId} not found`);
  if (!epic.plan) throw new Error(`${epic.key} has no plan to approve`);
  if (store.getSubtickets(epic.id).length === 0) {
    const planned = store.plannedSubtickets(epic.id);
    if (!planned) {
      throw new Error(`${epic.key} has no structured plan; re-run em epic plan ${epic.key}`);
    }
    validateDependencies(planned.map((s, i) => ({ seq: i + 1, dependsOn: s.dependsOn ?? [] })));
    planned.forEach((s, i) =>
      store.createTicket({
        title: s.title,
        description: s.description,
        epicId: epic.id,
        seq: i + 1,
        dependsOn: s.dependsOn ?? [],
      }),
    );
  }
  store.setEpicStatus(epic.id, 'BUILDING');
  return store.getSubtickets(epic.id);
}

const LAUNCHABLE_STATES = new Set<TicketState>([
  'BACKLOG',
  'DESIGN',
  'READY',
  'IN_PROGRESS',
  'IN_REVIEW',
  'UAT',
  'READY_TO_LAND',
]);

export function launchableSubtickets(store: Store, subs: Ticket[], activeSeqs: Set<number>): Ticket[] {
  const done = new Set(subs.filter((s) => s.status === 'DONE' || s.status === 'CLOSED').map((s) => s.seq ?? 0));
  const nodes: DepNode[] = subs
    .filter((s) => LAUNCHABLE_STATES.has(s.status) && store.openBlockersFor(s.id).length === 0)
    .map((s) => ({ seq: s.seq ?? 0, dependsOn: s.dependsOn }));
  const ready = new Set(readySubtickets(nodes, done, activeSeqs));
  return subs.filter((s) => ready.has(s.seq ?? 0));
}

async function scheduleSubtickets(ctx: Ctx, epicId: number, log: Log, control: RunControl): Promise<void> {
  const { store } = ctx;
  const active = new Map<number, Promise<number>>();

  const launch = (sub: Ticket) => {
    const seq = sub.seq ?? 0;
    active.set(
      seq,
      run(ctx, sub.id, log, control)
        .catch(() => undefined)
        .then(() => seq),
    );
  };

  const parallelism = ctx.project.config.maxParallelSubtickets;
  for (;;) {
    if (!control.aborted()) {
      const candidates = launchableSubtickets(store, store.getSubtickets(epicId), new Set(active.keys()));
      for (const sub of candidates) {
        if (active.size >= parallelism) break;
        launch(sub);
      }
    }
    if (active.size === 0) break;
    active.delete(await Promise.race(active.values()));
  }

  const awaiting = store.getSubtickets(epicId).filter((s) => s.status === 'AWAIT_APPROVAL');
  if (awaiting.length > 0 && !control.aborted()) {
    log(`${awaiting.length} subticket(s) await approval: ${awaiting.map((s) => s.key).join(', ')}`);
  }
}

export function refreshEpicStatus(store: Store, epicId: number, log: Log = noop): void {
  const epic = store.getEpicById(epicId);
  if (epic?.status !== 'BUILDING') return;
  const subs = store.getSubtickets(epic.id);
  if (subs.length > 0 && subs.every((t) => t.status === 'DONE' || t.status === 'CLOSED')) {
    store.setEpicStatus(epic.id, 'DONE');
    log(`${epic.key} -> DONE (all ${subs.length} subtickets complete)`);
  }
}

export async function runEpic(ctx: Ctx, epicId: number, log: Log = noop): Promise<Epic> {
  const { store } = ctx;
  const epic = store.getEpicById(epicId);
  if (!epic) throw new Error(`Epic ${epicId} not found`);
  return withRunTrace(
    otelTargetFor(ctx.project),
    'em.epic',
    { 'em.target': `epic:${epic.key}` },
    () => runEpicInner(ctx, epicId, log),
    (result) => ({ 'em.final_status': result?.status ?? 'unknown' }),
  );
}

async function runEpicInner(ctx: Ctx, epicId: number, log: Log): Promise<Epic> {
  const { store } = ctx;
  const epic = store.getEpicById(epicId)!;
  return withRunLock(store, `epic:${epic.key}`, log, async (plog, control) => {
    let current = store.getEpicById(epicId)!;
    if (current.status === 'PLANNING') {
      current = await planEpicInner(ctx, epicId, plog);
      if (current.status !== 'AWAIT_PLAN' || ctx.project.config.approvalMode !== 'never') return current;
    }
    if (current.status === 'AWAIT_PLAN') {
      if (ctx.project.config.approvalMode !== 'never') {
        plog(`${current.key} awaits plan approval (em epic approve ${current.key})`);
        return current;
      }
      const subs = materializeEpic(store, current.id);
      plog(`${current.key} plan auto-approved (approvalMode: never); ${subs.length} subtickets created`);
      current = store.getEpicById(epicId)!;
    }
    if (current.status !== 'BUILDING') {
      plog(`${current.key} is ${current.status}`);
      return current;
    }
    await scheduleSubtickets(ctx, current.id, plog, control);
    refreshEpicStatus(store, epicId, plog);
    return store.getEpicById(epicId)!;
  });
}
