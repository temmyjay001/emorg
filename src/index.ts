#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json';
import { cliSpecFor, resolveRunner } from './agents/registry';
import { DEFAULT_MODEL, ROLE_MODELS, ROLES } from './config';
import type { Ctx } from './ctx';
import { Store } from './db/store';
import { adviceFor, type Report } from './domain/report';
import { firstBuildState } from './domain/states';
import { epicLeadTimeMs, humanDuration, ticketLeadTimeMs } from './domain/timing';
import type { ArtifactKind, Ticket, TicketState } from './domain/types';
import { assertGitRepo, removeWorktree, worktreePath } from './git/worktree';
import { agentParticipants } from './meetings';
import { JiraClient } from './jira/client';
import { availableMemory } from './mem';
import {
  cancelRun,
  landRun,
  materializeEpic,
  performUnblock,
  planEpic,
  refreshEpicStatus,
  run,
  runEpic,
  RunInProgressError,
} from './orchestrator/orchestrator';
import { openBlockerWarning } from './orchestrator/schedule';
import { initProject, openProject, parseEmConfig, saveConfig, type Project } from './project';
import { serveMcpStdio } from './mcp/server';
import { listProjects, registerProject } from './registry';
import { sweepOrphans } from './sweep';
import { startServer } from './web/server';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const ACTIONABLE: TicketState[] = ['BACKLOG', 'DESIGN', 'READY', 'IN_PROGRESS', 'IN_REVIEW', 'UAT', 'READY_TO_LAND'];
const log = (m: string) => console.log(m);

const HELP = `em ${pkg.version} - the engineering manager

usage
  em <command> [arguments] [--json] [--help] [--version]

project
  em init                     set up .em/ in the current git repository
  em doctor                   check the environment and configuration
  em projects                 list projects registered with the dashboard
  em web [--port <n>]         start the web dashboard (serves every registered project)
  em mcp                      run em as an MCP server on stdio (for Claude Code, Zed, ...)
  em jira connect --site <url> --email <e> --projects <K1,K2> [--public-url <url>]
                              wire a Jira project to this board (assign issues to emorg)

tickets
  em new "<request>"          create a standalone ticket
  em run [<key>]              drive a ticket (or all actionable tickets) through the pipeline
  em approve <key>            approve a ticket's criteria and build it
  em reject <key> <feedback>  send the ticket back to the PM to revise on your feedback
  em unblock <key> <guidance> send a BLOCKED ticket back to work with your guidance
  em block <key> [reason]     abandon a ticket (-> BLOCKED)
  em close <key> <reason>     close a ticket that will not be built (-> CLOSED)
  em land [<key>]             land READY_TO_LAND tickets; retries a NEEDS_INTEGRATION ticket
  em cancel <key>             request cancellation of an in-progress run (EM- or EP-)
  em status [--json]          list epics and tickets
  em show <key> [ARTIFACT]    show a ticket; optionally print TICKET|PLAN|DIFF|REVIEW|UAT|GUIDANCE
  em meetings [--json]        list meetings
  em meetings <id> [--json]   show a meeting's transcript and minutes
  em report [--days <n>|--all] delivery, gates, and spend report (default: last 30 days)
  em clean                    remove leftover worktrees of DONE and BLOCKED tickets

epics
  em epic new "<goal>"        create an epic
  em epic plan <EP>           decompose the epic into proposed subtickets
  em epic approve <EP>        accept the breakdown, create subtickets, run their PMs
  em epic reject <EP> <fb>    send the plan back to the planner to revise
  em epic run <EP>            advance the epic's subtickets
  em epic show <EP> [plan]    show an epic and its subtickets
`;

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function loadEnv(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    void 0;
  }
}

function loadEnvOverride(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]!] = value;
  }
}

function openCtx(): Ctx {
  const reaped = sweepOrphans();
  if (reaped > 0) console.error(`reaped ${reaped} orphaned agent process${reaped === 1 ? '' : 'es'} from dead runs`);
  const project = openProject();
  loadEnvOverride(join(project.root, '.env'));
  const store = new Store(project.dbPath, {
    ticketPrefix: project.config.ticketPrefix,
    epicPrefix: project.config.epicPrefix,
  });
  const swept = store.sweepDeadRuns();
  if (swept.length > 0) console.error(`swept ${swept.length} interrupted run${swept.length === 1 ? '' : 's'}`);
  return { store, project };
}

function interruptedTicketKeys(store: Store): Set<string> {
  return new Set(
    store
      .interruptedTargets()
      .filter((target) => target.startsWith('ticket:'))
      .map((target) => target.slice('ticket:'.length)),
  );
}

function requireTicket(store: Store, key: string | undefined): Ticket {
  if (!key) fail('a ticket key is required, e.g. EM-1', 2);
  const t = store.getTicketByKey(key);
  if (!t) fail(`no ticket ${key}`);
  return t;
}

