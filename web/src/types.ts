export type Role = 'admin' | 'engineer' | 'viewer';
export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IncidentStatus = 'open' | 'investigating' | 'identified' | 'mitigating' | 'monitoring' | 'resolved' | 'closed';
export type DeployStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back' | 'unknown';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  repo_url: string | null;
  default_environment: string;
  ingest_token?: string;
  webhook_secret?: string;
  webhook_url?: string;
  open_incidents?: number;
  open_major?: number;
  worst_open_severity?: Severity | null;
  deploys_7d?: number;
  last_deployment?: { number: number; version: string | null; external_id: string; status: DeployStatus; environment: string | null; at: string } | null;
}

export interface Incident {
  id: string;
  project_id: string;
  number: number;
  external_id: string | null;
  title: string;
  description: string;
  severity: Severity;
  status: IncidentStatus;
  service: string | null;
  environment: string | null;
  detected_at: string;
  reported_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  commander_id: string | null;
  commander_name: string | null;
  rollback_owner_id: string | null;
  rollback_owner_name: string | null;
  channel: string | null;
  runbook: string | null;
  signature: string | null;
  created_by_name: string | null;
  root_cause: string | null;
  resolution: string | null;
  fingerprint: string;
  duplicate_of: string | null;
  duplicate_of_number: number | null;
  version: number;
  source: string;
  updated_at: string;
}

export interface Deployment {
  id: string;
  number: number;
  external_id: string;
  version: string | null;
  commit_sha: string | null;
  environment: string | null;
  service: string | null;
  status: DeployStatus;
  started_at: string | null;
  finished_at: string | null;
  effective_at: string;
  deployed_by: string | null;
  url: string | null;
  notes: string | null;
  conflicts: { field: string; kept: string; rejected: string; occurred_at: string; source: string }[];
  source: string;
  commit_count?: number;
  confirmed_incidents?: number;
  suspected_incidents?: number;
  gaps: string[];
}

export interface Change {
  id: string;
  sha: string;
  message: string;
  author: string | null;
  url: string | null;
  branch: string | null;
  files: string[];
  committed_at: string | null;
  source: string;
  kind: 'commit' | 'config';
  deployments: { id: string; number: number; label: string; environment: string | null; status: DeployStatus }[];
}

export interface TimelineEvent {
  id: string;
  kind: 'deployment' | 'change' | 'incident';
  action: string;
  entity_id: string | null;
  summary: string;
  occurred_at: string;
  received_at: string;
  source: string;
  late: boolean;
  out_of_order: boolean;
  duplicate_count: number;
  warnings: string[];
  actor_name: string | null;
  delay_seconds: number;
}

export interface IncidentUpdate {
  id: string;
  kind: 'comment' | 'status' | 'field' | 'link' | 'system' | 'conflict';
  body: string;
  data: any;
  author_name: string | null;
  created_at: string;
}

export interface IncidentLink {
  target_type: 'deployment' | 'change';
  target_id: string;
  relation: 'suspected' | 'confirmed' | 'ruled_out';
  note: string | null;
  target_label: string | null;
  created_by_name: string | null;
}

export interface Reason {
  text: string;
  weight: number;
}
export interface Suspect {
  type: 'deployment';
  deployment: Deployment;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: Reason[];
  commits: { sha: string; message: string | null; author: string | null; files: string[]; known: boolean; url: string | null }[];
  link: { relation: string; note: string | null } | null;
  rollback_target: { id: string; number: number; version: string | null } | null;
}
export interface ChangeSuspect {
  type: 'change';
  change: { id: string; sha: string; kind: 'commit' | 'config'; message: string; author: string | null; files: string[]; url: string | null; committed_at: string };
  deployment: { id: string; number: number } | null;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: Reason[];
  link: { relation: string; note: string | null } | null;
}
export interface ErrorSignal {
  name: string;
  service: string;
  baseline: number;
  onset_at: string | null;
  latest: number;
  latest_at: string;
  peak: number;
}
export interface SuspectsResponse {
  suspects: Suspect[];
  changes: ChangeSuspect[];
  signal: ErrorSignal | null;
}

export interface FeedItem {
  type: 'update' | 'event';
  at: string;
  id: string;
  kind: string;
  body?: string;
  data?: any;
  author_id?: string | null;
  author_name?: string | null;
  action?: string;
  summary?: string;
  occurred_at?: string;
  received_at?: string;
  source_name?: string | null;
  late?: boolean;
  duplicate_count?: number;
  delay_seconds?: number;
  actor_name?: string | null;
  sha?: string | null;
  entity_id?: string | null;
}

export interface LedgerRow {
  type: 'deployment' | 'change';
  id: string;
  at: string;
  number?: number;
  external_id?: string;
  version?: string | null;
  environment?: string | null;
  service?: string | null;
  status?: DeployStatus;
  deployed_by?: string | null;
  commit_count?: number;
  head?: { sha: string; message: string; author: string | null } | null;
  sha?: string;
  kind?: string;
  message?: string;
  author?: string | null;
  after: { label: string; tone: string };
}

export interface RecurringGroup {
  title: string;
  service: string | null;
  signature: string;
  count: number;
  open: number;
  first_seen: string;
  last_seen: string;
  resolved: number;
  median_resolve_minutes: number | null;
  confirmed_causes: { deployment: number; commit: number; config: number };
  incidents: { id: string; number: number; status: IncidentStatus; severity: Severity; detected_at: string }[];
}

export interface Viewer {
  id: string;
  name: string;
}

export interface StreamMessage {
  type: string;
  projectId: string;
  data: Record<string, any>;
  at: string;
}
