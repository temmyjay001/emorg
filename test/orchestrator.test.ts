import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentIdleTimeoutError } from '../src/agents/runner';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import type { Ticket } from '../src/domain/types';
import { createWorktree, worktreePath } from '../src/git/worktree';
import { stepOnce } from '../src/orchestrator/orchestrator';
import { initProject } from '../src/project';

const { runDeveloper, runReviewer } = vi.hoisted(() => ({ runDeveloper: vi.fn(), runReviewer: vi.fn() }));

vi.mock('../src/agents', async () => {
  const actual = await vi.importActual<typeof import('../src/agents')>('../src/agents');
  return { ...actual, RUNNERS: { ...actual.RUNNERS, developer: runDeveloper, reviewer: runReviewer } };
});

let dir: string;
let ctx: Ctx;
let store: Store;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitFile(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

function readyTicket(): Ticket {
  const t = store.createTicket({ title: 'idle watchdog rework', description: 'test' });
  const wt = createWorktree(ctx.project, t.key);
  store.setWorktree(t.id, wt.branch, wt.baseSha);
  store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'READY', role: 'pm', verdict: 'PASS', note: 'test' });
  return store.getTicketById(t.id)!;
}

function inReviewTicket(priorFailedAttempts = 0): Ticket {
  const ready = readyTicket();
  commitFile(worktreePath(ctx.project, ready.key), 'feature.txt', 'work\n', `${ready.key}: work`);
  let from: Ticket['status'] = 'READY';
  for (let i = 0; i < priorFailedAttempts; i++) {
    store.transition({ ticketId: ready.id, from, to: 'IN_PROGRESS', role: 'reviewer', verdict: 'FAIL', note: 'seed attempt' });
    store.transition({ ticketId: ready.id, from: 'IN_PROGRESS', to: 'IN_REVIEW', role: 'developer', verdict: 'PASS', note: 'seed', gate: 'reviewer' });
    from = 'IN_REVIEW';
  }
  if (priorFailedAttempts === 0) {
    store.transition({ ticketId: ready.id, from, to: 'IN_REVIEW', role: 'developer', verdict: 'PASS', note: 'test', gate: 'reviewer' });
  }
  return store.getTicketById(ready.id)!;
}

beforeEach(() => {
  runDeveloper.mockReset();
  runReviewer.mockReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-orchestrator-')));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'em@test']);
  git(dir, ['config', 'user.name', 'em']);
  commitFile(dir, 'README.md', 'hello\n', 'initial');
  const project = initProject(dir).project;
  store = new Store(project.dbPath);
  ctx = { store, project };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('stepOnce idle-timeout handling', () => {
  it('treats a repeated AgentIdleTimeoutError like a gate FAIL after one automatic retry: transitions back to IN_PROGRESS, increments attempt once, and notes the timeout', async () => {
    const ticket = inReviewTicket();
    runReviewer.mockRejectedValue(new AgentIdleTimeoutError(15));

    const logs: string[] = [];
    const step = await stepOnce(ctx, ticket.id, (msg) => logs.push(msg));

    expect(runReviewer).toHaveBeenCalledTimes(2);
    expect(step.moved).toBe(true);
    expect(step.done).toBe(false);
    expect(step.ticket.status).toBe('IN_PROGRESS');
    expect(step.ticket.attempt).toBe(1);
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.verdict).toBe('FAIL');
    expect(last?.note).toContain('idle timeout');
    expect(logs.some((l) => l.includes('reviewer') && l.includes('idle-timed out') && l.includes('retry'))).toBe(true);
  });

  it('blocks the ticket once max attempts are exhausted by repeated idle timeouts, after its one automatic retry', async () => {
    const ticket = inReviewTicket(1);
    ctx.project.config = { ...ctx.project.config, maxAttempts: 1 };
    runReviewer.mockRejectedValue(new AgentIdleTimeoutError(15));

    const step = await stepOnce(ctx, ticket.id);

    expect(runReviewer).toHaveBeenCalledTimes(2);
    expect(step.ticket.status).toBe('BLOCKED');
    expect(step.done).toBe(true);
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.note).toContain('idle timeout');
  });

  it('blocks the ticket once the developer role idles out twice in a row (original attempt plus its one automatic retry)', async () => {
    const ticket = readyTicket();
    runDeveloper.mockRejectedValue(new AgentIdleTimeoutError(15));

    const step = await stepOnce(ctx, ticket.id);

    expect(runDeveloper).toHaveBeenCalledTimes(2);
    expect(step.ticket.status).toBe('BLOCKED');
    const last = store.listTransitions(ticket.id).at(-1);
    expect(last?.verdict).toBe('FAIL');
    expect(last?.note).toContain('idle timeout');
  });

  it('automatically retries once and advances normally when the developer retry passes, without ever blocking or noting a failure', async () => {
    const ticket = readyTicket();
    writeFileSync(join(worktreePath(ctx.project, ticket.key), 'feature.txt'), 'work\n');
    runDeveloper.mockRejectedValueOnce(new AgentIdleTimeoutError(15));
    runDeveloper.mockResolvedValueOnce({ verdict: 'PASS', summary: 'implemented the feature' });

    const logs: string[] = [];
    const step = await stepOnce(ctx, ticket.id, (msg) => logs.push(msg));

    expect(runDeveloper).toHaveBeenCalledTimes(2);
    expect(step.ticket.status).toBe('IN_REVIEW');
    expect(logs.some((l) => l.includes('developer') && l.includes('idle-timed out') && l.includes('retry'))).toBe(true);
    const transitions = store.listTransitions(ticket.id);
    expect(transitions.some((t) => t.toState === 'BLOCKED')).toBe(false);
    const last = transitions.at(-1);
    expect(last?.verdict).toBe('PASS');
    expect(last?.note).not.toContain('idle timeout');
  });

  it('automatically retries once and advances normally when the reviewer retry passes, without consuming a maxAttempts attempt', async () => {
    const ticket = inReviewTicket();
    runReviewer.mockRejectedValueOnce(new AgentIdleTimeoutError(15));
    runReviewer.mockResolvedValueOnce({ verdict: 'PASS', summary: 'looks good' });

    const step = await stepOnce(ctx, ticket.id);

    expect(runReviewer).toHaveBeenCalledTimes(2);
    expect(step.ticket.status).not.toBe('BLOCKED');
    expect(step.ticket.attempt).toBe(0);
    const transitions = store.listTransitions(ticket.id);
    expect(transitions.some((t) => t.toState === 'BLOCKED')).toBe(false);
    const last = transitions.at(-1);
    expect(last?.verdict).toBe('PASS');
    expect(last?.note).not.toContain('idle timeout');
  });

  it('still propagates non-idle agent failures instead of swallowing them, without any automatic retry', async () => {
    const ticket = readyTicket();
    runDeveloper.mockRejectedValue(new Error('boom'));

    await expect(stepOnce(ctx, ticket.id)).rejects.toThrow('boom');
    expect(runDeveloper).toHaveBeenCalledTimes(1);
    expect(store.getTicketById(ticket.id)?.status).toBe('READY');
  });
});