function requireEpic(store: Store, key: string | undefined) {
  if (!key) fail('an epic key is required, e.g. EP-1', 2);
  const e = store.getEpicByKey(key);
  if (!e) fail(`no epic ${key}`);
  return e;
}

function costLine(ctx: Ctx, ticketId: number): string | null {
  const runs = ctx.store.agentRunsForTicket(ticketId);
  if (runs.length === 0) return null;
  const total = ctx.store.ticketCostUsd(ticketId);
  const byRole = new Map<string, number>();
  for (const r of runs) byRole.set(r.role, (byRole.get(r.role) ?? 0) + r.costUsd);
  const parts = [...byRole.entries()].map(([role, usd]) => `${role} $${usd.toFixed(2)}`);
  return `cost: $${total.toFixed(2)} (${parts.join(', ')})`;
}

function timeLine(lead: number | null, agentMs: number): string | null {
  const parts: string[] = [];
  if (lead !== null) parts.push(`lead ${humanDuration(lead)}`);
  if (agentMs > 0) parts.push(`agents ${humanDuration(agentMs)}`);
  return parts.length ? `time: ${parts.join(', ')}` : null;
}

async function runTargets(ctx: Ctx, targets: Ticket[]): Promise<void> {
  for (const t of targets) {
    try {
      const final = await run(ctx, t.id, log);
      if (final.epicId) refreshEpicStatus(ctx.store, final.epicId, log);
      console.log(`${final.key}: ${final.status}`);
    } catch (err) {
      if (err instanceof RunInProgressError) console.error(`${t.key}: ${err.message}`);
      else console.error(`${t.key}: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnv('.env');

  const parsed = (() => {
    try {
      return parseArgs({
        args: process.argv.slice(2),
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'V' },
          json: { type: 'boolean' },
          port: { type: 'string' },
          site: { type: 'string' },
          email: { type: 'string' },
          projects: { type: 'string' },
          label: { type: 'string' },
          'public-url': { type: 'string' },
          days: { type: 'string' },
          all: { type: 'boolean' },
        },
        allowPositionals: true,
      });
    } catch (err) {
      fail(`${(err as Error).message}\n\nRun em --help for usage.`, 2);
    }
  })();

  const { values, positionals } = parsed;
  if (values.version) {
    console.log(pkg.version);
    return;
  }
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === 'init') {
    const { project, created } = initProject();
    registerProject(project.root);
    console.log(created ? `Initialized ${project.emDir}` : `Already initialized: ${project.emDir}`);
    console.log(`config: ${project.configPath}`);
    return;
  }

  if (cmd === 'projects') {
    const projects = listProjects();
    if (projects.length === 0) {
      console.log('No projects registered. Run em init inside a repository.');
      return;
    }
    for (const p of projects) console.log(`  ${p.name.padEnd(24)} ${p.root}`);
    return;
  }

  if (cmd === 'doctor') {
    doctor();
    return;
  }

  if (cmd === 'mcp') {
    const ctx = openCtx();
    try {
      await serveMcpStdio(ctx);
    } finally {
      ctx.store.close();
    }
    return;
  }

  if (cmd === 'web') {
    const port = values.port ? Number(values.port) : undefined;
    if (values.port && (!Number.isFinite(port) || port! <= 0)) fail('--port must be a positive number', 2);
    startServer(port);
    return;
  }

  const ctx = openCtx();
  const { store } = ctx;

  try {
    if (cmd === 'epic') {
      await epicCommand(ctx, rest, values.json ?? false);
      return;
    }

    switch (cmd) {
      case 'new': {
        const description = rest.join(' ').trim();
        if (!description) fail('em new needs a request, e.g. em new "Add a dark mode toggle"', 2);
        const ticket = store.createTicket({ title: '', description });
        console.log(`Created ${ticket.key} (BACKLOG). Run: em run ${ticket.key}`);
        break;
      }

      case 'run': {
        assertGitRepo(ctx.project);
        const key = rest[0];
        if (key) {
          const t = requireTicket(store, key);
          const warning = openBlockerWarning(t.key, store.openBlockersFor(t.id));
          if (warning) console.error(warning);
          await runTargets(ctx, [t]);
          break;
        }
        const targets = store.ticketsInStatuses(ACTIONABLE).filter((t) => store.openBlockersFor(t.id).length === 0);
        if (targets.length === 0) {
          console.log('Nothing to run.');
          break;
        }
        const interrupted = interruptedTicketKeys(store);
        for (const t of targets) {
          if (interrupted.has(t.key)) console.log(`Resuming interrupted ${t.key} (cut at ${t.status})`);
        }
        await runTargets(ctx, targets);
        break;
      }

      case 'approve': {
        const t = requireTicket(store, rest[0]);
        if (t.status !== 'AWAIT_APPROVAL') fail(`${t.key} is ${t.status}, not awaiting approval`);
        store.transition({
          ticketId: t.id,
          from: t.status,
          to: firstBuildState(ctx.project.config.pipeline),
          role: null,
          verdict: 'PASS',
          note: 'approved',
        });
        console.log(`${t.key} approved.`);
        assertGitRepo(ctx.project);
        await runTargets(ctx, [t]);
        break;
      }

      case 'reject': {
        const t = requireTicket(store, rest[0]);
        if (t.status !== 'AWAIT_APPROVAL') fail(`${t.key} is ${t.status}, not awaiting approval`);
        const feedback = rest.slice(1).join(' ').trim();
        if (!feedback) fail('em reject needs feedback for the PM, e.g. em reject EM-3 "split criterion 4 in two"', 2);
        store.setFeedback(t.id, feedback);
        store.transition({ ticketId: t.id, from: t.status, to: 'BACKLOG', role: null, verdict: 'FAIL', note: feedback });
        console.log(`${t.key} sent back to the PM. Revising...`);
        const final = await run(ctx, t.id, log);
        console.log(`${final.key}: ${final.status} (em show ${final.key})`);
        break;
      }

      case 'unblock': {
        const t = requireTicket(store, rest[0]);
        if (t.status !== 'BLOCKED') fail(`${t.key} is ${t.status}, not blocked`);
        const guidance = rest.slice(1).join(' ').trim();
        if (!guidance) fail('em unblock needs guidance, e.g. em unblock EM-3 "use the existing auth middleware"', 2);
        const to = performUnblock(ctx, t, guidance);
        console.log(`${t.key} -> ${to}. Resuming...`);
        assertGitRepo(ctx.project);
        await runTargets(ctx, [t]);
        break;
      }

      case 'block': {
        const t = requireTicket(store, rest[0]);
        const reason = rest.slice(1).join(' ') || 'blocked';
        store.transition({ ticketId: t.id, from: t.status, to: 'BLOCKED', role: null, verdict: 'FAIL', note: reason });
        console.log(`${t.key} -> BLOCKED (${reason})`);
        break;
      }

      case 'jira': {
        if (rest[0] !== 'connect') fail('usage: em jira connect --site <url> --email <e> --projects <K1,K2> [--public-url <url>]', 2);
        const site = values.site;
        const email = values.email;
        const projects = values.projects;
        if (!site || !email || !projects) fail('em jira connect needs --site, --email, and --projects', 2);
        const projectKeys = projects.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
        const token = process.env.JIRA_API_TOKEN;
        if (!token) fail('set JIRA_API_TOKEN in the project .env first (an Atlassian API token for the connecting account)', 2);
        const client = new JiraClient({ site, email, token });
        let accountId: string;
        try {
          const me = await client.myself();
          accountId = me.accountId;
          console.log(`Authenticated as ${me.displayName}.`);
        } catch (err) {
          fail(`Jira authentication failed: ${(err as Error).message}`);
        }
        let secret = process.env.JIRA_WEBHOOK_SECRET;
        if (!secret) {
          secret = randomBytes(24).toString('hex');
          const envPath = join(ctx.project.root, '.env');
          const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
          writeFileSync(envPath, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}JIRA_WEBHOOK_SECRET=${secret}\n`);
          process.env.JIRA_WEBHOOK_SECRET = secret;
          console.log('Generated JIRA_WEBHOOK_SECRET and saved it to .env.');
        }
        const jira = {
          site,
          email,
          tokenEnv: 'JIRA_API_TOKEN',
          webhookSecretEnv: 'JIRA_WEBHOOK_SECRET',
          projectKeys,
          triggerLabel: values.label ?? 'emorg',
          triggerAccountId: accountId,
          statusMap: ctx.project.config.jira?.statusMap ?? {},
          evidenceUpload: true,
        };
        const parsedCfg = parseEmConfig({ ...JSON.parse(readFileSync(ctx.project.configPath, 'utf8')), jira });
        if ('error' in parsedCfg) fail(`config invalid: ${parsedCfg.error}`);
        saveConfig(ctx.project, parsedCfg.config);
        console.log(`Connected ${projectKeys.join(', ')} on ${site} (trigger: assignee ${accountId} or label "${jira.triggerLabel}").`);
        const publicUrl = values['public-url'];
        if (publicUrl) {
          try {
            await client.registerWebhook(publicUrl, projectKeys, secret);
            console.log(`Webhook registered: ${publicUrl.replace(/\/+$/, '')}/webhooks/jira`);
          } catch (err) {
            console.error(`Automatic webhook registration failed (${(err as Error).message}).`);
            console.error(`Register it manually in Jira settings: ${publicUrl.replace(/\/+$/, '')}/webhooks/jira?secret=<JIRA_WEBHOOK_SECRET>, events: issue created, issue updated, comment created.`);
          }
        } else {
          console.log('No --public-url given: register the webhook in Jira settings pointing at <your public em web URL>/webhooks/jira?secret=<JIRA_WEBHOOK_SECRET>.');
        }
        console.log('Start em web (and expose it publicly or via a tunnel), then assign an issue to the emorg account to begin.');
        break;
      }

      case 'close': {
        const t = requireTicket(store, rest[0]);
        if (t.status === 'DONE' || t.status === 'CLOSED') fail(`${t.key} is already ${t.status}`);
        const reason = rest.slice(1).join(' ').trim();
        if (!reason) fail('em close needs a reason, e.g. em close EM-20 "superseded by EM-34"', 2);
        store.transition({ ticketId: t.id, from: t.status, to: 'CLOSED', role: null, verdict: null, note: reason });
        console.log(`${t.key} -> CLOSED (${reason})`);
        break;
      }

      case 'land': {
        assertGitRepo(ctx.project);
        const key = rest[0];
        let targets: Ticket[];
        if (key) {
          const t = requireTicket(store, key);
          if (t.status !== 'READY_TO_LAND' && t.status !== 'NEEDS_INTEGRATION') {
            fail(`${t.key} is ${t.status}; only READY_TO_LAND or NEEDS_INTEGRATION tickets can land`);
          }
          if (t.status === 'NEEDS_INTEGRATION') {
            store.transition({
              ticketId: t.id,
              from: t.status,
              to: 'READY_TO_LAND',
              role: null,
              verdict: null,
              note: 'landing retried',
            });
          }
          targets = [store.getTicketById(t.id)!];
        } else {
          targets = store.ticketsInStatuses(['READY_TO_LAND']);
        }
        if (targets.length === 0) {
          console.log('Nothing to land.');
          break;
        }
        for (const t of targets) {
          const res = await landRun(ctx, t.id, log);
          console.log(`${t.key}: ${res.status}${res.status === 'DONE' ? '' : ` (${res.message})`}`);
          if (t.epicId !== null) refreshEpicStatus(store, t.epicId, log);
        }
        break;
      }

      case 'cancel': {
        const key = rest[0];
        if (!key) fail('a ticket or epic key is required, e.g. em cancel EM-1', 2);
        let target: string;
        if (store.getTicketByKey(key)) target = `ticket:${key}`;
        else if (store.getEpicByKey(key)) target = `epic:${key}`;
        else {
          fail(`no ticket or epic ${key}`);
        }
        const requested = cancelRun(store, target);
        console.log(requested ? `${key}: cancellation requested` : `${key}: no run in progress`);
        break;
      }

      case 'status': {
        status(ctx, values.json ?? false);
        break;
      }

      case 'report': {
        const windowDays = values.all ? null : Number(values.days ?? '30');
        if (windowDays !== null && (!Number.isInteger(windowDays) || windowDays <= 0)) {
          fail('--days must be a positive integer', 2);
        }
        const report = store.buildReport(windowDays, ctx.project.config.monthlyBudgetUsd);
        const roleModels = Object.fromEntries(
          Object.entries(ctx.project.config.roles).map(([role, o]) => [role, o.model ?? (ROLE_MODELS as Record<string, string>)[role]]),
        );
        printReport(report, adviceFor(report, roleModels, DEFAULT_MODEL), values.json ?? false);
        break;
      }

      case 'show': {
        showTicket(ctx, rest, values.json ?? false);
        break;
      }

      case 'meetings': {
        if (rest[0]) meetingDetail(ctx, rest[0], values.json ?? false);
        else meetings(ctx, values.json ?? false);
        break;
      }

      case 'clean': {
        clean(ctx);
        break;
      }

      default:
        fail(`Unknown command: ${cmd}\n\n${HELP}`, 2);
    }
  } finally {
    store.close();
  }
}

