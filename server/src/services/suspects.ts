import { config } from '../config.js';
import type { Queryable } from '../db/index.js';
import { jaccard, tokens } from '../lib/fingerprint.js';
import { getIncident, incLabel, type IncidentRow } from './incidents.js';
import { errorSignal, type ErrorSignal } from './metrics.js';

export interface SuspectReason {
  text: string;
  weight: number; // contribution to the score, for display
}

export interface Suspect {
  type: 'deployment';
  deployment: Record<string, any>;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: SuspectReason[];
  commits: { sha: string; message: string | null; author: string | null; files: string[]; known: boolean; url: string | null }[];
  link: { relation: string; note: string | null } | null;
  incomplete: string[];
  /** Last clean deploy of the same service/env before this one — what you would roll back to. */
  rollback_target: { id: string; number: number; version: string | null } | null;
}

export interface ChangeSuspect {
  type: 'change';
  change: Record<string, any>;
  /** Deploy that shipped it, or null when there is no deploy record (config applied out of band). */
  deployment: { id: string; number: number } | null;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: SuspectReason[];
  link: { relation: string; note: string | null } | null;
}

const HOUR = 3600_000;
const confidence = (score: number): Suspect['confidence'] => (score >= 0.55 ? 'high' : score >= 0.3 ? 'medium' : 'low');
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rank deployments (and the individual changes inside or outside them) that might have caused an
 * incident. Pure heuristics, each one explained:
 *
 *  onset         the reference time: when the error-rate metric first breached 5× its baseline,
 *                falling back to the incident's detection time when no metric is recorded
 *  recency       exp(-Δt / 6h)  × 0.45      — most regressions surface within hours
 *  after onset   0.45 × 0.3                 — went live after the errors had already started
 *  latest        +0.15                      — the last deploy of that service/env before onset
 *  in progress   0.45                       — deploy was rolling out when it broke
 *  service       +0.15 match / ×0.6 differ
 *  environment   +0.05 match / ×0.25 differ — a staging deploy rarely breaks production
 *  status        +0.10 failed / rolled back
 *  history       +0.3 × smoothed incident-rate of the riskiest file it ships: of the other deployments
 *                to this environment that shipped the file, how many were confirmed causes of an
 *                earlier same-fingerprint incident — culprits / (shipped + 1), counted when ≥ 0.4.
 *                Files that merely rode along with a bad deploy get diluted by their clean deploys.
 *  keywords      +0.10 commit messages / paths mention words from the incident title
 *
 * Changes: a commit inside a suspect deploy inherits its deploy's score scaled by how specifically
 * it is implicated (risky file 0.8, keyword 0.6, otherwise 0.4). A change with no deploy record is
 * scored on its own recency, keywords and file history, plus +0.15 when it is a config change.
 *
 * Human verdicts (confirmed / ruled out links) override the heuristic ordering.
 */
