import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { Feed } from '../components/Feed';
import { Icon } from '../components/Icon';
import { Ledger } from '../components/Ledger';
import { MatchCallout, RecurringList } from '../components/Recurring';
import { mergeSuspects, setVerdict, suspectName, SuspectList, type AnySuspect } from '../components/Suspects';
import { RANGES, Swimlanes, type RangeKey } from '../components/Swimlanes';
import { Confirm, ErrorBox, Loading, Meter, Stat, useToast } from '../components/ui';
import { clock, depLabel, duration, incLabel, isUrl, lowerFirst, minutesBetween, shortAge, timeAgo, tzName } from '../format';
import { useApi, useDebounced, useNow, usePresenceHeartbeat } from '../hooks';
import { useLive, useShell } from '../shell';
import type { Incident, LedgerRow, RecurringGroup, SuspectsResponse } from '../types';
import { useProject } from './ProjectLayout';

const rangeTitle: Record<RangeKey, string> = { '1h': 'hour', '6h': 'six hours', '24h': 'day', '7d': 'week' };

export default function Overview() {
  const { project } = useProject();
  const { overview } = useShell();
  const focus = overview?.focus ?? null;
  const [range, setRange] = useState<RangeKey>('6h');
  const suspects = useApi<SuspectsResponse>(focus ? `/incidents/${focus.id}/suspects` : null);
  const ledger = useApi<{ rows: LedgerRow[] }>(`/projects/${project.id}/ledger?limit=8`);
  const recurring = useApi<{ days: number; groups: RecurringGroup[] }>(`/projects/${project.id}/recurring?days=90`);
  const refresh = useDebounced(() => {
    void suspects.reload();
    void ledger.reload();
    void recurring.reload();
  }, 700);
  useLive(refresh);
  usePresenceHeartbeat(focus?.id);

  if (!overview) return <Loading />;
  const ranked = mergeSuspects(suspects.data);
  const top = ranked.find((s) => s.link?.relation !== 'ruled_out') ?? null;
  const signal = suspects.data?.signal ?? null;
  const anchor = focus ? (signal?.onset_at && new Date(signal.onset_at) < new Date(focus.detected_at) ? signal.onset_at : focus.detected_at) : null;
  const anchorLabel = focus && signal?.onset_at && anchor === signal.onset_at ? 'first spike' : 'detected';

  return (
    <div className="stack" style={{ gap: 18 }}>
      {focus ? (
        <Hero incident={focus} top={top} signal={signal} ledger={ledger.data?.rows ?? []} loadingSuspects={!suspects.data} onVerdict={refresh} />
      ) : (
        <AllClear ledger={ledger.data?.rows ?? []} />
      )}

      <div className="grid cols-3-1">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>{focus ? `The ${rangeTitle[range]} before it broke` : `The last ${rangeTitle[range]}`}</h2>
              <p className="muted small">Sorted by when things happened, not when we heard about them.</p>
            </div>
            <div className="seg" role="tablist" aria-label="Range">
              {(Object.keys(RANGES) as RangeKey[]).map((r) => (
                <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)} role="tab" aria-selected={r === range}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            <Swimlanes
              projectId={project.id}
              anchor={anchor}
              anchorLabel={anchorLabel}
              range={range}
              highlightDeploymentId={top?.type === 'deployment' ? top.deployment.id : null}
              service={focus?.service ?? signal?.service}
              defaultEnvironment={project.default_environment}
            />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Suspects</h2>
            <span className="label">ranked by evidence</span>
          </div>
          <div className="card-body">
            {!focus ? (
              <div className="empty small">No active incident — nothing to investigate.</div>
            ) : (
              <>
                <ErrorBox error={suspects.error} />
                {!suspects.data ? <Loading /> : <SuspectList data={suspects.data} incidentId={focus.id} projectId={project.id} limit={3} onChange={refresh} />}
                <p className="muted small" style={{ marginTop: 12 }}>
                  Scored on timing against the error-rate onset, files touched vs. earlier incidents with the same fingerprint, service and keywords.
                  Ruling one out re-ranks the rest.{' '}
                  <Link to={`/projects/${project.id}/incidents/${focus.id}`} className="accent">
                    All {ranked.length} →
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>{focus ? `${incLabel(focus.number)} — what the team is doing` : 'Activity'}</h2>
            {focus && (
              <Link to={`/projects/${project.id}/incidents/${focus.id}`} className="small muted">
                Full history
              </Link>
            )}
          </div>
          <div className="card-body">{focus ? <Feed incident={focus} onChanged={refresh} limit={8} /> : <div className="empty small">Updates from responders appear here during an incident.</div>}</div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Keeps coming back</h2>
              <p className="muted small">Incidents grouped by error fingerprint · last {recurring.data?.days ?? 90} days</p>
            </div>
            <Link to={`/projects/${project.id}/recurring`} className="small muted">
              All
            </Link>
          </div>
          <div className="card-body stack">
            {!recurring.data ? <Loading /> : <RecurringList groups={recurring.data.groups.slice(0, 3)} days={recurring.data.days} projectId={project.id} />}
            {focus && recurring.data && <MatchCallout groups={recurring.data.groups} incidentId={focus.id} incidentNumber={focus.number} />}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Deploy ledger</h2>
          <Link to={`/projects/${project.id}/deploys`} className="small muted">
            All deploys
          </Link>
        </div>
        <div className="card-body">{!ledger.data ? <Loading /> : <Ledger rows={ledger.data.rows} projectId={project.id} defaultEnvironment={project.default_environment} />}</div>
      </div>

      <div className="grid cols-2">
        <Intake />
        <Health />
      </div>
    </div>
  );
}

// ---- hero ---------------------------------------------------------------------------------

function headline(incident: Incident, signal: SuspectsResponse['signal']) {
  if (signal && signal.latest >= 1) {
    if (signal.latest >= 50) return `Most ${signal.service} requests are failing.`;
    return `1 in ${Math.max(2, Math.round(100 / signal.latest))} ${signal.service} requests are failing.`;
  }
  const t = incident.title.trim();
  return /[.!?]$/.test(t) ? t : `${t[0].toUpperCase()}${t.slice(1)}.`;
}

function verdictLine(top: AnySuspect | null) {
  if (!top) return 'No suspect stands out yet.';
  if (top.link?.relation === 'confirmed') return `${suspectName(top)} broke it.`;
  if (top.confidence === 'low') return `Nothing stands out yet — ${suspectName(top)} leads.`;
  return `${suspectName(top)} most likely broke it.`;
}

function lede(top: AnySuspect | null, signal: SuspectsResponse['signal']) {
  if (!top) return signal ? `Error rate is ${signal.latest}% against a ${signal.baseline}% baseline. No deploy or change in the window looks related.` : 'No deploy or change in the window looks related.';
  const positives = top.reasons.filter((r) => r.weight > 0 && !/^(Same environment|Deployed the affected service|Shipped inside)/.test(r.text)).map((r) => r.text);
  if (positives.length === 0) return top.reasons.map((r) => r.text).join('. ') + '.';
  const [first, ...rest] = positives;
  return `It ${lowerFirst(first)}${rest.length ? `; ${rest.map(lowerFirst).join('; ')}` : ''}.`;
}

function Hero({
  incident,
  top,
  signal,
  ledger,
  loadingSuspects,
  onVerdict,
}: {
  incident: Incident;
  top: AnySuspect | null;
  signal: SuspectsResponse['signal'];
  ledger: LedgerRow[];
  loadingSuspects: boolean;
  onVerdict: () => void;
}) {
  const { project } = useProject();
  const { overview, reloadOverview } = useShell();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow(1000);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const target = top?.type === 'deployment' ? top.rollback_target : null;
  const pending = top?.type === 'deployment' ? ledger.find((r) => r.external_id?.startsWith(`rollback:${top.deployment.number}->`)) : undefined;
  const openFor = minutesBetween(incident.detected_at, now);
  const fresh = overview?.data_fresh_at ?? null;

  async function rollback() {
    if (top?.type !== 'deployment' || !target) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api(`/incidents/${incident.id}/rollback`, {
        method: 'POST',
        body: { from_deployment_id: top.deployment.id, target_deployment_id: target.id },
      });
      toast(r.status === 'duplicate' ? 'Rollback was already requested' : `Rollback requested — tracked as deploy ${depLabel(r.deployment.number)}`);
      setConfirming(false);
      onVerdict();
      reloadOverview();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function notIt() {
    if (!top) return;
    setBusy(true);
    setErr(null);
    try {
      await setVerdict(incident.id, top, 'ruled_out');
      toast(`${suspectName(top)} ruled out`);
      onVerdict();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card hero" aria-label="Active incident">
      <div className="hero-main">
        <div>
          <div className="row">
            <span className="live-pill">LIVE · {incident.severity.toUpperCase()}</span>
            <span className="hero-meta">
              {incLabel(incident.number)} — {incident.status} · open for {duration(openFor)} — started {clock(incident.detected_at, true)} {tzName()}
            </span>
          </div>
          <h1>
            {headline(incident, signal)} {loadingSuspects ? null : <span className={top ? 'accent' : ''}>{verdictLine(top)}</span>}
          </h1>
          <p className="lede">{loadingSuspects ? 'Ranking suspects…' : lede(top, signal)}</p>
        </div>
        <div className="hero-side">
          {top && (
            <>
              <div className="row between" style={{ alignItems: 'baseline' }}>
                <span className="label">match confidence</span>
                <span className="confidence-value">
                  {Math.round(top.score * 100)}
                  <small>%</small>
                </span>
              </div>
              <Meter value={top.score} />
            </>
          )}
          {top?.type === 'deployment' &&
            can('engineer') &&
            (pending ? (
              <Link className="btn big block" to={`/projects/${project.id}/deploys?open=${pending.id}`}>
                <Icon name="rollback" /> Rollback {depLabel(pending.number!)} · {pending.after.label}
              </Link>
            ) : target ? (
              <button className="btn primary big block" onClick={() => setConfirming(true)} disabled={busy}>
                <Icon name="rollback" /> Roll back to {depLabel(target.number)}
              </button>
            ) : (
              <button className="btn big block" disabled title="No earlier clean deploy of this service/environment">
                No clean deploy to roll back to
              </button>
            ))}
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn block" onClick={() => navigate(`/projects/${project.id}/incidents/${incident.id}`)}>
              Open case
            </button>
            {can('engineer') && top && (
              <button className="btn block" onClick={notIt} disabled={busy} title={`Rule out ${suspectName(top)} and show the next suspect`}>
                Not it → next
              </button>
            )}
          </div>
          <ErrorBox error={err} />
        </div>
      </div>
      <div className="hero-foot">
        <span>
          <span className="label">commander</span>
          {incident.commander_name ?? <Link to={`/projects/${project.id}/incidents/${incident.id}`} className="muted">unassigned</Link>}
        </span>
        <span>
          <span className="label">rollback owner</span>
          {incident.rollback_owner_name ?? <Link to={`/projects/${project.id}/incidents/${incident.id}`} className="muted">unassigned</Link>}
        </span>
        <span>
          <span className="label">channel</span>
          {incident.channel ?? <span className="muted">—</span>}
        </span>
        <span>
          <span className="label">runbook</span>
          {incident.runbook ? (
            isUrl(incident.runbook) ? (
              <a href={incident.runbook} target="_blank" rel="noreferrer">
                {incident.runbook.replace(/^https?:\/\/[^/]+\//, '')}
              </a>
            ) : (
              incident.runbook
            )
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <span className="fresh mono small muted" title={fresh ? `Last event received ${new Date(fresh).toLocaleString()}` : 'No events yet'}>
          <span className="dot live" /> data fresh · {fresh ? `${shortAge(fresh, now)} ago` : 'never'}
        </span>
      </div>
      {confirming && top?.type === 'deployment' && target && (
        <Confirm
          title={`Roll back ${depLabel(top.deployment.number)} to ${depLabel(target.number)}?`}
          confirmLabel={`Request rollback to ${depLabel(target.number)}`}
          busy={busy}
          onConfirm={rollback}
          onClose={() => setConfirming(false)}
        >
          <p>
            bisect records a <strong>pending deploy</strong> of {target.version ?? depLabel(target.number)} to {top.deployment.environment ?? 'the same environment'} and moves{' '}
            {incLabel(incident.number)} to <strong>mitigating</strong>.
          </p>
          <p className="small">
            bisect does not run deployments itself — your CD pipeline should pick this up and report progress to the ingestion API with deployment id{' '}
            <code>
              rollback:{top.deployment.number}-&gt;{target.number}:{incLabel(incident.number)}
            </code>
            . Asking twice is safe.
          </p>
          <ErrorBox error={err} />
        </Confirm>
      )}
    </section>
  );
}

function AllClear({ ledger }: { ledger: LedgerRow[] }) {
  const lastDeploy = ledger.find((r) => r.type === 'deployment');
  return (
    <section className="card hero">
      <div className="hero-main" style={{ gridTemplateColumns: '1fr' }}>
        <div>
          <span className="live-pill calm">ALL CLEAR</span>
          <h1>Nothing is on fire.</h1>
          <p className="lede">
            {lastDeploy ? (
              <>
                Last deploy {depLabel(lastDeploy.number!)} ({lastDeploy.head?.message.split('\n')[0] ?? lastDeploy.version}) went live {timeAgo(lastDeploy.at)} and is{' '}
                <strong>{lastDeploy.after.label}</strong>.
              </>
            ) : (
              'No deploys recorded yet — connect GitHub or your CI under Integrations.'
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

// ---- intake & health ----------------------------------------------------------------------

function Intake() {
  const { project } = useProject();
  const { can } = useAuth();
  const since = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const { data, error, reload } = useApi<{
    received: number;
    duplicates: number;
    late: number;
    max_delay_seconds: number;
    out_of_order: number;
    edit_conflicts: number;
    policy: { dedup: string; ordering: string; conflicts: string; late_threshold_minutes: number };
  }>(`/projects/${project.id}/intake?since=${encodeURIComponent(since)}`);
  const refresh = useDebounced(() => void reload(), 1200);
  useLive(refresh);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Event intake · today</h2>
          <p className="muted small">What came in messy, and what we did with it.</p>
        </div>
      </div>
      <div className="card-body">
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : (
          <>
            <div className="stat-grid">
              <Stat value={data.received.toLocaleString()} label="events received" />
              <Stat value={data.duplicates} label="duplicates folded" />
              <Stat value={data.late} label={`arrived late${data.late ? ` · max +${duration(data.max_delay_seconds / 60)}` : ''}`} tone={data.late ? 'warn' : undefined} />
              <Stat value={data.edit_conflicts} label="edit conflicts caught" tone={data.edit_conflicts ? 'warn' : undefined} />
            </div>
            <dl className="policy">
              <dt>dedup key</dt>
              <dd>{data.policy.dedup}</dd>
              <dt>ordering</dt>
              <dd>{data.policy.ordering}</dd>
              <dt>late after</dt>
              <dd>{data.policy.late_threshold_minutes} min between happening and arriving</dd>
              <dt>conflicts</dt>
              <dd>{data.policy.conflicts}</dd>
            </dl>
            <div className="row">
              <Link className="btn block" to={`/projects/${project.id}/timeline?flags=late`} style={{ flex: 1 }}>
                Inspect late events
              </Link>
              {can('admin') && (
                <Link className="btn block" to={`/audit?project_id=${project.id}`} style={{ flex: 1 }}>
                  Open audit log <Icon name="arrow" size={14} />
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Health() {
  const { project } = useProject();
  const { data, error, reload } = useApi<any>(`/projects/${project.id}/dashboard?days=14`);
  const refresh = useDebounced(() => void reload(), 2000);
  useLive(refresh);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Health · last 14 days</h2>
          <p className="muted small">Resolution speed and how often a change caused trouble.</p>
        </div>
      </div>
      <div className="card-body">
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : (
          <div className="stat-grid">
            <Stat value={duration(data.incidents.mttr_minutes)} label={`mean time to resolve · ${data.incidents.resolved}/${data.incidents.total} resolved`} />
            <Stat value={duration(data.incidents.mtta_minutes)} label="mean time to acknowledge" />
            <Stat value={data.deployments.total} label={`deploys · ${data.deployments.failed} failed or rolled back`} />
            <Stat
              value={data.deployments.change_failure_rate == null ? '—' : `${data.deployments.change_failure_rate}%`}
              label={`change failure rate · ${data.deployments.caused_incident} confirmed causes`}
              tone={data.deployments.change_failure_rate > 15 ? 'accent' : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
