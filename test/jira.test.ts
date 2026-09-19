import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx';
import { Store } from '../src/db/store';
import { handleJiraWebhook, isTriggered, parseCommentVerb, parseWebhookEvent, secretMatches } from '../src/jira/bridge';
import { JiraClient, type JiraIssue } from '../src/jira/client';
import { initProject, type JiraConfig } from '../src/project';

const CFG: JiraConfig = {
  site: 'https://acme.atlassian.net',
  email: 'bot@acme.dev',
  tokenEnv: 'JIRA_API_TOKEN',
  webhookSecretEnv: 'JIRA_WEBHOOK_SECRET',
  projectKeys: ['PAY'],
  triggerLabel: 'emorg',
  triggerAccountId: 'bot-account',
  statusMap: { DONE: 'Done' },
  evidenceUpload: true,
};

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PAY-7',
    projectKey: 'PAY',
    summary: 'Add settlement export',
    description: 'Finance needs a CSV export of settled batches.',
    labels: [],
    assigneeAccountId: null,
    status: 'To Do',
    ...overrides,
  };
}

describe('JiraClient', () => {
  it('authenticates, maps issues, and picks the right transition', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = new Map<string, unknown>([
      [
        '/rest/api/2/issue/PAY-7?fields=summary,description,labels,assignee,status,project',
        { key: 'PAY-7', fields: { summary: 'S', description: 'D', labels: ['x'], assignee: { accountId: 'a1' }, status: { name: 'To Do' }, project: { key: 'PAY' } } },
      ],
      ['/rest/api/2/issue/PAY-7/transitions', { transitions: [{ id: '11', to: { name: 'In Progress' } }, { id: '31', to: { name: 'Done' } }] }],
    ]);
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      const path = u.replace('https://acme.atlassian.net', '');
      const body = responses.get(path) ?? null;
      return new Response(body === null ? '' : JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const client = new JiraClient({ site: 'https://acme.atlassian.net/', email: 'bot@acme.dev', token: 'tok', fetchImpl });
    const got = await client.getIssue('PAY-7');
    expect(got).toEqual({ key: 'PAY-7', projectKey: 'PAY', summary: 'S', description: 'D', labels: ['x'], assigneeAccountId: 'a1', status: 'To Do' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('bot@acme.dev:tok').toString('base64')}`);

    expect(await client.transitionTo('PAY-7', 'done')).toBe(true);
    const last = calls.at(-1)!;
    expect(last.url).toContain('/transitions');
    expect(JSON.parse(String(last.init.body))).toEqual({ transition: { id: '31' } });

    expect(await client.transitionTo('PAY-7', 'Nonexistent')).toBe(false);
  });
});

describe('parseCommentVerb', () => {
  it('parses verbs with mentions, punctuation, and multiline args', () => {
    expect(parseCommentVerb('@emorg approve')).toEqual({ verb: 'approve', arg: '' });
    expect(parseCommentVerb('emorg: unblock use the existing auth middleware')).toEqual({ verb: 'unblock', arg: 'use the existing auth middleware' });
    expect(parseCommentVerb('[~accountid:12345] reject split criterion 2\ninto two parts')).toEqual({ verb: 'reject', arg: 'split criterion 2\ninto two parts' });
    expect(parseCommentVerb('EMORG STATUS')).toEqual({ verb: 'status', arg: '' });
  });

  it('ignores everything else', () => {
    expect(parseCommentVerb('great work team')).toBeNull();
    expect(parseCommentVerb('@emorg dance')).toBeNull();
    expect(parseCommentVerb('someone said emorg approve is nice')).toBeNull();
  });
});

describe('parseWebhookEvent and trigger', () => {
  it('classifies issue and comment events', () => {
    const assigned = parseWebhookEvent({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'PAY-7', fields: { summary: 'S', description: 'D', labels: [], assignee: { accountId: 'bot-account' }, status: { name: 'To Do' } } },
    });
    expect(assigned.kind).toBe('issue');
    expect(assigned.issue?.assigneeAccountId).toBe('bot-account');

    const comment = parseWebhookEvent({
      webhookEvent: 'comment_created',
      issue: { key: 'PAY-7', fields: {} },
      comment: { body: '@emorg approve', author: { accountId: 'human-1' } },
    });
    expect(comment.kind).toBe('comment');
    expect(comment.commentBody).toBe('@emorg approve');
  });

  it('triggers on assignee or label, case-insensitively', () => {
    expect(isTriggered(issue({ assigneeAccountId: 'bot-account' }), CFG)).toBe(true);
    expect(isTriggered(issue({ labels: ['Emorg'] }), CFG)).toBe(true);
    expect(isTriggered(issue(), CFG)).toBe(false);
  });
});

describe('handleJiraWebhook', () => {
  let dir: string;
  let ctx: Ctx;
  let store: Store;
  let comments: string[];
  let transitionsRequested: string[];
  const stubClient = {
    addComment: async (_key: string, text: string) => {
      comments.push(text);
    },
    transitionTo: async (_key: string, status: string) => {
      transitionsRequested.push(status);
      return true;
    },
  } as unknown as JiraClient;

  beforeEach(() => {
    delete process.env.EM_TARGET_REPO;
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'em-jira-')));
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const project = initProject(dir).project;
    project.config.pipeline = ['pm', 'developer'];
    store = new Store(join(project.emDir, 'jira-test.db'));
    ctx = { store, project };
    comments = [];
    transitionsRequested = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors a triggered issue exactly once', async () => {
    const event = parseWebhookEvent({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'PAY-7', fields: { summary: 'Add settlement export', description: 'CSV export.', labels: ['emorg'], status: { name: 'To Do' } } },
    });
    const first = await handleJiraWebhook(ctx, stubClient, CFG, event);
    expect(first).toMatch(/^mirrored: /);
    const ticket = store.getTicketByJiraKey('PAY-7')!;
    expect(ticket.title).toBe('Add settlement export');
    expect(ticket.description).toContain('Mirrored from Jira issue PAY-7');
    expect(comments[0]).toContain(`picked this up as ${ticket.key}`);

    const again = await handleJiraWebhook(ctx, stubClient, CFG, event);
    expect(again).toMatch(/^known: /);
    expect(store.getTicketByJiraKey('PAY-7')!.id).toBe(ticket.id);
  });

  it('ignores untriggered issues and unmirrored verb comments', async () => {
    const untouched = await handleJiraWebhook(ctx, stubClient, CFG, parseWebhookEvent({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'PAY-9', fields: { summary: 'Human work', labels: [] } },
    }));
    expect(untouched).toBe('ignored: not assigned to emorg');

    const verb = await handleJiraWebhook(ctx, stubClient, CFG, parseWebhookEvent({
      webhookEvent: 'comment_created',
      issue: { key: 'PAY-9', fields: {} },
      comment: { body: '@emorg status', author: { accountId: 'human-1' } },
    }));
    expect(verb).toBe('verb on unmirrored issue');
    expect(comments.at(-1)).toContain('assign it to me first');
  });

  it('handles status and pause verbs and guards approve by state', async () => {
    const t = store.createTicket({ title: 'T', description: 'D', jiraKey: 'PAY-8' });

    const status = await handleJiraWebhook(ctx, stubClient, CFG, parseWebhookEvent({
      webhookEvent: 'comment_created',
      issue: { key: 'PAY-8', fields: {} },
      comment: { body: '@emorg status', author: { accountId: 'human-1' } },
    }));
    expect(status).toBe('status posted');
    expect(comments.at(-1)).toContain(`${t.key} is BACKLOG`);

    const approve = await handleJiraWebhook(ctx, stubClient, CFG, parseWebhookEvent({
      webhookEvent: 'comment_created',
      issue: { key: 'PAY-8', fields: {} },
      comment: { body: '@emorg approve', author: { accountId: 'human-1' } },
    }));
    expect(approve).toBe('approve rejected');
    expect(comments.at(-1)).toContain('not awaiting approval');

    const ownComment = await handleJiraWebhook(ctx, stubClient, CFG, parseWebhookEvent({
      webhookEvent: 'comment_created',
      issue: { key: 'PAY-8', fields: {} },
      comment: { body: '@emorg approve', author: { accountId: 'bot-account' } },
    }));
    expect(ownComment).toBe('ignored: own comment');
  });
});

describe('secretMatches', () => {
  it('accepts only exact matches and rejects empty inputs', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true);
    expect(secretMatches('abc123', 'abc124')).toBe(false);
    expect(secretMatches('abc123', 'abc12')).toBe(false);
    expect(secretMatches(undefined, 'abc123')).toBe(false);
    expect(secretMatches('abc123', null)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });
});

describe('registerWebhook', () => {
  it('posts the dynamic webhook with secret url and project filter', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ self: 'https://acme.atlassian.net/rest/webhooks/1.0/webhook/42' }), { status: 201 });
    }) as typeof fetch;
    const client = new JiraClient({ site: 'https://acme.atlassian.net', email: 'e', token: 't', fetchImpl });
    const self = await client.registerWebhook('https://em.example.com/', ['PAY', 'OPS'], 's3cret');
    expect(self).toContain('/webhook/42');
    expect(captured!.url).toContain('/rest/webhooks/1.0/webhook');
    expect(captured!.body.url).toBe('https://em.example.com/webhooks/jira?secret=s3cret');
    expect(captured!.body.events).toContain('comment_created');
    expect((captured!.body.filters as Record<string, string>)['issue-related-events-section']).toBe('project in (PAY, OPS)');
  });
});
