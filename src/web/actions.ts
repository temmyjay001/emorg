import type { ServerResponse } from 'node:http';
import type { Ctx } from '../ctx';
import { cancelRun, land, type Log, planEpic, run, runEpic, RunInProgressError } from '../orchestrator/orchestrator';
import type { ApiRouter } from './router';

function beginStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function writeEvent(res: ServerResponse, event: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.write(`${JSON.stringify(event)}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function stream(
  res: ServerResponse,
  ctx: Ctx,
  target: string,
  task: (log: Log) => Promise<{ status: string }>,
): Promise<void> {
  if (ctx.store.activeRun(target)) {
    sendJson(res, 409, { error: 'run already in progress', running: true });
    return;
  }
  beginStream(res);
  const log: Log = (line) => writeEvent(res, { type: 'log', line });
  try {
    const result = await task(log);
    writeEvent(res, { type: 'done', status: result.status });
  } catch (err) {
    if (err instanceof RunInProgressError) {
      writeEvent(res, { type: 'error', message: err.message });
    } else {
      writeEvent(res, { type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

export function registerActionRoutes(router: ApiRouter): void {
  router.register('POST', '/tickets/:key/run', async (_req, res, ctx, params) => {
    const ticket = ctx.store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await stream(res, ctx, `ticket:${ticket.key}`, (log) => run(ctx, ticket.id, log));
  });

  router.register('POST', '/tickets/:key/land', async (_req, res, ctx, params) => {
    const ticket = ctx.store.getTicketByKey(params.key ?? '');
    if (!ticket) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await stream(res, ctx, `ticket:${ticket.key}`, (log) => land(ctx, ticket.id, log));
  });

  router.register('POST', '/epics/:key/run', async (_req, res, ctx, params) => {
    const epic = ctx.store.getEpicByKey(params.key ?? '');
    if (!epic) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await stream(res, ctx, `epic:${epic.key}`, (log) => runEpic(ctx, epic.id, log));
  });

  router.register('POST', '/epics/:key/plan', async (_req, res, ctx, params) => {
    const epic = ctx.store.getEpicByKey(params.key ?? '');
    if (!epic) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await stream(res, ctx, `epic:${epic.key}`, (log) => planEpic(ctx, epic.id, log));
  });

  router.register('POST', '/tickets/:key/cancel', (_req, res, ctx, params) => {
    const requested = cancelRun(ctx.store, `ticket:${params.key ?? ''}`);
    sendJson(res, requested ? 200 : 409, requested ? { cancelled: true } : { error: 'no run in progress' });
  });

  router.register('POST', '/epics/:key/cancel', (_req, res, ctx, params) => {
    const requested = cancelRun(ctx.store, `epic:${params.key ?? ''}`);
    sendJson(res, requested ? 200 : 409, requested ? { cancelled: true } : { error: 'no run in progress' });
  });
}