export async function findSuspects(
  q: Queryable,
  incidentId: string,
): Promise<{ incident: IncidentRow; suspects: Suspect[]; changes: ChangeSuspect[]; signal: ErrorSignal | null }> {
  const incident = await getIncident(q, incidentId);
  const T = incident.detected_at.getTime();
  const signal = await errorSignal(q, incident.project_id, incident.service, incident.detected_at);
  const onset = signal?.onset_at ? Math.min(T, new Date(signal.onset_at).getTime()) : T;
  const onsetLabel = signal?.onset_at && new Date(signal.onset_at).getTime() < T ? 'the error rate first spiked' : 'the incident was detected';
  const windowStart = new Date(onset - config.suspectWindowHours * HOUR).toISOString();

  const { rows: deps } = await q.query(
    `SELECT d.*, COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) AS effective_at,
            COALESCE(d.started_at, d.finished_at, d.status_at, d.created_at) AS begin_at
     FROM deployments d
     WHERE d.project_id = $1
       AND COALESCE(d.started_at, d.finished_at, d.status_at, d.created_at) <= $2::timestamptz
       AND COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) >= $3::timestamptz
     ORDER BY effective_at DESC
     LIMIT 50`,
    [incident.project_id, incident.detected_at.toISOString(), windowStart],
  );

  const depIds = deps.map((d) => d.id);
  const [{ rows: commitRows }, { rows: links }, history, { rows: orphans }] = await Promise.all([
    q.query(
      `SELECT dc.deployment_id, dc.sha, c.id AS change_id, c.kind, c.message, c.author, c.files, c.url, c.committed_at,
              c.id IS NOT NULL AS known
       FROM deployment_commits dc
       LEFT JOIN changes c ON c.project_id = $2 AND c.sha = dc.sha
       WHERE dc.deployment_id = ANY($1::uuid[])`,
      [depIds, incident.project_id],
    ),
    q.query(`SELECT target_type, target_id, relation, note FROM incident_links WHERE incident_id = $1`, [incidentId]),
    implicatedFiles(q, incident),
    q.query(
      `SELECT c.* FROM changes c
       WHERE c.project_id = $1 AND c.committed_at BETWEEN $2::timestamptz AND $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM deployment_commits dc JOIN deployments d ON d.id = dc.deployment_id
                         WHERE dc.sha = c.sha AND d.project_id = c.project_id)
       ORDER BY c.committed_at DESC LIMIT 20`,
      [incident.project_id, new Date(onset - 24 * HOUR).toISOString(), new Date(onset).toISOString()],
    ),
  ]);

  const commitsByDep = new Map<string, any[]>();
  for (const r of commitRows) {
    if (!commitsByDep.has(r.deployment_id)) commitsByDep.set(r.deployment_id, []);
    commitsByDep.get(r.deployment_id)!.push({ ...r, files: r.files ?? [] });
  }
  const linkOf = new Map(links.map((l) => [`${l.target_type}:${l.target_id}`, { relation: l.relation, note: l.note }]));
  const titleTokens = tokens(`${incident.title} ${incident.service ?? ''}`);
  const mentions = (text: string) => {
    const t = tokens(text);
    return [...titleTokens].filter((x) => t.has(x));
  };
  const riskiest = (files: Iterable<string>, selfId?: string) => {
    let best: { file: string; rate: number; culprits: number; shipped: number; incidents: number[] } | null = null;
    for (const f of files) {
      const h = history.files.get(f);
      if (!h) continue;
      const others = [...h.shippedIn].filter((id) => id !== selfId);
      const culprits = [...h.culprits].filter((id) => id !== selfId);
      const rate = culprits.length / (others.length + 1); // Laplace-style smoothing: 1 of 1 → 0.5, not 1.0
      if (!best || rate > best.rate) best = { file: f, rate, culprits: culprits.length, shipped: others.length, incidents: [...h.incidents] };
    }
    return best && best.rate >= 0.4 ? best : null;
  };

  // "latest before onset" per (service, environment)
  const latestKey = (d: any) => `${d.service ?? '?'}|${d.environment ?? '?'}`;
  const latest = new Map<string, string>();
  for (const d of deps) {
    if (new Date(d.effective_at).getTime() <= onset && !latest.has(latestKey(d))) latest.set(latestKey(d), d.id);
  }

  const riskyByDep = new Map<string, string | null>();
  const suspects: Suspect[] = deps.map((d) => {
    const reasons: SuspectReason[] = [];
    const add = (text: string, weight: number) => reasons.push({ text, weight: round2(weight) });
    const begin = new Date(d.begin_at).getTime();
    const effective = new Date(d.effective_at).getTime();
    let score = 0;

    if (begin <= onset && effective > onset) {
      score += 0.45;
      add(`Was still rolling out when ${onsetLabel}`, 0.45);
    } else if (effective <= onset) {
      const recency = 0.45 * Math.exp(-(onset - effective) / HOUR / 6);
      score += recency;
      add(`Went live ${humanDuration(onset - effective)} before ${onsetLabel}`, recency);
    } else {
      const recency = 0.45 * 0.3;
      score += recency;
      add(`Went live ${humanDuration(effective - onset)} after ${onsetLabel} — unlikely to have started it`, recency);
    }
    if (latest.get(latestKey(d)) === d.id) {
      score += 0.15;
      add(`Most recent ${d.service ? `${d.service} ` : ''}deployment${d.environment ? ` to ${d.environment}` : ''} before ${onsetLabel}`, 0.15);
    }
    if (incident.service && d.service) {
      if (incident.service.toLowerCase() === d.service.toLowerCase()) {
        score += 0.15;
        add(`Deployed the affected service (${d.service})`, 0.15);
      } else {
        const before = score;
        score *= 0.6;
        add(`Different service (${d.service} vs ${incident.service})`, score - before);
      }
    }
    if (incident.environment && d.environment) {
      if (incident.environment.toLowerCase() === d.environment.toLowerCase()) {
        score += 0.05;
        add(`Same environment (${d.environment})`, 0.05);
      } else {
        const before = score;
        score *= 0.25;
        add(`Different environment (${d.environment} vs ${incident.environment})`, score - before);
      }
    }
    if (d.status === 'failed' || d.status === 'rolled_back') {
      score += 0.1;
      add(d.status === 'failed' ? 'Deployment failed' : 'Deployment was rolled back', 0.1);
    }

    const commits = commitsByDep.get(d.id) ?? [];
    const risky = riskiest(new Set(commits.flatMap((c) => c.files as string[])), d.id);
    riskyByDep.set(d.id, risky?.file ?? null);
    if (risky) {
      const w = 0.3 * risky.rate;
      score += w;
      add(
        `Changes ${risky.file} — ${risky.culprits} of ${risky.shipped} earlier deploys that shipped it caused this error (${risky.incidents.map(incLabel).join(', ')})`,
        w,
      );
    }
    const shared = mentions(commits.map((c) => `${c.message ?? ''} ${c.files.join(' ')}`).join(' '));
    if (shared.length) {
      score += 0.1;
      add(`Commits mention ${shared.slice(0, 3).map((x) => `"${x}"`).join(', ')}`, 0.1);
    }

    const incomplete: string[] = [];
    if (!d.commit_sha && commits.length === 0) incomplete.push('commit');
    if (!d.finished_at && d.status !== 'in_progress' && d.status !== 'pending') incomplete.push('finish time');
    if (d.status === 'unknown') incomplete.push('status');
    if (!d.environment) incomplete.push('environment');
    if (commits.some((c) => !c.known)) incomplete.push('commit details');

    score = Math.min(1, round2(score));
    return {
      type: 'deployment',
      deployment: d,
      score,
      confidence: confidence(score),
      reasons,
      commits: commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author, files: c.files, known: c.known, url: c.url })),
      link: linkOf.get(`deployment:${d.id}`) ?? null,
      incomplete,
      rollback_target: null,
    };
  });

  const rank = (s: { link: { relation: string } | null }) => (s.link?.relation === 'confirmed' ? 2 : s.link?.relation === 'ruled_out' ? -1 : 0);
  suspects.sort((a, b) => rank(b) - rank(a) || b.score - a.score);
  const top = suspects.slice(0, 15);
  for (const s of top.slice(0, 5)) s.rollback_target = await rollbackTarget(q, s.deployment);

  // ---- change-level suspects --------------------------------------------------------------
  const changes: ChangeSuspect[] = [];
  for (const s of suspects) {
    const commits = commitsByDep.get(s.deployment.id) ?? [];
    if (s.score < 0.3 || commits.length < 2) continue; // single-commit deploys: the deploy *is* the change
    const riskyFile = riskyByDep.get(s.deployment.id);
    for (const c of commits) {
      if (!c.known) continue;
      const reasons: SuspectReason[] = [];
      const hitsRisky = !!riskyFile && c.files.includes(riskyFile);
      const kw = mentions(`${c.message ?? ''} ${c.files.join(' ')}`);
      const factor = hitsRisky ? 0.8 : kw.length ? 0.6 : 0.4;
      const score = round2(s.score * factor);
      reasons.push({ text: `Shipped inside #${s.deployment.number} (score ${Math.round(s.score * 100)})`, weight: score });
      if (hitsRisky) reasons.push({ text: `Touches ${riskyFile}, the file implicated in earlier incidents`, weight: 0 });
      else if (kw.length) reasons.push({ text: `Mentions ${kw.slice(0, 2).map((x) => `"${x}"`).join(', ')}`, weight: 0 });
      else reasons.push({ text: `One of ${commits.length} commits in that deploy; no direct evidence against this one`, weight: 0 });
      changes.push({
        type: 'change',
        change: { id: c.change_id, sha: c.sha, kind: c.kind, message: c.message, author: c.author, files: c.files, url: c.url, committed_at: c.committed_at },
        deployment: { id: s.deployment.id, number: s.deployment.number },
        score,
        confidence: confidence(score),
        reasons,
        link: linkOf.get(`change:${c.change_id}`) ?? null,
      });
    }
  }
  for (const c of orphans) {
    const reasons: SuspectReason[] = [];
    const at = new Date(c.committed_at).getTime();
    let score = 0.45 * Math.exp(-(onset - at) / HOUR / 6);
    reasons.push({ text: `${c.kind === 'config' ? 'Applied' : 'Committed'} ${humanDuration(onset - at)} before ${onsetLabel}`, weight: round2(score) });
    if (c.kind === 'config') {
      score += 0.15;
      reasons.push({ text: 'Config change with no deploy record — it bypassed the pipeline', weight: 0.15 });
    } else {
      reasons.push({ text: 'Not part of any recorded deployment', weight: 0 });
    }
    const kw = mentions(`${c.message} ${(c.files as string[]).join(' ')}`);
    if (kw.length) {
      score += 0.1;
      reasons.push({ text: `Mentions ${kw.slice(0, 2).map((x) => `"${x}"`).join(', ')}`, weight: 0.1 });
    }
    const risky = riskiest(c.files as string[]);
    if (risky) {
      score += 0.3 * risky.rate;
      reasons.push({ text: `Touches ${risky.file}, implicated in ${risky.incidents.map(incLabel).join(', ')}`, weight: round2(0.3 * risky.rate) });
    }
    score = Math.min(1, round2(score));
    changes.push({ type: 'change', change: c, deployment: null, score, confidence: confidence(score), reasons, link: linkOf.get(`change:${c.id}`) ?? null });
  }
  changes.sort((a, b) => rank(b) - rank(a) || b.score - a.score);

  return { incident, suspects: top, changes: changes.slice(0, 10), signal };
}