function printReport(report: Report, advice: string[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ ...report, advice }, null, 2));
    return;
  }
  const money = (n: number) => `$${n.toFixed(2)}`;
  const pct = (part: number, whole: number) => (whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`);
  console.log(`Report: ${report.windowDays === null ? 'all time' : `last ${report.windowDays} days`}`);
  console.log(`Lifetime: ${report.lifetime.totalTokens.toLocaleString()} tokens across ${report.lifetime.runs.toLocaleString()} runs`);

  const t = report.tickets;
  console.log('\ndelivery');
  console.log(`  done ${t.done}   open ${t.open}   blocked ${t.blocked}`);
  if (t.leadTime) {
    console.log(
      `  lead time  avg ${humanDuration(t.leadTime.avgMs)}   p50 ${humanDuration(t.leadTime.p50Ms)}   p90 ${humanDuration(t.leadTime.p90Ms)}`,
    );
  }
  if (t.agentTimeMs > 0) console.log(`  agent time ${humanDuration(t.agentTimeMs)} total`);
  if (t.done > 0) {
    const attempts = t.avgAttempts === null ? '' : `   avg attempts ${t.avgAttempts.toFixed(1)}`;
    console.log(`  first pass ${t.firstPass}/${t.done} (${pct(t.firstPass, t.done)})${attempts}`);
  }

  if (report.throughput.length > 0) {
    console.log('\nthroughput');
    const max = Math.max(...report.throughput.map((b) => b.done));
    for (const { bucket, done } of report.throughput) {
      console.log(`  ${bucket}  ${'#'.repeat(Math.max(1, Math.round((done / max) * 24)))} ${done}`);
    }
  }

  const g = report.gates;
  const caught = g.reviewFails + g.uatFails;
  console.log('\ngates');
  console.log(`  defects caught ${caught} (review ${g.reviewFails}, uat ${g.uatFails})`);
  console.log(`  human rejections ${g.humanRejections}   auto-approvals ${g.autoApprovals}`);

  const s = report.spend;
  console.log('\nspend');
  const perTicket = s.perDoneTicketUsd === null ? '' : `   per done ticket ${money(s.perDoneTicketUsd)}`;
  console.log(`  total ${money(s.totalUsd)}${perTicket}`);
  const line = (label: string, rows: { key: string; usd: number }[]) => {
    if (rows.length) console.log(`  by ${label}  ${rows.map((r) => `${r.key} ${money(r.usd)}`).join(', ')}`);
  };
  line('role', s.byRole);
  line('runner', s.byRunner);
  line('model', s.byModel);
  if (s.inputTokens > 0 || s.outputTokens > 0 || s.cacheReadTokens > 0 || s.cacheWriteTokens > 0) {
    console.log(
      `  tokens ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out / ${s.cacheReadTokens.toLocaleString()} cache read / ${s.cacheWriteTokens.toLocaleString()} cache write`,
    );
  }
  if (s.tokensByRole.length > 0) {
    console.log('  tokens by role');
    for (const row of s.tokensByRole) {
      console.log(
        `    ${row.role.padEnd(10)} in ${row.inputTokens.toLocaleString()}  out ${row.outputTokens.toLocaleString()}  cache read ${row.cacheReadTokens.toLocaleString()}  cache write ${row.cacheWriteTokens.toLocaleString()}`,
      );
    }
  }

  if (report.month.budgetUsd !== null || report.month.spentUsd > 0) {
    const budget = report.month.budgetUsd === null ? '' : ` of $${report.month.budgetUsd.toFixed(2)} budget`;
    console.log(`  this month $${report.month.spentUsd.toFixed(2)}${budget}`);
  }

  if (advice.length > 0) {
    console.log('\nadvice');
    for (const line of advice) console.log(`  ${line}`);
  }

  const r = report.runs;
  console.log('\nruns');
  console.log(`  ${r.total} agent runs, ${r.errors} errors`);
  for (const row of r.byRole) {
    const errors = row.errors > 0 ? `, ${row.errors} errors` : '';
    console.log(`  ${row.role.padEnd(10)} ${String(row.runs).padStart(3)} runs, avg ${humanDuration(row.avgDurationMs)}${errors}`);
  }
}

function status(ctx: Ctx, asJson: boolean): void {
  const { store } = ctx;
  const epics = store.listEpics();
  const tickets = store.listTickets();
  const interrupted = interruptedTicketKeys(store);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          epics: epics.map((e) => ({ ...e, subtickets: store.getSubtickets(e.id).map((t) => t.key) })),
          tickets: tickets.map((t) => ({ ...t, costUsd: store.ticketCostUsd(t.id), interrupted: interrupted.has(t.key) })),
          totalCostUsd: store.totalCostUsd(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (epics.length) {
    console.log('epics:');
    for (const e of epics) {
      const subs = store.getSubtickets(e.id);
      const done = subs.filter((s) => s.status === 'DONE' || s.status === 'CLOSED').length;
      const prog = subs.length ? ` ${done}/${subs.length}` : '';
      console.log(`  ${e.key.padEnd(8)} ${e.status.padEnd(10)}${prog}  ${e.title}`);
    }
    console.log('');
  }
  if (tickets.length === 0 && epics.length === 0) {
    console.log('No tickets. Create one: em new "<request>"');
    return;
  }
  for (const t of tickets) {
    const tag = t.epicId ? `${store.getEpicById(t.epicId)?.key ?? '?'}#${t.seq} ` : '';
    const a = t.attempt > 0 ? ` attempt:${t.attempt}` : '';
    const warn = interrupted.has(t.key) ? `  ⚠ interrupted at ${t.status}` : '';
    console.log(`  ${t.key.padEnd(8)} ${t.status.padEnd(14)}${a}  ${tag}${t.title || t.description.slice(0, 50)}${warn}`);
  }
}

