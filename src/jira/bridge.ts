import type { Ctx } from '../ctx';
import { firstBuildState } from '../domain/states';
import type { Ticket } from '../domain/types';
import type { JiraConfig } from '../project';
import { cancelRun, performUnblock, run } from '../orchestrator/orchestrator';
import type { JiraClient, JiraIssue } from './client';

export type Log = (msg: string) => void;
const noop: Log = () => {};

export interface JiraWebhookEvent {
  kind: 'issue' | 'comment' | 'other';
  issueKey: string | null;
  issue: JiraIssue | null;
  commentBody: string | null;
  commentAuthorAccountId: string | null;
}

export function parseWebhookEvent(payload: Record<string, unknown>): JiraWebhookEvent {
  const eventName = String(payload.webhookEvent ?? '');
  const rawIssue = payload.issue as Record<string, unknown> | undefined;
  const issueKey = rawIssue && typeof rawIssue.key === 'string' ? rawIssue.key : null;
  let issue: JiraIssue | null = null;
  if (rawIssue && issueKey) {
    const fields = (rawIssue.fields ?? {}) as Record<string, unknown>;
    const assignee = fields.assignee as Record<string, unknown> | null | undefined;
    const status = (fields.status ?? {}) as Record<string, unknown>;
    issue = {
      key: issueKey,
      projectKey: issueKey.split('-')[0] ?? '',
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      description: typeof fields.description === 'string' ? fields.description : '',
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      assigneeAccountId: assignee && typeof assignee.accountId === 'string' ? assignee.accountId : null,
      status: typeof status.name === 'string' ? status.name : '',
    };
  }
  if (eventName === 'comment_created' || payload.comment) {
    const comment = (payload.comment ?? {}) as Record<string, unknown>;
    const author = (comment.author ?? {}) as Record<string, unknown>;
    return {
      kind: 'comment',
      issueKey,
      issue,
      commentBody: typeof comment.body === 'string' ? comment.body : null,
      commentAuthorAccountId: typeof author.accountId === 'string' ? author.accountId : null,
    };
  }
  if (eventName.startsWith('jira:issue')) {
    return { kind: 'issue', issueKey, issue, commentBody: null, commentAuthorAccountId: null };
  }
  return { kind: 'other', issueKey, issue, commentBody: null, commentAuthorAccountId: null };
}

export function isTriggered(issue: JiraIssue, cfg: JiraConfig): boolean {
  if (cfg.triggerAccountId && issue.assigneeAccountId === cfg.triggerAccountId) return true;
  return issue.labels.some((l) => l.toLowerCase() === cfg.triggerLabel.toLowerCase());
}

export interface CommentVerb {
  verb: 'approve' | 'reject' | 'unblock' | 'pause' | 'status';
  arg: string;
}

const VERBS = new Set(['approve', 'reject', 'unblock', 'pause', 'status']);

export function parseCommentVerb(body: string): CommentVerb | null {
  const cleaned = body.replace(/\[~accountid:[^\]]+\]/gi, '@emorg').trim();
  const m = cleaned.match(/^@?emorg\b[,:]?\s*(\w+)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  if (!VERBS.has(verb)) return null;
  return { verb: verb as CommentVerb['verb'], arg: m[2]!.trim() };
}

async function say(client: JiraClient, issueKey: string, text: string, log: Log): Promise<void> {
  try {
    await client.addComment(issueKey, text);
  } catch (err) {
    log(`jira comment on ${issueKey} failed: ${(err as Error).message}`);
  }
}

export async function mirrorStatus(client: JiraClient, cfg: JiraConfig, ticket: Ticket, log: Log): Promise<void> {
  if (!ticket.jiraKey) return;
  const target = cfg.statusMap[ticket.status];
  if (!target) return;
  try {
    const moved = await client.transitionTo(ticket.jiraKey, target);
    if (!moved) log(`jira: no transition to "${target}" available on ${ticket.jiraKey}`);
  } catch (err) {
    log(`jira transition on ${ticket.jiraKey} failed: ${(err as Error).message}`);
  }
}

function runSummary(ctx: Ctx, ticket: Ticket): string {
  const fresh = ctx.store.getTicketById(ticket.id)!;
  const criteria = ctx.store.getCriteria(ticket.id);
  const lines = [`emorg: ${fresh.key} is now ${fresh.status}.`];
  if (fresh.status === 'AWAIT_APPROVAL' && criteria.length > 0) {
    lines.push('', 'Acceptance criteria for approval:');
    for (const c of criteria) lines.push(`${c.idx}. ${c.text}`);
    lines.push('', 'Reply "@emorg approve" to build, or "@emorg reject <feedback>" to revise.');
  }
  const last = ctx.store.listTransitions(ticket.id).at(-1);
  if (last?.note && fresh.status !== 'AWAIT_APPROVAL') lines.push('', last.note);
  return lines.join('\n');
}

function runAndReport(ctx: Ctx, client: JiraClient, cfg: JiraConfig, ticketId: number, log: Log): void {
  const ticket = ctx.store.getTicketById(ticketId)!;
  run(ctx, ticketId, log)
    .catch((err) => log(`jira-triggered run for ${ticket.key} failed: ${(err as Error).message}`))
    .then(async () => {
      const fresh = ctx.store.getTicketById(ticketId)!;
      await mirrorStatus(client, cfg, fresh, log);
      if (fresh.jiraKey) await say(client, fresh.jiraKey, runSummary(ctx, fresh), log);
    });
}