/** The most recent earlier deploy of the same service+environment that succeeded and caused nothing. */
export async function rollbackTarget(q: Queryable, d: Record<string, any>) {
  const { rows } = await q.query<{ id: string; number: number; version: string | null }>(
    `SELECT id, number, version FROM deployments x
     WHERE x.project_id = $1 AND x.id <> $2 AND x.status = 'succeeded'
       AND x.service IS NOT DISTINCT FROM $3 AND x.environment IS NOT DISTINCT FROM $4
       AND COALESCE(x.finished_at, x.started_at, x.status_at, x.created_at) < $5::timestamptz
       AND NOT EXISTS (SELECT 1 FROM incident_links l
                       WHERE l.target_type = 'deployment' AND l.target_id = x.id AND l.relation = 'confirmed')
       AND x.external_id NOT LIKE 'rollback:%'
     ORDER BY COALESCE(x.finished_at, x.started_at, x.status_at, x.created_at) DESC LIMIT 1`,
    [d.project_id, d.id, d.service, d.environment, new Date(d.begin_at ?? d.started_at ?? d.created_at).toISOString()],
  );
  return rows[0] ?? null;
}

/**
 * For each file implicated in an earlier, same-fingerprint incident: which deployments (to the
 * incident's environment) shipped it, and which of those were confirmed causes.
 */
