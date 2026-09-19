import type { IncomingMessage, ServerResponse } from 'node:http';
import { availableRunnerIds } from '../agents/registry';
import { DEFAULT_MODEL, MEETING_MAX_TURNS, ROLE_MAX_TURNS, ROLE_MODELS, ROLES, type Role } from '../config';
import { INTERRUPTED_RUN_ERROR, type Store } from '../db/store';
import { adviceFor } from '../domain/report';
import { firstBuildState, roleForState, unblockTarget } from '../domain/states';
import { sayToDraft, startDraft } from '../drafting';
import { concludeMeeting, meetingTurn, STAKEHOLDER, validateParticipants } from '../meetings';
import { listModels } from '../pricing';
import { epicLeadTimeMs, ticketLeadTimeMs } from '../domain/timing';
import type { Epic, Ticket, TicketRelationType } from '../domain/types';
import { materializeEpic, performUnblock } from '../orchestrator/orchestrator';
import { parseEmConfig, saveConfig } from '../project';
import type { ApiRouter } from './router';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendJsonNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not found' });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) return {};
  return parsed as Record<string, unknown>;
}

function isTicketInterrupted(store: Store, key: string): boolean {
  const latest = store.latestRun(`ticket:${key}`);
  return latest?.status === 'ERROR' && latest.error === INTERRUPTED_RUN_ERROR;
}

function ticketDetail(store: Store, ticket: Ticket, pipeline?: string[]): Record<string, unknown> {
  const transitions = store.listTransitions(ticket.id);
  const unblockRole =
    ticket.status === 'BLOCKED' && pipeline
      ? roleForState(pipeline, unblockTarget(pipeline, store.blockedFrom(ticket.id), ticket.branch !== null))
      : null;
  const activeRun = store.activeRun(`ticket:${ticket.key}`);
  return {
    unblockRole,
    ...ticket,
    criteria: store.getCriteria(ticket.id),
    transitions,
    artifacts: store.getArtifacts(ticket.id),
    agentRuns: store.agentRunsForTicket(ticket.id),
    costUsd: store.ticketCostUsd(ticket.id),
    leadTimeMs: ticketLeadTimeMs(ticket, transitions),
    agentTimeMs: store.ticketAgentTimeMs(ticket.id),
    running: activeRun !== undefined,
    runStartedAt: activeRun?.startedAt ?? null,
    interrupted: isTicketInterrupted(store, ticket.key),
    relations: store.getTicketRelations(ticket.id),
  };
}

function epicDetail(store: Store, epic: Epic): Record<string, unknown> {
  const activeRun = store.activeRun(`epic:${epic.key}`);
  return {
    ...epic,
    subtickets: store.getSubtickets(epic.id),
    agentRuns: store.agentRunsForEpic(epic.id),
    costUsd: store.epicCostUsd(epic.id),
    leadTimeMs: epicLeadTimeMs(epic),
    agentTimeMs: store.epicAgentTimeMs(epic.id),
    running: activeRun !== undefined,
    runStartedAt: activeRun?.startedAt ?? null,
  };
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_LABEL_LENGTH = 24;
const RELATION_TYPES: TicketRelationType[] = ['blocks', 'relates-to'];

export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseImageAttachments(
  raw: unknown,
): Array<{ name: string; mime: string; dataBase64: string }> | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'images must be an array';
  if (raw.length > MAX_IMAGES) return `at most ${MAX_IMAGES} images per ticket`;
  const out: Array<{ name: string; mime: string; dataBase64: string }> = [];
  for (const item of raw) {
    const img = item as { name?: unknown; mime?: unknown; dataBase64?: unknown };
    if (typeof img?.name !== 'string' || typeof img?.mime !== 'string' || typeof img?.dataBase64 !== 'string') {
      return 'each image needs name, mime, and dataBase64';
    }
    if (!img.mime.startsWith('image/')) return `${img.name}: only image attachments are supported`;
    if (Buffer.byteLength(img.dataBase64, 'base64') > MAX_IMAGE_BYTES) {
      return `${img.name}: images are capped at ${MAX_IMAGE_BYTES / 1024 / 1024}MB`;
    }
    out.push({ name: img.name, mime: img.mime, dataBase64: img.dataBase64 });
  }
  return out;
}

export function parseDraftCriteria(raw: unknown): { text: string; isUi: boolean }[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'criteria must be an array';
  const out: { text: string; isUi: boolean }[] = [];
  for (const item of raw) {
    const c = item as { text?: unknown; isUi?: unknown };
    const text = typeof c?.text === 'string' ? c.text.trim() : '';
    if (!text) return 'each criterion needs text';
    out.push({ text, isUi: Boolean(c?.isUi) });
  }
  return out;
}

