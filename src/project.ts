import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from './config';
import { DEFAULT_PIPELINE, validatePipeline } from './domain/states';

export const EM_DIR_NAME = '.em';

const roleOverrideSchema = z.strictObject({
  runner: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  escalation: z.array(z.string().min(1)).min(1).optional(),
  mcpServers: z.array(z.string()).optional(),
});

const mcpStdioServerSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const mcpRemoteServerSchema = z.strictObject({
  type: z.enum(['sse', 'http']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
});

const mcpServerSchema = z.union([mcpStdioServerSchema, mcpRemoteServerSchema]);

const cliRunnerSpecSchema = z.strictObject({
  kind: z.enum(['generic', 'claude', 'codex', 'gemini', 'opencode', 'acp']).default('generic'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptVia: z.enum(['stdin', 'arg']).default('stdin'),
  enforcesReadOnly: z.boolean().default(false),
  browser: z.boolean().default(false),
  timeoutMinutes: z.number().positive().default(30),
  env: z.record(z.string(), z.string()).default({}),
});

const jiraConfigSchema = z.strictObject({
  site: z.string().min(1),
  email: z.string().min(1),
  tokenEnv: z.string().min(1).default('JIRA_API_TOKEN'),
  webhookSecretEnv: z.string().min(1).default('JIRA_WEBHOOK_SECRET'),
  projectKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]*$/)).min(1),
  triggerLabel: z.string().min(1).default('emorg'),
  triggerAccountId: z.string().nullable().default(null),
  statusMap: z.record(z.string(), z.string()).default({}),
  evidenceUpload: z.boolean().default(true),
});

const configSchema = z
  .strictObject({
    jira: jiraConfigSchema.nullable().default(null),
    runCommand: z.string().nullable().default(null),
    appUrl: z.string().nullable().default(null),
    verifyCommand: z.string().nullable().default(null),
    mergeStrategy: z.enum(['merge', 'pr', 'none']).default('merge'),
    ticketPrefix: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'must be 1-10 uppercase letters/digits starting with a letter')
      .default('EM'),
    epicPrefix: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'must be 1-10 uppercase letters/digits starting with a letter')
      .default('EP'),
    baseBranch: z.string().nullable().default(null),
    maxParallelSubtickets: z.number().int().min(1).max(8).default(3),
    maxConcurrentAgents: z.number().int().min(1).max(16).default(3),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    idleTimeoutMinutes: z.number().positive().default(DEFAULT_IDLE_TIMEOUT_MINUTES),
    maxTicketBudgetUsd: z.number().positive().nullable().default(null),
    monthlyBudgetUsd: z.number().positive().nullable().default(null),
    meetingModel: z.string().nullable().default(null),
    meetingMaxTurns: z.number().int().positive().nullable().default(null),
    approvalMode: z.enum(['always', 'epic-once', 'never']).default('always'),
    autoResumeInterrupted: z.boolean().default(false),
    opencodeServerUrl: z.string().nullable().default(null),
    conventionFiles: z.array(z.string().min(1)).default(['CLAUDE.md', 'AGENTS.md']),
    otelEndpoint: z.string().nullable().default(null),
    otelHeaders: z.record(z.string(), z.string()).default({}),
    mcpServers: z
      .record(z.string().regex(/^[a-zA-Z][\w-]*$/, 'MCP server names must be alphanumeric with dashes/underscores'), mcpServerSchema)
      .default({}),
    pipeline: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/, 'stage names are lowercase letters, digits, and dashes'))
      .default([...DEFAULT_PIPELINE])
      .superRefine((pipeline, ctx) => {
        const error = validatePipeline(pipeline);
        if (error) ctx.addIssue({ code: 'custom', message: error });
      }),
    roles: z.record(z.string(), roleOverrideSchema).default({}),
    runners: z.record(z.string(), cliRunnerSpecSchema).default({}),
  })
  .refine((c) => c.ticketPrefix !== c.epicPrefix, {
    message: 'ticketPrefix and epicPrefix must differ so ticket and epic keys stay distinguishable',
    path: ['epicPrefix'],
  });

