// Builds a realistic incident through bisect's PUBLIC HTTP API only — exactly what real integrations
// and people would send. Nothing here is part of the application; it exists so the end-to-end run
// has something to click on. Times are relative to "now", so every event is (correctly) recorded as
// arriving late: that is how a replay looks to the ingestion pipeline.
import crypto from 'node:crypto';

const sha = (seed, prefix = '') => (prefix + crypto.createHash('sha1').update(seed).digest('hex')).slice(0, 40);
export const PASSWORD = 'e2e-password-123';
export const SIGNATURE = 'pq: sorry, too many clients already';

export async function buildScenario(api, ownerToken) {
  const ok = (r, what) => {
    if (r.status >= 300) throw new Error(`${what} → HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
    return r.body;
  };
  const now = Date.now();
  const T = now - (2 * 60 + 40) * 60_000; // when the failure started
  const at = (h) => new Date(T + h * 3600_000).toISOString();
  const daysAgo = (d) => new Date(now - d * 86400_000).toISOString();

  // ---- people (added by the owner, like a real team) --------------------------------------
  const people = {};
  for (const [key, name, role] of [
    ['riley', 'Riley Park', 'engineer'],
    ['sam', 'Sam Lee', 'engineer'],
    ['val', 'Val Ortiz', 'viewer'],
  ]) {
    const u = ok(await api(ownerToken, '/users', { method: 'POST', body: { name, email: `${key}@bisect.test`, role, password: PASSWORD } }), `create ${key}`).user;
    const token = ok(await api(null, '/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } }), `login ${key}`).token;
    people[key] = { ...u, token };
  }

  // ---- projects -----------------------------------------------------------------------------
  const project = ok(await api(ownerToken, '/projects', { method: 'POST', body: { name: 'storefront-api', description: 'Cart, checkout and search.' } }), 'project').project;
  const quiet = ok(await api(ownerToken, '/projects', { method: 'POST', body: { name: 'quiet-service', description: 'Nothing is wrong here.' } }), 'quiet').project;
  const send = async (events, source, p = project) =>
    ok(await api(null, `/projects/${p.id}/events`, { method: 'POST', headers: { 'x-ingest-token': p.ingest_token, 'x-event-source': source }, body: { events } }), `events (${source})`);

  // commits + rollout for one deploy; returns the commit SHAs
  const deploy = async (key, live, { service = 'checkout', env = 'production', commits, outOfOrder = false, pushCopies = 1 }) => {
    const shas = commits.map((c, i) => sha(`${key}-${i}`, c.prefix ?? ''));
    const changes = commits.map((c, i) => ({
      type: 'change',
      event_id: `gh-commit-${shas[i]}`,
      sha: shas[i],
      message: c.msg,
      author: c.author,
      files: c.files,
      branch: 'main',
      url: `https://github.com/acme/storefront-api/commit/${shas[i]}`,
      occurred_at: new Date(new Date(live).getTime() - (40 - i * 5) * 60_000).toISOString(),
    }));
    for (let n = 0; n < pushCopies; n++) await send(changes, 'GitHub webhooks');
    const base = { type: 'deployment', deployment_id: `k8s-${key}`, version: `v-${key}`, environment: env, service, commit_sha: shas[0], commits: shas, deployed_by: commits[0].author };
    const started = { ...base, event_id: `k8s-${key}-start`, status: 'started', occurred_at: new Date(new Date(live).getTime() - 4 * 60_000).toISOString() };
    const done = { ...base, event_id: `k8s-${key}-done`, status: 'succeeded', occurred_at: live };
    await send(outOfOrder ? [done, started] : [started, done], 'Kubernetes');
    return shas;
  };
  const alert = async (id, occurred, title, severity, service, signature, copies = 1) => {
    const ev = { type: 'incident', event_id: `${id}-trigger`, alert_id: id, title, severity, service, environment: 'production', error_signature: signature, occurred_at: occurred };
    let res;
    for (let n = 0; n < copies; n++) res = await send([ev], 'PagerDuty');
    return res.results[0].entity_id;
  };

  // ---- history: the same failure three times before -------------------------------------------
  await deploy('pool-shrink', daysAgo(54), { commits: [{ msg: 'pool: shrink idle pool to 5', files: ['db/pool.go'], author: 'riley' }] });
  const past1 = await alert('pd-past-1', new Date(new Date(daysAgo(54)).getTime() + 9 * 60_000).toISOString(), 'Connection pool exhausted', 'sev2', 'checkout', SIGNATURE);
  const oldCfg = sha('cfg-old');
  await send([{ type: 'change', kind: 'config', event_id: `tf-${oldCfg}`, sha: oldCfg, message: 'config: DB_MAX_CONNS 40 → 25', author: 'sam', files: ['infra/db.tf'], occurred_at: daysAgo(31) }], 'Terraform');
  const past2 = await alert('pd-past-2', new Date(new Date(daysAgo(31)).getTime() + 20 * 60_000).toISOString(), 'Connection pool exhausted on checkout', 'sev2', 'checkout', SIGNATURE);
  await deploy('pool-metrics', daysAgo(20), { commits: [{ msg: 'pool: export connection metrics', files: ['db/pool.go', 'metrics/pool.go'], author: 'riley' }] });
  await deploy('pool-lifetime', daysAgo(12), {
    commits: [
      { msg: 'pool: cap connection lifetime at 30s', files: ['db/pool.go', 'config/db.yaml'], author: 'sam' },
      { msg: 'checkout: copy tweaks', files: ['web/src/Checkout.tsx'], author: 'riley' },
    ],
  });
  const past3 = await alert('pd-past-3', new Date(new Date(daysAgo(12)).getTime() + 11 * 60_000).toISOString(), 'Checkout DB connections exhausted', 'sev1', 'checkout', SIGNATURE);
  for (let d = 5; d >= 1; d--) await deploy(`routine-${d}`, daysAgo(d), { commits: [{ msg: `cart: routine change ${d}`, files: ['cart/totals.go'], author: 'sam' }] });

  // ---- today ----------------------------------------------------------------------------------
  await send([{ type: 'deployment', event_id: 'argo-77', deployment_id: 'argo-77', service: 'payments-webhook', status: 'succeeded', occurred_at: at(-2.5) }], 'Argo CD'); // incomplete record
  const cfg = sha('cfg-today', 'c0f1a9e');
  await send([{ type: 'change', kind: 'config', event_id: `tf-${cfg}`, sha: cfg, message: 'config: DB_MAX_CONNS 50 → 20', author: 'sam', files: ['infra/db.tf'], occurred_at: at(-2.03) }], 'Terraform');
  await deploy('search-warm', at(-1.72), { service: 'search', commits: [{ msg: 'search: warm index on boot', files: ['search/boot.go'], author: 'sam' }] });
  await send([{ type: 'deployment', event_id: 'jenkins-4471', deployment_id: 'k8s-search-warm', commit_sha: sha('stale-ref'), deployed_by: 'jenkins', occurred_at: at(-1.72) }], 'Jenkins'); // conflicting report
  await deploy('cart-memo', at(-0.97), { commits: [{ msg: 'cart: memoize totals', files: ['cart/totals.go'], author: 'sam' }] });
  await deploy('pool-idle', at(-4 / 60), {
    outOfOrder: true,
    pushCopies: 3,
    commits: [
      { msg: 'pool: lower max idle conns', files: ['db/pool.go', 'config/db.yaml'], author: 'riley', prefix: 'a1b2c3d' },
      { msg: 'deps: bump pgx to v5.6.0', files: ['go.mod', 'go.sum'], author: 'sam', prefix: '7f3e9a1' },
      { msg: 'chore: tidy pool metric labels', files: ['metrics/pool.go'], author: 'riley' },
    ],
  });

  // error rate: ~0.4% baseline for a day, ~16% since the failure
  const points = [];
  for (let t = T - 29 * 3600_000; t <= now; t += 120_000) {
    points.push({ name: 'error_rate', service: 'checkout', at: new Date(t - (t % 120_000)).toISOString(), value: t >= T ? 15 + Math.random() * 2.5 : 0.3 + Math.random() * 0.25 });
  }
  ok(await api(null, `/projects/${project.id}/metrics`, { method: 'POST', headers: { 'x-ingest-token': project.ingest_token }, body: { points } }), 'metrics');

  const focusId = await alert('pd-focus', at(1 / 60), 'checkout 5xx spike', 'sev2', 'checkout', SIGNATURE, 3); // delivered three times
  await alert('pd-hooks', at(0.33), 'Payment webhooks lagging', 'sev2', 'payments-webhook', 'webhook queue age above threshold');
  await deploy('hotfix', at(1.43), { env: 'staging', commits: [{ msg: 'hotfix: retry on conn reset', files: ['db/retry.go'], author: 'riley' }] });
  // a person reports it long after it started
  ok(
    await api(people.sam.token, `/projects/${project.id}/incidents`, {
      method: 'POST',
      body: { title: 'Customers report checkout 500s', severity: 'sev3', service: 'checkout', detected_at: at(1 / 60) },
    }),
    'late report',
  );
  // something for the quiet project
  await send([{ type: 'deployment', deployment_id: 'q-1', status: 'succeeded', version: 'v1', environment: 'production', service: 'quiet' }], 'Kubernetes', quiet);

  // ---- people work the incidents ------------------------------------------------------------
  const dep = async (key) => ok(await api(ownerToken, `/projects/${project.id}/deployments?limit=200`), 'deploys').deployments.find((d) => d.external_id === `k8s-${key}`);
  const change = async (s) => ok(await api(ownerToken, `/projects/${project.id}/changes?limit=500`), 'changes').changes.find((c) => c.sha === s);
  const version = async (id) => ok(await api(ownerToken, `/incidents/${id}`), 'incident').incident.version;
  const link = (id, type, target, relation, token = ownerToken) =>
    api(token, `/incidents/${id}/links`, { method: 'PUT', body: { target_type: type, target_id: target, relation } }).then((r) => ok(r, 'link'));
  const patch = async (id, body, token = ownerToken) => api(token, `/incidents/${id}`, { method: 'PATCH', body: { version: await version(id), ...body } });

  await link(past1, 'deployment', (await dep('pool-shrink')).id, 'confirmed');
  await link(past2, 'change', (await change(oldCfg)).id, 'confirmed');
  await link(past3, 'deployment', (await dep('pool-lifetime')).id, 'confirmed');
  for (const id of [past1, past2, past3]) ok(await patch(id, { status: 'resolved', resolution: 'Reverted the pool change' }), 'resolve');

  const owner = ok(await api(ownerToken, '/auth/me'), 'me').user;
  ok(
    await patch(
      focusId,
      { status: 'investigating', commander_id: owner.id, rollback_owner_id: people.riley.id, assignee_id: people.riley.id, channel: '#inc-checkout-5xx', runbook: 'db-pool-exhaustion' },
      people.riley.token,
    ),
    'triage',
  );
  await link(focusId, 'deployment', (await dep('pool-idle')).id, 'suspected', people.sam.token);
  // two people change severity from the same version: the second is rejected and kept in the feed
  const base = await version(focusId);
  ok(await api(ownerToken, `/incidents/${focusId}`, { method: 'PATCH', body: { version: base, severity: 'sev1' } }), 'severity (owner)');
  const clash = await api(people.riley.token, `/incidents/${focusId}`, { method: 'PATCH', body: { version: base, severity: 'sev2' } });
  if (clash.status !== 409) throw new Error(`expected an edit conflict, got ${clash.status}`);
  ok(await patch(focusId, { status: 'mitigating' }, people.sam.token), 'mitigating');

  return { project, quiet, people, focusId };
}
