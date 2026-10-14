import type { Db } from './index.js';

/**
 * Forward-only SQL migrations. Kept in TypeScript so they ship inside the compiled build.
 * Each migration runs in a single transaction together with its schema_migrations row.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: /* sql */ `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'engineer', 'viewer')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  description         text NOT NULL DEFAULT '',
  repo_url            text,
  default_environment text NOT NULL DEFAULT 'production',
  ingest_token        text NOT NULL,
  webhook_secret      text NOT NULL,
  incident_seq        integer NOT NULL DEFAULT 0,
  archived_at         timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Append-only event log: the source of truth for each project's timeline.
-- Every deployment / change / incident fact enters through here first.
CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('deployment', 'change', 'incident')),
  action            text NOT NULL,
  entity_id         uuid,
  summary           text NOT NULL DEFAULT '',
  occurred_at       timestamptz NOT NULL,              -- when it happened (source clock)
  received_at       timestamptz NOT NULL,              -- when we learned about it
  source            text NOT NULL,                     -- ui | api | github
  dedup_key         text NOT NULL,
  actor_id          uuid REFERENCES users(id),
  payload           jsonb NOT NULL DEFAULT '{}',
  warnings          jsonb NOT NULL DEFAULT '[]',
  late              boolean NOT NULL DEFAULT false,    -- reported long after it happened
  out_of_order      boolean NOT NULL DEFAULT false,    -- newer events were already recorded
  duplicate_count   integer NOT NULL DEFAULT 0,        -- identical deliveries suppressed
  last_duplicate_at timestamptz,
  UNIQUE (project_id, dedup_key)
);
CREATE INDEX events_project_time ON events (project_id, occurred_at DESC);
CREATE INDEX events_entity ON events (entity_id);

-- Materialised state of a deployment, merged from possibly out-of-order / partial events.
CREATE TABLE deployments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_id text NOT NULL,                           -- CI run id, GitHub deployment id, …
  version     text,
  commit_sha  text,
  environment text,
  service     text,
  status      text NOT NULL DEFAULT 'unknown'
              CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back', 'unknown')),
  status_at   timestamptz,                             -- occurred_at of the event that set status
  started_at  timestamptz,
  finished_at timestamptz,
  deployed_by text,
  url         text,
  notes       text,
  conflicts   jsonb NOT NULL DEFAULT '[]',             -- contradictory values we refused to overwrite
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_id)
);
CREATE INDEX deployments_project_time ON deployments (project_id, (COALESCE(finished_at, started_at, status_at, created_at)) DESC);

CREATE TABLE changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha          text NOT NULL,
  message      text NOT NULL DEFAULT '',
  author       text,
  url          text,
  branch       text,
  files        jsonb NOT NULL DEFAULT '[]',
  committed_at timestamptz,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, sha)
);
CREATE INDEX changes_project_time ON changes (project_id, committed_at DESC);

-- Deployment → commit membership is keyed by SHA, not by changes.id, so a deployment can
-- reference commits we have not received yet (they join up automatically when they arrive).
CREATE TABLE deployment_commits (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  sha           text NOT NULL,
  PRIMARY KEY (deployment_id, sha)
);
CREATE INDEX deployment_commits_sha ON deployment_commits (sha);

CREATE TABLE incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          integer NOT NULL,
  external_id     text,                                -- alert id from monitoring, for dedup
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  severity        text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed')),
  service         text,
  environment     text,
  detected_at     timestamptz NOT NULL,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  assignee_id     uuid REFERENCES users(id),
  root_cause      text,
  resolution      text,
  fingerprint     text NOT NULL,
  duplicate_of    uuid REFERENCES incidents(id),
  version         integer NOT NULL DEFAULT 1,          -- optimistic concurrency
  created_by      uuid REFERENCES users(id),
  source          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE UNIQUE INDEX incidents_external ON incidents (project_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX incidents_fingerprint ON incidents (project_id, fingerprint);
CREATE INDEX incidents_project_time ON incidents (project_id, detected_at DESC);

-- Which fields each version changed — lets concurrent edits to *different* fields merge.
CREATE TABLE incident_revisions (
  incident_id    uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  version        integer NOT NULL,
  changed_fields text[] NOT NULL,
  actor_id       uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, version)
);

CREATE TABLE incident_links (
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('deployment', 'change')),
  target_id   uuid NOT NULL,
  relation    text NOT NULL CHECK (relation IN ('suspected', 'confirmed', 'ruled_out')),
  note        text,
  score       double precision,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, target_type, target_id)
);
CREATE INDEX incident_links_target ON incident_links (target_type, target_id);

-- Collaborative activity feed: comments are append-only, so they never conflict.
CREATE TABLE incident_updates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('comment', 'status', 'field', 'link', 'system')),
  body        text NOT NULL DEFAULT '',
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX incident_updates_incident ON incident_updates (incident_id, created_at);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  actor_label text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_log_project ON audit_log (project_id, created_at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);
`,
  },
  {
    id: '002_war_room',
    sql: /* sql */ `
-- Human-friendly per-project deploy numbers (#2481), assigned when a deployment is first seen.
ALTER TABLE projects ADD COLUMN deploy_seq integer NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN number integer;
UPDATE deployments d SET number = x.n
FROM (SELECT id, row_number() OVER (PARTITION BY project_id
        ORDER BY COALESCE(started_at, finished_at, status_at, created_at), created_at) AS n
      FROM deployments) x
WHERE x.id = d.id;
UPDATE projects p SET deploy_seq = COALESCE((SELECT max(number) FROM deployments d WHERE d.project_id = p.id), 0);
ALTER TABLE deployments ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX deployments_number ON deployments (project_id, number);

-- Config changes (terraform, feature flags, env vars) often ship without a deploy record.
ALTER TABLE changes ADD COLUMN kind text NOT NULL DEFAULT 'commit' CHECK (kind IN ('commit', 'config'));

-- Incident roles and coordination links; "mitigating" sits between identified and monitoring.
ALTER TABLE incidents
  ADD COLUMN commander_id uuid REFERENCES users(id),
  ADD COLUMN rollback_owner_id uuid REFERENCES users(id),
  ADD COLUMN channel text,
  ADD COLUMN runbook text;
ALTER TABLE incidents DROP CONSTRAINT incidents_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
  CHECK (status IN ('open', 'investigating', 'identified', 'mitigating', 'monitoring', 'resolved', 'closed'));

-- Rejected concurrent edits are kept in the activity feed so nobody's input silently disappears.
ALTER TABLE incident_updates DROP CONSTRAINT incident_updates_kind_check;
ALTER TABLE incident_updates ADD CONSTRAINT incident_updates_kind_check
  CHECK (kind IN ('comment', 'status', 'field', 'link', 'system', 'conflict'));

-- Which integration delivered an event (GitHub webhooks, Kubernetes, PagerDuty, …).
ALTER TABLE events ADD COLUMN source_name text;

-- The raw error signature an alert carried (shown on recurring issues; fingerprint is its hash).
ALTER TABLE incidents ADD COLUMN signature text;

-- Health signals (e.g. error_rate per service). Idempotent on (project, name, service, at).
CREATE TABLE metric_points (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  service    text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL,
  value      double precision NOT NULL,
  PRIMARY KEY (project_id, name, service, at)
);
`,
  },
  {
    id: '003_accounts',
    sql: /* sql */ `
-- Sessions issued before this moment are rejected, so changing or resetting a password signs
-- out every other device.
ALTER TABLE users ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();
`,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.exec(`BEGIN;\n${m.sql}\nINSERT INTO schema_migrations (id) VALUES ('${m.id}');\nCOMMIT;`);
    ran.push(m.id);
  }
  return ran;
}