function showTicket(ctx: Ctx, rest: string[], asJson: boolean): void {
  const { store } = ctx;
  const t = requireTicket(store, rest[0]);
  const artifactKind = rest[1]?.toUpperCase() as ArtifactKind | undefined;
  if (artifactKind === 'EVIDENCE') {
    const evidence = store.getArtifacts(t.id).filter((a) => a.kind === 'EVIDENCE');
    if (evidence.length === 0) {
      console.log(`No EVIDENCE artifacts for ${t.key}`);
      return;
    }
    for (const a of evidence) {
      const meta = a.data ? (JSON.parse(a.data) as { name?: string; mime?: string }) : {};
      const kb = Math.ceil((a.content.length * 3) / 4 / 1024);
      console.log(`${meta.name ?? `evidence-v${a.version}`}  ${meta.mime ?? 'image'}  ~${kb} KB  (view in the dashboard)`);
    }
    return;
  }
  if (artifactKind) {
    const a = store.latestArtifact(t.id, artifactKind);
    console.log(a ? a.content : `No ${artifactKind} artifact for ${t.key}`);
    return;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...t,
          criteria: store.getCriteria(t.id),
          transitions: store.listTransitions(t.id),
          artifacts: store.getArtifacts(t.id).map(({ content, ...rest }) => ({ ...rest, bytes: content.length })),
          agentRuns: store.agentRunsForTicket(t.id),
          costUsd: store.ticketCostUsd(t.id),
          leadTimeMs: ticketLeadTimeMs(t, store.listTransitions(t.id)),
          agentTimeMs: store.ticketAgentTimeMs(t.id),
        },
        null,
        2,
      ),
    );
    return;
  }

  const epic = t.epicId ? store.getEpicById(t.epicId) : undefined;
  const epicTag = epic ? `  (${epic.key} #${t.seq})` : '';
  console.log(`${t.key}  ${t.status}  attempt:${t.attempt}${epicTag}`);
  console.log(`title: ${t.title || '(untitled)'}`);
  if (t.hasUi) console.log(`ui: run "${t.runCommand}" at ${t.appUrl}`);
  if (t.feedback) console.log(`pending feedback: ${t.feedback}`);
  const cost = costLine(ctx, t.id);
  if (cost) console.log(cost);
  const time = timeLine(ticketLeadTimeMs(t, store.listTransitions(t.id)), store.ticketAgentTimeMs(t.id));
  if (time) console.log(time);
  console.log(`\nrequest:\n${t.description}`);

  const criteria = store.getCriteria(t.id);
  if (criteria.length) {
    console.log('\nacceptance criteria:');
    for (const c of criteria) console.log(`  ${c.met ? '[x]' : '[ ]'} ${c.idx}. ${c.isUi ? '(UI) ' : ''}${c.text}`);
  }

  const transitions = store.listTransitions(t.id);
  if (transitions.length) {
    console.log('\nhistory:');
    for (const tr of transitions) {
      const v = tr.verdict ? ` [${tr.verdict}]` : '';
      console.log(`  ${tr.createdAt}  ${tr.fromState} -> ${tr.toState}  ${tr.role ?? 'human'}${v}  ${tr.note ?? ''}`);
    }
  }

  const artifacts = store.getArtifacts(t.id);
  const seen = new Set<string>();
  const kinds = artifacts.filter((a) => (seen.has(a.kind) ? false : (seen.add(a.kind), true)));
  if (kinds.length) {
    console.log('\nartifacts:');
    for (const a of kinds) console.log(`  ${a.kind}  em show ${t.key} ${a.kind}`);
  }
}