export function registerApiRoutes(router: ApiRouter): void {
  router.register('GET', '/config', (_req, res, { project }) => {
    sendJson(res, 200, {
      config: project.config,
      availableRunners: availableRunnerIds(project.config),
      roles: [...ROLES, ...project.config.pipeline.filter((s) => !(ROLES as readonly string[]).includes(s))],
      defaults: { models: ROLE_MODELS, maxTurns: ROLE_MAX_TURNS, meetingMaxTurns: MEETING_MAX_TURNS },
    });
  });

  router.register('PUT', '/config', async (req, res, { project }) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const parsed = parseEmConfig(body);
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    saveConfig(project, parsed.config);
    sendJson(res, 200, { config: parsed.config });
  });

  router.register('GET', '/models', async (_req, res, { project }) => {
    sendJson(res, 200, { models: await listModels(project) });
  });

  router.register('GET', '/report', (req, res, { store, project }) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const daysRaw = url.searchParams.get('days');
    let windowDays: number | null = 30;
    if (daysRaw === 'all') windowDays = null;
    else if (daysRaw !== null) {
      const days = Number(daysRaw);
      if (!Number.isInteger(days) || days <= 0) {
        sendJson(res, 400, { error: 'days must be a positive integer or "all"' });
        return;
      }
      windowDays = days;
    }
    const report = store.buildReport(windowDays, project.config.monthlyBudgetUsd);
    const roleModels = Object.fromEntries(
      Object.entries(project.config.roles).map(([role, o]) => [role, o.model ?? ROLE_MODELS[role as Role]]),
    );
    sendJson(res, 200, { ...report, advice: adviceFor(report, roleModels, DEFAULT_MODEL) });
  });

  router.register('GET', '/meetings', (_req, res, { store }) => {
    sendJson(res, 200, { meetings: store.listMeetings() });
  });

  router.register('GET', '/meetings/:key', (_req, res, { store }, params) => {
    const meeting = store.getMeeting(Number(params.key));
    if (!meeting) {
      sendJsonNotFound(res);
      return;
    }
    sendJson(res, 200, { ...meeting, messages: store.meetingMessages(meeting.id) });
  });

  router.register('POST', '/meetings', async (req, res, { store, project }) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Working meeting';
    const participants = Array.isArray(body.participants) ? body.participants.map(String) : [];
    const invalid = validateParticipants(participants, project.config.pipeline);
    if (invalid) {
      sendJson(res, 400, { error: invalid });
      return;
    }
    const ticket = typeof body.ticketKey === 'string' ? store.getTicketByKey(body.ticketKey) : undefined;
    const epic = typeof body.epicKey === 'string' ? store.getEpicByKey(body.epicKey) : undefined;
    if ((typeof body.ticketKey === 'string' && !ticket) || (typeof body.epicKey === 'string' && !epic)) {
      sendJson(res, 400, { error: 'linked ticket or epic not found' });
      return;
    }
    const meeting = store.createMeeting({
      title,
      participants: participants.includes(STAKEHOLDER) ? participants : [STAKEHOLDER, ...participants],
      ticketId: ticket?.id ?? null,
      epicId: epic?.id ?? null,
    });
    sendJson(res, 201, meeting);
  });

  router.register('POST', '/meetings/:key/say', async (req, res, ctx, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }
    const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : null;
    try {
      const reply = await meetingTurn(ctx, Number(params.key), text, to);
      sendJson(res, 200, { reply });
    } catch (err) {
      sendJson(res, 409, { error: (err as Error).message });
    }
  });

  router.register('POST', '/meetings/:key/conclude', async (_req, res, ctx, params) => {
    try {
      const outcome = await concludeMeeting(ctx, Number(params.key));
      sendJson(res, 200, { summary: outcome.summary, createdTickets: outcome.createdTickets.map((t) => t.key) });
    } catch (err) {
      sendJson(res, 409, { error: (err as Error).message });
    }
  });

  router.register('GET', '/board', (_req, res, { store, project }) => {
    const interruptedKeys = new Set(
      store.interruptedTargets().filter((t) => t.startsWith('ticket:')).map((t) => t.slice('ticket:'.length)),
    );
    const withInterrupted = (ticket: Ticket) => ({ ...ticket, interrupted: interruptedKeys.has(ticket.key) });
    const epics = store.listEpics().map((epic) => ({
      ...epic,
      subtickets: store.getSubtickets(epic.id).map(withInterrupted),
      costUsd: store.epicCostUsd(epic.id),
      leadTimeMs: epicLeadTimeMs(epic),
    }));
    const standaloneTickets = store.listTickets().filter((ticket) => ticket.epicId === null).map(withInterrupted);
    sendJson(res, 200, { epics, standaloneTickets, pipeline: project.config.pipeline });
  });

  router.register('GET', '/epics/:key', (_req, res, { store }, params) => {
    const epic = store.getEpicByKey(params.key ?? '');
    if (!epic) {
      sendJsonNotFound(res);
      return;
    }
    sendJson(res, 200, epicDetail(store, epic));
  });

  router.register('GET', '/tickets/:key', (_req, res, { store, project }, params) => {
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    sendJson(res, 200, ticketDetail(store, ticket, project.config.pipeline));
  });

  router.register('GET', '/tickets/:key/draft', (_req, res, { store }, params) => {
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (ticket.status !== 'DRAFT') {
      sendJson(res, 409, { error: 'ticket is not a draft' });
      return;
    }
    sendJson(res, 200, { ...ticket, messages: store.draftMessages(ticket.id) });
  });

  router.register('POST', '/tickets', async (req, res, { store }) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) {
      sendJson(res, 400, { error: 'description is required' });
      return;
    }
    const images = parseImageAttachments(body.images);
    if (typeof images === 'string') {
      sendJson(res, 400, { error: images });
      return;
    }
    const ticket = store.createTicket({ title: '', description });
    for (const img of images) {
      store.addArtifact(ticket.id, 'ATTACHMENT', 'human', img.dataBase64, { name: img.name, mime: img.mime });
    }
    sendJson(res, 201, { key: ticket.key });
  });

  router.register('POST', '/tickets/draft', async (req, res, ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const raw = typeof body.idea === 'string' ? body.idea : typeof body.description === 'string' ? body.description : '';
    const idea = raw.trim();
    if (!idea) {
      sendJson(res, 400, { error: 'idea is required' });
      return;
    }
    const images = parseImageAttachments(body.images);
    if (typeof images === 'string') {
      sendJson(res, 400, { error: images });
      return;
    }
    const ticket = ctx.store.createDraftTicket({ description: idea });
    for (const img of images) {
      ctx.store.addArtifact(ticket.id, 'ATTACHMENT', 'human', img.dataBase64, { name: img.name, mime: img.mime });
    }
    await startDraft(ctx, ticket);
    sendJson(res, 201, { key: ticket.key });
  });

  router.register('GET', '/tickets/:key/draft/messages', (_req, res, { store }, params) => {
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    sendJson(res, 200, { messages: store.draftMessages(ticket.id) });
  });

  router.register('POST', '/tickets/:key/draft/say', async (req, res, ctx, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = ctx.store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }
    if (ticket.status !== 'DRAFT') {
      sendJson(res, 409, { error: 'ticket is not in draft' });
      return;
    }
    const reply = await sayToDraft(ctx, ticket, text);
    sendJson(res, 200, { reply });
  });

  router.register('POST', '/tickets/:key/draft/accept', async (req, res, { store, project }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (ticket.status !== 'DRAFT') {
      sendJson(res, 409, { error: 'ticket is not in draft' });
      return;
    }
    const criteria = parseDraftCriteria(body.criteria);
    if (typeof criteria === 'string') {
      sendJson(res, 400, { error: criteria });
      return;
    }
    if (criteria.length === 0) {
      sendJson(res, 400, { error: 'at least one acceptance criterion is required' });
      return;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const hasUi = Boolean(body.hasUi);
    const runCommand = typeof body.runCommand === 'string' && body.runCommand.trim() ? body.runCommand.trim() : null;
    const appUrl = typeof body.appUrl === 'string' && body.appUrl.trim() ? body.appUrl.trim() : null;
    store.setTitle(ticket.id, title);
    store.setDescription(ticket.id, description);
    store.setCriteria(ticket.id, criteria);
    store.setUiInfo(ticket.id, hasUi, runCommand, appUrl);
    store.transition({
      ticketId: ticket.id,
      from: 'DRAFT',
      to: 'AWAIT_APPROVAL',
      role: null,
      verdict: 'PASS',
      note: 'draft accepted',
    });
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!, project.config.pipeline));
  });

  router.register('POST', '/epics', async (req, res, { store }) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!goal) {
      sendJson(res, 400, { error: 'goal is required' });
      return;
    }
    const epic = store.createEpic({ title: goal.slice(0, 80), description: goal });
    sendJson(res, 201, { key: epic.key });
  });

  router.register('POST', '/tickets/:key/approve', (_req, res, { store, project }, params) => {
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (ticket.status !== 'AWAIT_APPROVAL') {
      sendJson(res, 409, { error: 'ticket is not awaiting approval' });
      return;
    }
    store.transition({
      ticketId: ticket.id,
      from: 'AWAIT_APPROVAL',
      to: firstBuildState(project.config.pipeline),
      role: null,
      verdict: 'PASS',
      note: 'approved',
    });
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!));
  });

  router.register('POST', '/tickets/:key/reject', async (req, res, { store }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (ticket.status !== 'AWAIT_APPROVAL') {
      sendJson(res, 409, { error: 'ticket is not awaiting approval' });
      return;
    }
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (!feedback) {
      sendJson(res, 400, { error: 'feedback is required' });
      return;
    }
    store.setFeedback(ticket.id, feedback);
    store.transition({
      ticketId: ticket.id,
      from: 'AWAIT_APPROVAL',
      to: 'BACKLOG',
      role: null,
      verdict: 'FAIL',
      note: feedback,
    });
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!));
  });

  router.register('POST', '/tickets/:key/unblock', async (req, res, { store, project }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (ticket.status !== 'BLOCKED') {
      sendJson(res, 409, { error: 'ticket is not blocked' });
      return;
    }
    const guidance = typeof body.guidance === 'string' ? body.guidance.trim() : '';
    if (!guidance) {
      sendJson(res, 400, { error: 'guidance is required' });
      return;
    }
    performUnblock({ store, project }, ticket, guidance);
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!, project.config.pipeline));
  });

  router.register('POST', '/epics/:key/approve', (_req, res, { store }, params) => {
    const epic = store.getEpicByKey(params.key ?? '');
    if (!epic) {
      sendJsonNotFound(res);
      return;
    }
    if (epic.status !== 'AWAIT_PLAN') {
      sendJson(res, 409, { error: 'epic is not awaiting plan approval' });
      return;
    }
    try {
      materializeEpic(store, epic.id);
    } catch (err) {
      sendJson(res, 409, { error: (err as Error).message });
      return;
    }
    sendJson(res, 200, epicDetail(store, store.getEpicById(epic.id)!));
  });

  router.register('POST', '/epics/:key/reject', async (req, res, { store }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const epic = store.getEpicByKey(params.key ?? '');
    if (!epic) {
      sendJsonNotFound(res);
      return;
    }
    if (epic.status !== 'AWAIT_PLAN') {
      sendJson(res, 409, { error: 'epic is not awaiting plan approval' });
      return;
    }
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (!feedback) {
      sendJson(res, 400, { error: 'feedback is required' });
      return;
    }
    store.setEpicFeedback(epic.id, feedback);
    store.setEpicStatus(epic.id, 'PLANNING');
    sendJson(res, 200, epicDetail(store, store.getEpicById(epic.id)!));
  });

  router.register('GET', '/labels', (_req, res, { store }) => {
    sendJson(res, 200, { labels: store.listLabels() });
  });

  router.register('PUT', '/tickets/:key/priority', async (req, res, { store }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    const priority = typeof body.priority === 'string' ? body.priority.trim() : '';
    if (!priority) {
      sendJson(res, 400, { error: 'priority is required' });
      return;
    }
    store.setPriority(ticket.id, priority);
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!));
  });

  router.register('PUT', '/tickets/:key/labels', async (req, res, { store }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    if (!Array.isArray(body.labels)) {
      sendJson(res, 400, { error: 'labels must be an array' });
      return;
    }
    const labels: string[] = [];
    for (const raw of body.labels) {
      if (typeof raw !== 'string') {
        sendJson(res, 400, { error: 'each label must be a string' });
        return;
      }
      const label = normalizeLabel(raw);
      if (label.length > MAX_LABEL_LENGTH) {
        sendJson(res, 400, { error: `label "${label}" exceeds ${MAX_LABEL_LENGTH} characters` });
        return;
      }
      labels.push(label);
    }
    store.setLabels(ticket.id, labels);
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!));
  });

  router.register('POST', '/tickets/:key/relations', async (req, res, { store }, params) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    const type = typeof body.type === 'string' ? body.type : '';
    if (!RELATION_TYPES.includes(type as TicketRelationType)) {
      sendJson(res, 400, { error: `type must be one of ${RELATION_TYPES.join(', ')}` });
      return;
    }
    const targetKey = typeof body.targetKey === 'string' ? body.targetKey.trim() : '';
    const target = targetKey ? store.getTicketByKey(targetKey) : undefined;
    if (!target) {
      sendJson(res, 400, { error: 'target ticket not found' });
      return;
    }
    const relation = store.addTicketRelation(ticket.id, target.id, type as TicketRelationType);
    sendJson(res, 201, relation);
  });

  router.register('DELETE', '/tickets/:key/relations/:relationId', (_req, res, { store }, params) => {
    const ticket = store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJsonNotFound(res);
      return;
    }
    const relationId = Number(params.relationId);
    if (!store.deleteTicketRelation(ticket.id, relationId)) {
      sendJson(res, 404, { error: 'relation not found' });
      return;
    }
    sendJson(res, 200, ticketDetail(store, store.getTicketById(ticket.id)!));
  });
}