export type EmConfig = z.infer<typeof configSchema>;
export type RoleOverride = z.infer<typeof roleOverrideSchema>;
export type CliRunnerSpec = z.infer<typeof cliRunnerSpecSchema>;
export type McpServerSpec = z.infer<typeof mcpServerSchema>;
export const parseCliRunnerSpec = (raw: unknown): CliRunnerSpec => cliRunnerSpecSchema.parse(raw);

export function parseEmConfig(raw: unknown): { config: EmConfig } | { error: string } {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { error: issues };
  }
  return { config: parsed.data };
}

export function saveConfig(project: Project, config: EmConfig): void {
  writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`);
  project.config = config;
}

export interface Project {
  root: string;
  emDir: string;
  dbPath: string;
  worktreesDir: string;
  scratchDir: string;
  configPath: string;
  config: EmConfig;
}

function gitToplevel(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function findProjectRoot(from = process.cwd()): string | null {
  const override = process.env.EM_TARGET_REPO;
  if (override) return resolve(override);
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, EM_DIR_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitToplevel(from);
}

const EM_GITIGNORE = 'eng.db*\nworktrees/\nscratch/\ncache/\n';

function loadConfig(configPath: string): EmConfig {
  if (!existsSync(configPath)) return configSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${configPath} is invalid: ${issues}`);
  }
  return parsed.data;
}

export function projectAt(root: string): Project {
  const emDir = join(root, EM_DIR_NAME);
  mkdirSync(emDir, { recursive: true });
  const gitignorePath = join(emDir, '.gitignore');
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, EM_GITIGNORE);
  const configPath = join(emDir, 'config.json');
  return {
    root,
    emDir,
    dbPath: join(emDir, 'eng.db'),
    worktreesDir: join(emDir, 'worktrees'),
    scratchDir: join(emDir, 'scratch'),
    configPath,
    config: loadConfig(configPath),
  };
}

export function openProject(from = process.cwd()): Project {
  const root = findProjectRoot(from);
  if (!root) {
    throw new Error(
      'No project found. Run em inside a git repository (em init to set it up), or set EM_TARGET_REPO.',
    );
  }
  if (!existsSync(root)) throw new Error(`Project root does not exist: ${root}`);
  return projectAt(root);
}

export type JiraConfig = z.infer<typeof jiraConfigSchema>;

const DEFAULT_CONFIG_FILE = {
  jira: null,
  runCommand: null,
  appUrl: null,
  verifyCommand: null,
  mergeStrategy: 'merge',
  ticketPrefix: 'EM',
  epicPrefix: 'EP',
  baseBranch: null,
  maxParallelSubtickets: 3,
  maxConcurrentAgents: 3,
  maxAttempts: 3,
  idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
  maxTicketBudgetUsd: null,
  monthlyBudgetUsd: null,
  meetingModel: null,
  meetingMaxTurns: null,
  approvalMode: 'always',
  autoResumeInterrupted: false,
  opencodeServerUrl: null,
  conventionFiles: ['CLAUDE.md', 'AGENTS.md'],
  otelEndpoint: null,
  otelHeaders: {},
  mcpServers: {},
  pipeline: [...DEFAULT_PIPELINE],
  roles: {},
};

export function initProject(from = process.cwd()): { project: Project; created: boolean } {
  const top = process.env.EM_TARGET_REPO ? resolve(process.env.EM_TARGET_REPO) : gitToplevel(from);
  if (!top) throw new Error('em init must run inside a git repository.');
  const created = !existsSync(join(top, EM_DIR_NAME, 'config.json'));
  const project = projectAt(top);
  if (!existsSync(project.configPath)) {
    writeFileSync(project.configPath, `${JSON.stringify(DEFAULT_CONFIG_FILE, null, 2)}\n`);
  }
  return { project: projectAt(top), created };
}