function meetings(ctx: Ctx, asJson: boolean): void {
  const { store } = ctx;
  const list = store.listMeetings().map((m) => ({
    id: m.id,
    title: m.title,
    participants: agentParticipants(m),
    status: m.status,
    messageCount: store.meetingMessages(m.id).length,
  }));

  if (asJson) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (list.length === 0) {
    console.log('No meetings.');
    return;
  }
  for (const m of list) {
    console.log(`  ${m.id}  ${m.title}  [${m.participants.join(', ')}]  ${m.status}  ${m.messageCount} msgs`);
  }
}

function meetingDetail(ctx: Ctx, idArg: string, asJson: boolean): void {
  const { store } = ctx;
  const id = Number(idArg);
  const meeting = Number.isFinite(id) ? store.getMeeting(id) : undefined;
  if (!meeting) fail(`no meeting ${idArg}`);
  const messages = store.meetingMessages(meeting.id).map((m) => ({ speaker: m.speaker, text: m.text }));
  const minutes = meeting.status === 'ENDED' ? meeting.summary : null;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          id: meeting.id,
          title: meeting.title,
          participants: meeting.participants,
          status: meeting.status,
          minutes,
          messages,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${meeting.id}  ${meeting.title}  [${meeting.participants.join(', ')}]  ${meeting.status}`);
  console.log('\ntranscript:');
  if (messages.length === 0) {
    console.log('  (no messages yet)');
  } else {
    for (const m of messages) console.log(`  ${m.speaker}: ${m.text}`);
  }
  console.log('');
  if (minutes !== null) console.log(`minutes:\n${minutes}`);
  else console.log('no minutes yet');
}

function clean(ctx: Ctx): void {
  const { store, project } = ctx;
  assertGitRepo(project);
  let removed = 0;
  for (const t of store.ticketsInStatuses(['DONE', 'BLOCKED', 'CLOSED'])) {
    if (!existsSync(worktreePath(project, t.key))) continue;
    removeWorktree(project, t.key, { deleteBranch: t.status === 'DONE' });
    console.log(`removed worktree ${t.key}${t.status === 'DONE' ? '' : ' (branch kept)'}`);
    removed += 1;
  }
  if (removed === 0) {
    console.log('Nothing to clean.');
    return;
  }
  const plural = removed === 1 ? '' : 's';
  console.log(`Cleaned ${removed} worktree${plural}.`);
}

function doctor(): void {
  let failures = 0;
  let warnings = 0;
  const ok = (msg: string) => console.log(`  ok    ${msg}`);
  const warn = (msg: string) => {
    console.log(`  warn  ${msg}`);
    warnings += 1;
  };
  const bad = (msg: string) => {
    console.log(`  fail  ${msg}`);
    failures += 1;
  };

  console.log('em doctor\n');

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! > 20 || (major === 20 && minor! >= 12)) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} (need >= 20.12)`);

  try {
    const v = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
    ok(v);
  } catch {
    bad('git not found on PATH');
  }

  let project: Project | undefined;
  try {
    project = openProject();
    ok(`project root: ${project.root}`);
  } catch (err) {
    bad((err as Error).message);
  }

  if (project) {
    try {
      assertGitRepo(project);
      ok('project root is a git repository');
    } catch (err) {
      bad((err as Error).message);
    }
    let store: Store | undefined;
    try {
      store = new Store(project.dbPath);
      ok(`database: ${project.dbPath}`);
    } catch (err) {
      bad(`database: ${(err as Error).message}`);
    }
    if (store) {
      const swept = store.sweepDeadRuns();
      if (swept.length > 0) ok(`swept ${swept.length} interrupted run${swept.length === 1 ? '' : 's'}`);
      for (const key of interruptedTicketKeys(store)) {
        const ticket = store.getTicketByKey(key);
        if (ticket) warn(`${ticket.key}: interrupted at ${ticket.status}; resume with em run ${ticket.key}`);
      }
      store.close();
    }
    ok(`merge strategy: ${project.config.mergeStrategy}`);
    checkRunners(project, { ok, warn, bad });
    if (project.config.mergeStrategy === 'pr') {
      try {
        execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        ok('gh CLI available for PR creation');
      } catch {
        bad('mergeStrategy is "pr" but the gh CLI is not on PATH');
      }
    }
  }

  if (process.env.ANTHROPIC_API_KEY) ok('ANTHROPIC_API_KEY is set');
  else {
    let loggedIn = false;
    try {
      execFileSync('claude', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      loggedIn = existsSync(join(os.homedir(), '.claude.json')) || existsSync(join(os.homedir(), '.claude', '.credentials.json'));
    } catch {
      /* claude CLI not installed */
    }
    if (loggedIn) ok('no ANTHROPIC_API_KEY, but a Claude Code login is present');
    else warn('no ANTHROPIC_API_KEY and no Claude Code login found; claude runners will not authenticate until one exists');
  }

  console.log('');
  if (failures > 0) fail(`${failures} check${failures === 1 ? '' : 's'} failed.`);
  if (warnings > 0) console.log(`Passed with ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  else console.log('All checks passed.');
  const freeGb = availableMemory() / 1024 ** 3;
  const totalGb = os.totalmem() / 1024 ** 3;
  const headroom = Math.max(1, Math.floor((freeGb - 2) / 2.5));
  console.log(`  mem   ${freeGb.toFixed(1)}GB free of ${totalGb.toFixed(1)}GB`);
  if (headroom < 3) {
    console.log(`  hint  limited memory headroom: maxConcurrentAgents ${headroom} or lower is safer on this machine (browser UAT is the heaviest load)`);
  }
}

interface DoctorReport {
  ok: (msg: string) => void;
  warn: (msg: string) => void;
  bad: (msg: string) => void;
}

function checkRunners(project: Project, report: DoctorReport): void {
  const runnerIds = new Set(
    ROLES.flatMap((role) => {
      const runner = project.config.roles[role]?.runner;
      return runner ? [runner] : [];
    }),
  );
  for (const id of runnerIds) {
    try {
      resolveRunner(project.config, id);
    } catch (err) {
      report.bad((err as Error).message);
      continue;
    }
    const spec = cliSpecFor(project.config, id);
    if (!spec) {
      report.ok(`runner ${id}: built-in`);
      continue;
    }
    try {
      execFileSync('which', [spec.command], { stdio: ['ignore', 'pipe', 'ignore'] });
      report.ok(`runner ${id}: ${spec.command} found on PATH`);
    } catch {
      report.bad(`runner ${id}: command "${spec.command}" not found on PATH`);
    }
  }
  for (const role of ROLES) {
    const override = project.config.roles[role];
    if (!override?.runner || override.runner.startsWith('claude') || override.model) continue;
    report.warn(
      `role ${role} uses runner ${override.runner} without a model override; the built-in default (${ROLE_MODELS[role]}) is a Claude id and will likely be rejected`,
    );
  }
}

async function epicCommand(ctx: Ctx, rest: string[], asJson: boolean): Promise<void> {
  const { store } = ctx;
  const [sub, ...args] = rest;
  switch (sub) {
    case 'new': {
      const goal = args.join(' ').trim();
      if (!goal) fail('em epic new needs a goal, e.g. em epic new "Build the web dashboard"', 2);
      const epic = store.createEpic({ title: goal.slice(0, 80), description: goal });
      console.log(`Created ${epic.key} (PLANNING). Plan it: em epic plan ${epic.key}`);
      break;
    }

    case 'plan':
    case 'run': {
      assertGitRepo(ctx.project);
      const e = requireEpic(store, args[0]);
      try {
        const final = await runEpic(ctx, e.id, log);
        console.log(`${final.key}: ${final.status}`);
        if (final.status === 'AWAIT_PLAN') printEpicPlan(store, final.id);
      } catch (err) {
        if (err instanceof RunInProgressError) fail(err.message);
        throw err;
      }
      break;
    }

    case 'approve': {
      assertGitRepo(ctx.project);
      const e = requireEpic(store, args[0]);
      if (e.status !== 'AWAIT_PLAN') fail(`${e.key} is ${e.status}, no plan to approve`);
      const subs = materializeEpic(store, e.id);
      console.log(`${e.key} approved. ${subs.length} subtickets created. Running their PMs...`);
      const final = await runEpic(ctx, e.id, log);
      console.log(`${final.key}: ${final.status}`);
      break;
    }

    case 'reject': {
      assertGitRepo(ctx.project);
      const e = requireEpic(store, args[0]);
      if (e.status !== 'AWAIT_PLAN') fail(`${e.key} is ${e.status}, no plan to reject`);
      const feedback = args.slice(1).join(' ').trim();
      if (!feedback) fail('em epic reject needs feedback, e.g. em epic reject EP-1 "merge tickets 2 and 3"', 2);
      store.setEpicFeedback(e.id, feedback);
      store.setEpicStatus(e.id, 'PLANNING');
      console.log(`${e.key} sent back to the planner. Re-planning...`);
      const final = await planEpic(ctx, e.id, log);
      if (final.status === 'AWAIT_PLAN') printEpicPlan(store, final.id);
      break;
    }

    case 'show': {
      const e = requireEpic(store, args[0]);
      if (args[1] === 'plan') {
        console.log(e.plan ?? '(no plan yet)');
        break;
      }
      if (asJson) {
        console.log(
          JSON.stringify(
            {
              ...e,
              subtickets: store.getSubtickets(e.id),
              costUsd: store.epicCostUsd(e.id),
              leadTimeMs: epicLeadTimeMs(e),
              agentTimeMs: store.epicAgentTimeMs(e.id),
            },
            null,
            2,
          ),
        );
        break;
      }
      console.log(`${e.key}  ${e.status}`);
      console.log(`title: ${e.title}`);
      const cost = store.epicCostUsd(e.id);
      if (cost > 0) console.log(`cost: $${cost.toFixed(2)}`);
      const time = timeLine(epicLeadTimeMs(e), store.epicAgentTimeMs(e.id));
      if (time) console.log(time);
      console.log(`\ngoal:\n${e.description}`);
      const subs = store.getSubtickets(e.id);
      if (subs.length) {
        console.log('\nsubtickets:');
        for (const s of subs) console.log(`  ${s.seq}. ${s.key.padEnd(8)} ${s.status.padEnd(14)} ${s.title || s.description.slice(0, 50)}`);
      } else if (e.plan) {
        printEpicPlan(store, e.id);
      }
      break;
    }

    default:
      fail(`Unknown epic command: ${sub ?? '(none)'}\n\n${HELP}`, 2);
  }
}

function printEpicPlan(store: Store, epicId: number): void {
  const e = store.getEpicById(epicId);
  console.log(e?.plan ? `\n${e.plan}` : '\n(no plan)');
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
