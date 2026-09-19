import type Database from 'better-sqlite3';

const DDL = `
CREATE TABLE IF NOT EXISTS epics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'PLANNING',
  plan        TEXT,
  feedback    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'BACKLOG',
  attempt     INTEGER NOT NULL DEFAULT 0,
  branch      TEXT,
  base_sha    TEXT,
  has_ui      INTEGER NOT NULL DEFAULT 0,
  run_command TEXT,
  app_url     TEXT,
  epic_id     INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  seq         INTEGER,
  feedback    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  is_ui      INTEGER NOT NULL DEFAULT 0,
  met        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ticket_id, idx)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_state TEXT    NOT NULL,
  to_state   TEXT    NOT NULL,
  role       TEXT,
  verdict    TEXT,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_epic ON tickets(epic_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifacts_ticket ON artifacts(ticket_id, kind, version);
CREATE INDEX IF NOT EXISTS idx_transitions_ticket ON transitions(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_criteria_ticket ON acceptance_criteria(ticket_id, idx);
`;

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { name: 'epic-plan-json', sql: `ALTER TABLE epics ADD COLUMN plan_json TEXT;` },
  { name: 'artifact-data', sql: `ALTER TABLE artifacts ADD COLUMN data TEXT;` },
  { name: 'runs-and-agent-runs', sql: `
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'RUNNING',
  pid         INTEGER NOT NULL,
  error       TEXT,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active ON runs(target) WHERE status = 'RUNNING';
CREATE TABLE IF NOT EXISTS run_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  line       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, id);
CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  epic_id     INTEGER REFERENCES epics(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  num_turns   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ticket ON agent_runs(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_epic ON agent_runs(epic_id, id);
` },
  { name: 'agent-run-provenance', sql: `
ALTER TABLE agent_runs ADD COLUMN runner TEXT;
ALTER TABLE agent_runs ADD COLUMN model TEXT;
ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;
` },
  { name: 'run-cancellation', sql: `ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;` },
  { name: 'ticket-depends-on', sql: `ALTER TABLE tickets ADD COLUMN depends_on TEXT;` },
  // Rows older than the runner/model columns: in that era only the claude-sdk
  // runner reported cost (CLI runs recorded $0) and every role ran the fixed
  // default model, so nonzero-cost rows are safe to backfill. Zero-cost rows
  // cannot be attributed and stay NULL.
  { name: 'backfill-pre-tracking-runs', sql: `UPDATE agent_runs SET runner = 'claude-sdk', model = 'claude-opus-4-8' WHERE runner IS NULL AND cost_usd > 0;` },
  { name: 'ticket-gate', sql: `ALTER TABLE tickets ADD COLUMN gate TEXT;` },
  { name: 'meetings', sql: `
CREATE TABLE IF NOT EXISTS meetings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  participants TEXT    NOT NULL,
  ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  epic_id      INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  status       TEXT    NOT NULL DEFAULT 'OPEN',
  summary      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meeting_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_messages ON meeting_messages(meeting_id, id);
` },
  { name: 'ticket-draft-messages', sql: `
CREATE TABLE IF NOT EXISTS ticket_draft_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender     TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_draft_messages ON ticket_draft_messages(ticket_id, id);
` },
  { name: 'agent-slots', sql: `
CREATE TABLE IF NOT EXISTS agent_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  acquired_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_slots_kind ON agent_slots(kind);
` },
  { name: 'agent-run-cache-tokens', sql: `
ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN cache_write_tokens INTEGER;
` },
  { name: 'ticket-merged-sha', sql: `
ALTER TABLE tickets ADD COLUMN merged_sha TEXT;
` },
  { name: 'ticket-priority-labels-relations', sql: `
ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE tickets ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS ticket_relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  other_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  relation_type   TEXT    NOT NULL CHECK (relation_type IN ('blocks', 'relates-to')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_relations_ticket ON ticket_relations(ticket_id, id);
` },
  { name: 'ticket-jira-key', sql: `
ALTER TABLE tickets ADD COLUMN jira_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_jira_key ON tickets(jira_key) WHERE jira_key IS NOT NULL;
` },
];

export function createSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  db.exec(
    `CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  );

  // Databases from the user_version era: their counter says how many entries of
  // the (then index-ordered) list already ran; seed the ledger from it once.
  const version = db.pragma('user_version', { simple: true }) as number;
  const ledgerSize = (db.prepare(`SELECT COUNT(*) AS n FROM applied_migrations`).get() as { n: number }).n;
  if (version > 0 && ledgerSize === 0) {
    const seed = db.prepare(`INSERT OR IGNORE INTO applied_migrations (name) VALUES (?)`);
    for (const migration of MIGRATIONS.slice(0, version)) seed.run(migration.name);
  }

  const applied = new Set(
    (db.prepare(`SELECT name FROM applied_migrations`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  const isDuplicateColumn = (err: unknown): boolean => /duplicate column name/.test((err as Error).message ?? '');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      try {
        db.exec(migration.sql);
      } catch (err) {
        if (!isDuplicateColumn(err)) throw err;
        for (const statement of migration.sql.split(';')) {
          const sql = statement.trim();
          if (!sql) continue;
          try {
            db.exec(sql);
          } catch (inner) {
            if (!isDuplicateColumn(inner)) throw inner;
          }
        }
      }
      db.prepare(`INSERT INTO applied_migrations (name) VALUES (?)`).run(migration.name);
    });
    apply();
  }
  db.pragma(`user_version = ${MIGRATIONS.length}`);
}