async function implicatedFiles(q: Queryable, incident: IncidentRow) {
  const { rows: culprits } = await q.query<{ number: number; deployment_id: string; files: string[] }>(
    `SELECT i.number, d.id AS deployment_id, c.files
     FROM incidents i
     JOIN incident_links l ON l.incident_id = i.id AND l.relation = 'confirmed' AND l.target_type = 'deployment'
     JOIN deployments d ON d.id = l.target_id
     JOIN deployment_commits dc ON dc.deployment_id = d.id
     JOIN changes c ON c.project_id = i.project_id AND c.sha = dc.sha
     WHERE i.project_id = $1 AND i.fingerprint = $2 AND i.id <> $3 AND i.detected_at < $4`,
    [incident.project_id, incident.fingerprint, incident.id, incident.detected_at.toISOString()],
  );
  const files = new Map<string, { culprits: Set<string>; shippedIn: Set<string>; incidents: Set<number> }>();
  for (const r of culprits) {
    for (const f of r.files) {
      if (!files.has(f)) files.set(f, { culprits: new Set(), shippedIn: new Set(), incidents: new Set() });
      files.get(f)!.culprits.add(r.deployment_id);
      files.get(f)!.incidents.add(r.number);
    }
  }
  if (files.size === 0) return { files };
  const { rows: shipped } = await q.query<{ file: string; deployment_id: string }>(
    `SELECT DISTINCT f.file, d.id AS deployment_id
     FROM deployments d
     JOIN deployment_commits dc ON dc.deployment_id = d.id
     JOIN changes c ON c.project_id = d.project_id AND c.sha = dc.sha
     CROSS JOIN LATERAL jsonb_array_elements_text(c.files) AS f(file)
     WHERE d.project_id = $1 AND f.file = ANY($2::text[])
       AND ($3::text IS NULL OR d.environment = $3)
       AND COALESCE(d.started_at, d.finished_at, d.status_at, d.created_at) <= $4::timestamptz`,
    [incident.project_id, [...files.keys()], incident.environment, incident.detected_at.toISOString()],
  );
  for (const r of shipped) files.get(r.file)!.shippedIn.add(r.deployment_id);
  return { files };
}

function humanDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'moments';
  if (min < 60) return `${min} min`;
  const h = min / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

// ---- similar incidents --------------------------------------------------------------------

export async function similarIncidents(q: Queryable, incidentId: string) {
  const incident = await getIncident(q, incidentId);
  const { rows } = await q.query(
    `SELECT id, number, title, severity, status, service, detected_at, resolved_at, fingerprint, root_cause, resolution
     FROM incidents WHERE project_id = $1 AND id <> $2 ORDER BY detected_at DESC LIMIT 500`,
    [incident.project_id, incidentId],
  );
  const mine = tokens(incident.title);
  return rows
    .map((r) => {
      const same = r.fingerprint === incident.fingerprint;
      const sim = same ? 1 : jaccard(mine, tokens(r.title)) * (incident.service && r.service && incident.service !== r.service ? 0.5 : 1);
      return { ...r, similarity: Math.round(sim * 100) / 100, same_fingerprint: same };
    })
    .filter((r) => r.similarity >= 0.4)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8);
}