export async function handleJiraWebhook(
  ctx: Ctx,
  client: JiraClient,
  cfg: JiraConfig,
  event: JiraWebhookEvent,
  log: Log = noop,
): Promise<string> {
  if (!event.issueKey) return 'ignored: no issue';
  if (event.kind === 'issue' && event.issue) {
    if (!isTriggered(event.issue, cfg)) return 'ignored: not assigned to emorg';
    const existing = ctx.store.getTicketByJiraKey(event.issueKey);
    if (existing) return `known: ${existing.key} is ${existing.status}`;
    const description = [event.issue.description.trim(), `Mirrored from Jira issue ${event.issueKey}.`]
      .filter(Boolean)
      .join('\n\n');
    const ticket = ctx.store.createTicket({
      title: event.issue.summary,
      description: description || event.issue.summary,
      jiraKey: event.issueKey,
    });
    log(`jira: ${event.issueKey} mirrored as ${ticket.key}`);
    await say(client, event.issueKey, `emorg picked this up as ${ticket.key}; drafting acceptance criteria for your approval.`, log);
    runAndReport(ctx, client, cfg, ticket.id, log);
    return `mirrored: ${ticket.key}`;
  }
  if (event.kind === 'comment' && event.commentBody) {
    if (cfg.triggerAccountId && event.commentAuthorAccountId === cfg.triggerAccountId) return 'ignored: own comment';
    const parsed = parseCommentVerb(event.commentBody);
    if (!parsed) return 'ignored: no verb';
    const ticket = ctx.store.getTicketByJiraKey(event.issueKey);
    if (!ticket) {
      await say(client, event.issueKey, 'emorg: this issue is not on my board yet; assign it to me first.', log);
      return 'verb on unmirrored issue';
    }
    return applyVerb(ctx, client, cfg, ticket, parsed, log);
  }
  return 'ignored';
}

async function applyVerb(
  ctx: Ctx,
  client: JiraClient,
  cfg: JiraConfig,
  ticket: Ticket,
  { verb, arg }: CommentVerb,
  log: Log,
): Promise<string> {
  const { store, project } = ctx;
  if (verb === 'status') {
    await say(client, ticket.jiraKey!, `emorg: ${ticket.key} is ${ticket.status}; cost so far $${store.ticketCostUsd(ticket.id).toFixed(2)}.`, log);
    return 'status posted';
  }
  if (verb === 'pause') {
    const requested = cancelRun(store, `ticket:${ticket.key}`);
    await say(client, ticket.jiraKey!, requested ? `emorg: pausing ${ticket.key}.` : `emorg: ${ticket.key} has no run in progress.`, log);
    return requested ? 'paused' : 'nothing to pause';
  }
  if (verb === 'approve') {
    if (ticket.status !== 'AWAIT_APPROVAL') {
      await say(client, ticket.jiraKey!, `emorg: ${ticket.key} is ${ticket.status}, not awaiting approval.`, log);
      return 'approve rejected';
    }
    store.transition({
      ticketId: ticket.id,
      from: ticket.status,
      to: firstBuildState(project.config.pipeline),
      role: null,
      verdict: 'PASS',
      note: 'approved via Jira comment',
    });
    await say(client, ticket.jiraKey!, `emorg: ${ticket.key} approved; building.`, log);
    runAndReport(ctx, client, cfg, ticket.id, log);
    return 'approved';
  }
  if (verb === 'reject') {
    if (ticket.status !== 'AWAIT_APPROVAL') {
      await say(client, ticket.jiraKey!, `emorg: ${ticket.key} is ${ticket.status}, not awaiting approval.`, log);
      return 'reject rejected';
    }
    if (!arg) {
      await say(client, ticket.jiraKey!, 'emorg: reject needs feedback, e.g. "@emorg reject split criterion 2".', log);
      return 'reject missing feedback';
    }
    store.setFeedback(ticket.id, arg);
    store.transition({ ticketId: ticket.id, from: ticket.status, to: 'BACKLOG', role: null, verdict: 'FAIL', note: arg });
    await say(client, ticket.jiraKey!, `emorg: ${ticket.key} sent back to the PM with your feedback.`, log);
    runAndReport(ctx, client, cfg, ticket.id, log);
    return 'rejected';
  }
  if (ticket.status !== 'BLOCKED') {
    await say(client, ticket.jiraKey!, `emorg: ${ticket.key} is ${ticket.status}, not blocked.`, log);
    return 'unblock rejected';
  }
  if (!arg) {
    await say(client, ticket.jiraKey!, 'emorg: unblock needs guidance, e.g. "@emorg unblock use the existing auth middleware".', log);
    return 'unblock missing guidance';
  }
  const to = performUnblock(ctx, ticket, arg);
  await say(client, ticket.jiraKey!, `emorg: ${ticket.key} unblocked to ${to}; resuming.`, log);
  runAndReport(ctx, client, cfg, ticket.id, log);
  return 'unblocked';
}
