import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import type { Ticket } from '../src/domain/types';
import { createWorktree, worktreePath } from '../src/git/worktree';
import { landTicket } from '../src/orchestrator/land';
import { land } from '../src/orchestrator/orchestrator';
import { initProject } from '../src/project';

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

function readyTicket(name: string, content: string): Ticket {
  const t = store.createTicket({ title: `Ship ${name}`, description: 'land test' });
  const wt = createWorktree(ctx.project, t.key);
  store.setWorktree(t.id, wt.branch, wt.baseSha);
  commitFile(worktreePath(ctx.project, t.key), name, content, `${t.key}: work`);
  store.transition({ ticketId: t.id, from: 'BACKLOG', to: 'READY_TO_LAND', role: null, verdict: 'PASS', note: 'test' });
  return store.getTicketById(t.id)!;
}

beforeEach(() => {
  delete process.env.EM_TARGET_REPO;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-land-')));
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

describe('landTicket', () => {
  it('lands a clean ticket: DONE, squash commit on main, worktree removed', async () => {
    const t = readyTicket('feature.txt', 'done\n');
    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('DONE');
    const after = store.getTicketById(t.id)!;
    expect(after.status).toBe('DONE');
    expect(after.mergedSha).toBe(git(dir, ['rev-parse', 'main']));
    expect(git(dir, ['log', '--format=%s', '-1', 'main'])).toBe(`${t.key}: Ship feature.txt`);
    expect(git(dir, ['show', 'main:feature.txt'])).toBe('done');
    expect(existsSync(worktreePath(ctx.project, t.key))).toBe(false);
    expect(git(dir, ['for-each-ref', 'refs/em/pending'])).toBe('');
  });

  it('lands sequential tickets on top of each other', async () => {
    const a = readyTicket('a.txt', 'a\n');
    const b = readyTicket('b.txt', 'b\n');
    await landTicket(ctx, a.id);
    const res = await landTicket(ctx, b.id);

    expect(res.status).toBe('DONE');
    expect(git(dir, ['show', 'main:a.txt'])).toBe('a');
    expect(git(dir, ['show', 'main:b.txt'])).toBe('b');
    expect(git(dir, ['log', '--format=%s', 'main']).split('\n')).toHaveLength(3);
  });

  it('parks a conflicting ticket as NEEDS_INTEGRATION and leaves main untouched', async () => {
    const t = readyTicket('README.md', 'ticket version\n');
    commitFile(dir, 'README.md', 'base version\n', 'conflicting base change');
    const mainBefore = git(dir, ['rev-parse', 'main']);

    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('NEEDS_INTEGRATION');
    expect(store.getTicketById(t.id)!.status).toBe('NEEDS_INTEGRATION');
    expect(git(dir, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(existsSync(worktreePath(ctx.project, t.key))).toBe(true);
  });

  it('parks a ticket whose merged tree fails verification, with the output as an artifact', async () => {
    ctx.project.config.verifyCommand = 'test ! -f feature.txt || { echo "feature.txt is forbidden"; exit 1; }';
    const t = readyTicket('feature.txt', 'done\n');

    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('NEEDS_INTEGRATION');
    const verify = store.getArtifacts(t.id).find((a) => a.kind === 'VERIFY');
    expect(verify?.content).toContain('feature.txt is forbidden');
  });

  it('stays READY_TO_LAND when the checkout is dirty', async () => {
    const t = readyTicket('feature.txt', 'done\n');
    writeFileSync(join(dir, 'README.md'), 'uncommitted\n');

    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('READY_TO_LAND');
    expect(res.moved).toBe(false);
    expect(store.getTicketById(t.id)!.status).toBe('READY_TO_LAND');
  });

  it('re-verifies against the advanced base before landing', async () => {
    const t = readyTicket('feature.txt', 'done\n');
    commitFile(dir, 'sibling.txt', 'landed first\n', 'sibling lands');

    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('DONE');
    expect(git(dir, ['show', 'main:sibling.txt'])).toBe('landed first');
    expect(git(dir, ['show', 'main:feature.txt'])).toBe('done');
  });

  it('respects mergeStrategy none', async () => {
    ctx.project.config.mergeStrategy = 'none';
    const t = readyTicket('feature.txt', 'done\n');

    const res = await landTicket(ctx, t.id);

    expect(res.status).toBe('DONE');
    expect(git(dir, ['log', '--format=%s', '-1', 'main'])).toBe('initial');
    expect(git(dir, ['rev-parse', '--verify', `refs/heads/em/${t.key.toLowerCase()}`])).toBeTruthy();
  });

  it('does nothing for tickets that are not READY_TO_LAND', async () => {
    const t = store.createTicket({ title: 'Not ready', description: 'x' });
    const res = await landTicket(ctx, t.id);
    expect(res.moved).toBe(false);
    expect(store.getTicketById(t.id)!.status).toBe('BACKLOG');
  });
});

describe('land (the web Land button / em land retry)', () => {
  it('lands a READY_TO_LAND ticket directly', async () => {
    const t = readyTicket('feature.txt', 'done\n');
    const res = await land(ctx, t.id);
    expect(res.status).toBe('DONE');
    expect(store.getTicketById(t.id)!.status).toBe('DONE');
  });

  it('retries a NEEDS_INTEGRATION ticket once the worktree conflict is resolved, landing it', async () => {
    const t = readyTicket('README.md', 'ticket version\n');
    commitFile(dir, 'README.md', 'base version\n', 'conflicting base change');
    const parked = await landTicket(ctx, t.id);
    expect(parked.status).toBe('NEEDS_INTEGRATION');

    const wtPath = worktreePath(ctx.project, t.key);
    try {
      git(wtPath, ['merge', '--no-edit', 'main']);
    } catch {
      /* expected conflict; resolve manually below */
    }
    writeFileSync(join(wtPath, 'README.md'), 'resolved\n');
    git(wtPath, ['add', '-A']);
    git(wtPath, ['commit', '-q', '-m', 'resolve merge conflict']);

    const res = await land(ctx, t.id);

    expect(res.status).toBe('DONE');
    expect(store.getTicketById(t.id)!.status).toBe('DONE');
    expect(git(dir, ['show', 'main:README.md'])).toBe('resolved');
    const transitions = store.listTransitions(t.id);
    expect(
      transitions.some(
        (tr) => tr.fromState === 'NEEDS_INTEGRATION' && tr.toState === 'READY_TO_LAND' && tr.note === 'landing retried',
      ),
    ).toBe(true);
  });

  it('parks a still-conflicting NEEDS_INTEGRATION ticket again, with an updated note', async () => {
    const t = readyTicket('README.md', 'ticket version\n');
    commitFile(dir, 'README.md', 'base version\n', 'conflicting base change');
    await landTicket(ctx, t.id);
    expect(store.getTicketById(t.id)!.status).toBe('NEEDS_INTEGRATION');

    const res = await land(ctx, t.id);

    expect(res.status).toBe('NEEDS_INTEGRATION');
    expect(store.getTicketById(t.id)!.status).toBe('NEEDS_INTEGRATION');
    const last = store.listTransitions(t.id).at(-1);
    expect(last?.toState).toBe('NEEDS_INTEGRATION');
    expect(last?.note).toContain('conflicts');
  });

  it('does nothing for a ticket that is neither READY_TO_LAND nor NEEDS_INTEGRATION', async () => {
    const t = store.createTicket({ title: 'Not ready', description: 'x' });
    const res = await land(ctx, t.id);
    expect(res.moved).toBe(false);
    expect(res.status).toBe('BACKLOG');
    expect(store.getTicketById(t.id)!.status).toBe('BACKLOG');
  });
});
