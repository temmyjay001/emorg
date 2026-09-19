import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleJiraWebhook, parseWebhookEvent, secretMatches } from '../jira/bridge';
import { JiraClient } from '../jira/client';
import { run } from '../orchestrator/orchestrator';
import { openProject } from '../project';
import { registerProject } from '../registry';
import { registerActionRoutes } from './actions';
import { registerApiRoutes } from './api';
import { registerLiveRoutes } from './live';
import { ProjectManager } from './manager';
import { createRouter, type ApiRouter } from './router';
import { serveStatic } from './static';

const HEALTH_PATH = '/healthz';
const DEFAULT_PORT = 4788;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleJiraWebhookRequest(manager: ProjectManager, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'invalid payload' });
    return;
  }
  const event = parseWebhookEvent(payload);
  const projectKey = event.issueKey?.split('-')[0];
  for (const entry of manager.list()) {
    const ctx = manager.ctxFor(entry.id);
    const cfg = ctx?.project.config.jira;
    if (!ctx || !cfg || !projectKey || !cfg.projectKeys.includes(projectKey)) continue;
    if (!secretMatches(process.env[cfg.webhookSecretEnv], url.searchParams.get('secret'))) {
      sendJson(res, 401, { error: 'bad secret' });
      return;
    }
    const client = new JiraClient({ site: cfg.site, email: cfg.email, token: process.env[cfg.tokenEnv] ?? '' });
    const outcome = await handleJiraWebhook(ctx, client, cfg, event, (line) => console.error(`[jira/${entry.name}] ${line}`));
    sendJson(res, 200, { outcome });
    return;
  }
  sendJson(res, 200, { outcome: 'ignored: no project claims this issue' });
}

export function createServer(manager: ProjectManager, router: ApiRouter): Server {
  return createHttpServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (method === 'POST' && path === '/webhooks/jira') {
      await handleJiraWebhookRequest(manager, req, res, new URL(req.url ?? '/', 'http://localhost'));
      return;
    }

    if (method === 'GET' && path === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (path === '/api/projects' && method === 'GET') {
      sendJson(res, 200, { projects: manager.list() });
      return;
    }

    if (path.startsWith('/api/projects/')) {
      const parts = segments(path.slice('/api/projects/'.length));
      const id = parts[0];
      const ctx = id ? manager.ctxFor(id) : undefined;
      if (!ctx) {
        sendJson(res, 404, { error: 'unknown project' });
        return;
      }
      const rest = `/${parts.slice(1).join('/')}`;
      const handled = await router.handle(method, rest, req, res, ctx);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (path === '/api' || path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (method === 'GET') {
      await serveStatic(res, path);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

function sweepAndMaybeResume(manager: ProjectManager): void {
  for (const entry of manager.list()) {
    const ctx = manager.ctxFor(entry.id);
    if (!ctx) continue;
    const swept = ctx.store.sweepDeadRuns();
    if (swept.length > 0) {
      console.log(`${entry.name}: swept ${swept.length} interrupted run${swept.length === 1 ? '' : 's'}`);
    }
    if (!ctx.project.config.autoResumeInterrupted) continue;
    for (const target of ctx.store.interruptedTargets()) {
      if (!target.startsWith('ticket:')) continue;
      const key = target.slice('ticket:'.length);
      const ticket = ctx.store.getTicketByKey(key);
      if (!ticket) continue;
      console.log(`${entry.name}: auto-resuming ${key}`);
      run(ctx, ticket.id, (line) => console.log(`[${entry.name}/${key}] ${line}`)).catch((err) => {
        console.error(`${entry.name}: failed to resume ${key}: ${(err as Error).message}`);
      });
    }
  }
}

export function startServer(portOverride?: number): Server {
  const configured = portOverride ?? Number(process.env.WEB_PORT);
  const port = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PORT;

  try {
    const project = openProject();
    registerProject(project.root);
  } catch {
    // No project in the current directory; serve whatever is already registered.
  }

  const manager = new ProjectManager();
  sweepAndMaybeResume(manager);
  const router = createRouter();
  registerApiRoutes(router);
  registerActionRoutes(router);
  registerLiveRoutes(router);
  const server = createServer(manager, router);
  server.listen(port, () => {
    const actual = (server.address() as AddressInfo).port;
    const count = manager.list().length;
    console.log(`em dashboard: ${count} project${count === 1 ? '' : 's'}`);
    console.log(`http://localhost:${actual}`);
  });
  return server;
}
