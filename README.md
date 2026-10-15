<p align="center"><img src="docs/assets/bisect-wordmark.png" alt="bisect" width="420"></p>

<p align="center"><strong>Find the change that broke production.</strong><br>
Incident tracking and deployment forensics for teams whose events arrive late, twice, out of order, or contradicting each other.</p>

When production breaks, bisect answers four questions on one screen:

1. **What is broken, and how badly?** It uses the live error rate when you send one.
2. **Which deploy or change most likely caused it?** Candidates are ranked by evidence, and every point of the score is explained.
3. **In what order did things actually happen?** The order is by when events happened, not when they arrived.
4. **Has this happened before, and what fixed it?**

| | |
|---|---|
| **Backend** | Node.js · Express 5 · TypeScript · PostgreSQL (raw SQL) · Zod |
| **Frontend** | React 19 · Vite · TypeScript · hand-written CSS design system (light + dark) |
| **Real-time** | Server-Sent Events (live feed, presence, toasts) |
| **Integrations** | GitHub webhooks (HMAC), ingestion API for CI / CD / alerting, metrics API |
| **Verification** | 59 server tests + a 48-step browser run that starts from an empty database — see [VERIFICATION.md](VERIFICATION.md) |
| **Docs** | [Architecture & diagrams](docs/ARCHITECTURE.md) · [Design decisions](DECISIONS.md) · [Verification](VERIFICATION.md) |

---

## Getting started

```bash
npm run setup          # install server/ and web/ dependencies
npm run dev:server     # API on :4000 (embedded Postgres in server/.data/ when DATABASE_URL is unset)
npm run dev:web        # UI  on :5173 (proxies /api to :4000)
```

Open http://localhost:5173.

1. **Create the owner account.** A new install has no users, so the first screen asks for one. That account becomes the first **admin**, and the setup screen locks itself as soon as any user exists.
2. **Add your team** under *Users* (admin). Each person gets a role: `admin`, `engineer` or `viewer`.
3. **Create a project** from the sidebar, then open its **Integrations** page. It has the GitHub webhook URL and secret, the ingest token, and copy-paste `curl` examples for CI, alerting and metrics.

From then on, every deploy, commit, config change and alert that your tools send shows up on the timeline. Engineers can also record any of them by hand.

There is no sample data and there are no built-in accounts; everything you see is what you or your integrations put in.

---

## Running in production

```bash
# 1. a long random secret for signing sessions (the server refuses to start in production without one)
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env

# 2a. with Docker (app + PostgreSQL)
docker compose up --build -d                     # → http://localhost:4000

# 2b. or with your own PostgreSQL
DATABASE_URL=postgres://user:pass@host/db AUTH_SECRET=… NODE_ENV=production npm run build && npm start
```

Migrations run automatically on boot.

**Checklist:**
- **TLS.** Serve over HTTPS behind a reverse proxy, and set `TRUST_PROXY=1` (the number of proxy hops) so client IPs and the protocol are read correctly.
- **`PUBLIC_URL`.** Set it to the external URL so the webhook URL shown under Integrations is right.
- **HTTP/2.** Serve over HTTP/2 if people keep many tabs open (see the limitations below).
- **Backups.** Back up PostgreSQL. bisect keeps everything there; nothing important lives on the app server.
- **Accounts.** Rotate a project's ingest token and webhook secret from *Integrations* if they leak. Reset a user's password from *Users*; that signs them out everywhere.

Built in:
- `AUTH_SECRET` of 32+ characters enforced in production
- scrypt password hashing
- sessions revoked on any password change or reset
- login rate limiting per IP and email, with no account enumeration
- role re-check on every request
- HMAC-verified webhooks
- per-project ingest tokens
- Content-Security-Policy, HSTS (production), `nosniff`, `X-Frame-Options: DENY`
- immutable caching for hashed assets, `no-cache` for the HTML shell
- a full audit log

---

## Requirements coverage

| # | Requirement | Where |
|---|---|---|
| 01 | Create and manage projects | Sidebar **New project**; **Integrations** page: edit, rotate secrets, archive |
| 02 | Record deployments, code changes, incidents | UI forms (with Idempotency-Key), batch ingestion API, GitHub webhooks, metrics API |
| 03 | Event timeline per project | Swimlanes plus a list ordered by occurrence time, with late, out-of-order, duplicate and warning labels and filters |
| 04 | Associate incidents with responsible deploys/changes | Explainable suspect ranking for deploys *and* individual changes; suspected / confirmed / ruled-out links |
| 05 | Severity, status, assignees, resolution | Status machine (incl. `mitigating`); commander, rollback owner, assignee; channel, runbook; resolution required to resolve |
| 06 | Multiple users updating an incident | Optimistic concurrency with field-level merge, a conflict panel, rejected edits kept in the feed, live presence |
| 07 | Dashboard | Overview war room, 14-day health (MTTR, MTTA, change-failure rate), recurring-issue clusters |
| 08 | Duplicate, delayed, conflicting events | See [below](#how-messy-events-are-handled) |

**Bonus items:** GitHub webhooks, real-time updates, RBAC, deduplication, audit log, a failure-to-change correlation engine, rollback requests, ⌘K search, and a production container.

---

## What the overview shows during an incident

| Area | What it shows (all computed from your data) |
|---|---|
| **Hero** | "1 in N *service* requests are failing" (from the error-rate metric), the top-ranked suspect with match confidence, **Roll back to #N** (the last clean deploy of that service and environment), commander, rollback owner, channel, runbook, data freshness |
| **Swimlanes** | Changes, deploys, incidents, reports ("when it happened" ● → "when we heard" ◌) and the error-rate lane, with the onset marker; 1h / 6h / 24h / 7d |
| **Suspects** | Deploys and individual commits or config changes, each with its reasons; **Mark as cause**, **Rule out**, **View diff**, **Not it → next** |
| **Activity** | Updates, status and field changes, links, rejected concurrent edits (**Compare**, **Keep X's instead**), late reports and folded duplicates |
| **Keeps coming back** | Recurring issues over 90 days and what fixed them last time |
| **Deploy ledger** | Each deploy's aftermath: `soaking`, `suspect in INC-x`, `caused INC-x`, `clean · rollback target`, `no deploy record`… |
| **Event intake** | Today's received, folded, late and conflict counts, plus the active policy |

With no active incident, the hero shows **All clear** and the last deploy's state.

---

## How messy events are handled

| Problem | Handling |
|---|---|
| **Duplicates** | Dedup key = source `event_id` › `Idempotency-Key` › content hash, enforced by a `UNIQUE` constraint. Duplicates are counted ("folded"), never re-applied. Re-fired alerts update their incident. |
| **Late events** | `occurred_at` and `received_at` are stored on every event. Everything is ordered by occurrence. Events more than 5 min late are labelled. A late deploy that precedes an open incident triggers a "new suspect" notification. |
| **Out of order** | Deploy status is last-writer-wins by **event time**, and timestamps take the widest interval, so the final state is independent of delivery order. |
| **Incomplete records** | A commit naming an unseen deploy creates a placeholder. Deploys list commits by SHA and join up when the commits arrive. The UI shows what's missing. |
| **Conflicting events** | The first value is kept and the contradiction is stored and shown with both values. |
| **Clock skew** | Events more than 1 h in the future are rejected. |
| **Simultaneous edits** | Row lock plus version check. Different fields merge; the same field returns 409 with both values; the rejected edit is kept in the activity feed. |

---

## Architecture

```mermaid
flowchart LR
  UI[React UI] -- REST --> API
  CI[CI · CD · alerting · metrics<br/>X-Ingest-Token] --> API
  GH[GitHub webhooks<br/>HMAC] --> API
  API[Express API<br/>ingest · incidents · suspects · war room] --> DB[(PostgreSQL)]
  API -- SSE --> UI
```

All facts enter through one ingestion pipeline into an append-only `events` log (the timeline), which maintains the `deployments`, `changes` and `incidents` tables. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the ER diagram, the workflow diagrams, the scoring model and the RBAC matrix.

```
server/   API — services/{ingest,incidents,suspects,warroom,metrics,dashboard}.ts, routes/, db/migrations.ts
web/      React app — pages/, components/, styles.css (design tokens)
e2e/      browser verification (empty DB → setup → scenario via public API → every control)
docs/     architecture and diagrams
```

---

## API reference

All endpoints are under `/api` and use `Authorization: Bearer <token>`. Errors look like `{ "error": { "code", "message", "details" } }`.

| Method & path | Role | Purpose |
|---|---|---|
| `GET /auth/setup` · `POST /auth/setup` | – | Is first-run setup needed · create the owner (only while there are no users) |
| `POST /auth/login` · `GET /auth/me` · `POST /auth/password` | – / viewer | Session (rate-limited) · me · change my password (revokes other sessions) |
| `GET /users` · `POST /users` · `PATCH /users/:id` | viewer · admin · admin | Users, roles, admin password reset |
| `GET/POST /projects` · `GET/PATCH/DELETE /projects/:id` · `POST /projects/:id/rotate-secrets` | viewer / admin | Projects |
| `GET /projects/:id/overview` · `/swimlanes?from&to` · `/ledger` · `/recurring?days` · `/intake?since` · `/sources` · `/dashboard?days` | viewer | War-room read models |
| `GET /projects/:id/timeline?kinds&from&to&flags&incident_id` | viewer | Event timeline |
| `POST /projects/:id/events` | engineer or `X-Ingest-Token` (+ `X-Event-Source`) | Batch ingestion (≤ 500) |
| `POST /projects/:id/metrics` · `GET /projects/:id/metrics` | ingest token or engineer / viewer | Error-rate samples (idempotent upsert) |
| `GET/POST /projects/:id/deployments` · `GET /deployments/:id` | viewer / engineer | Deploys (+ commits, event history) |
| `GET/POST /projects/:id/changes` | viewer / engineer | Commits and config changes |
| `GET/POST /projects/:id/incidents` · `GET/PATCH /incidents/:id` | viewer / engineer | Incidents (PATCH requires `version`) |
| `GET /incidents/:id/feed` · `POST /incidents/:id/comments` | viewer / engineer | Activity |
| `PUT /incidents/:id/links` · `DELETE /incidents/:id/links/:type/:targetId` | engineer | Suspected / confirmed / ruled-out |
| `GET /incidents/:id/suspects` · `GET /incidents/:id/similar` | viewer | Ranked deploys + changes + error signal · similar incidents |
| `POST /incidents/:id/rollback` | engineer | Record a rollback request as a pending deploy |
| `POST/DELETE /incidents/:id/presence` | viewer | Presence heartbeat |
| `GET /search?q` | viewer | INC-numbers, #deploys, SHA prefixes, people, projects |
| `GET /audit` · `GET /stream` · `POST /webhooks/github/:projectId` · `GET /health` | admin · viewer · HMAC · – | Audit log · SSE · GitHub · liveness |

```jsonc
POST /api/projects/:id/events            X-Ingest-Token: ing_…   X-Event-Source: Kubernetes
{ "events": [
  { "type": "deployment", "deployment_id": "ci-812", "status": "started", "version": "v2.15.0",
    "commit_sha": "9f2c…", "commits": ["9f2c…"], "environment": "production", "service": "checkout",
    "occurred_at": "2026-10-14T09:00:00Z", "event_id": "ci-812-start" },
  { "type": "change", "kind": "config", "sha": "tf-71ab", "message": "DB_MAX_CONNS 50 → 20", "files": ["infra/db.tf"] },
  { "type": "incident", "alert_id": "pd-991", "title": "checkout 5xx", "error_signature": "pq: too many clients",
    "severity": "sev1", "service": "checkout", "occurred_at": "2026-10-14T09:14:00Z" }
]}
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | dev-only value outside production | HMAC key for sessions. **Required (32+ chars) when `NODE_ENV=production`.** |
| `DATABASE_URL` | *(empty → embedded PGlite)* | `postgres://…` for PostgreSQL; `memory` for a throwaway database |
| `PGLITE_DIR` | `server/.data/pglite` | Embedded Postgres data directory (development) |
| `PORT` | `4000` | HTTP port |
| `PUBLIC_URL` | request origin | External URL, used for the webhook URL shown in Integrations |
| `TRUST_PROXY` | `false` | `true` or a hop count when behind a reverse proxy |
| `TOKEN_TTL_HOURS` | `168` | Session lifetime |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | `10` / `15` | Failed sign-ins per IP and email before a temporary block |
| `LATE_THRESHOLD_MINUTES` | `5` | When an event counts as late |
| `SUSPECT_WINDOW_HOURS` | `72` | How far back suspects are considered |
| `WEB_DIST` | `web/dist` | Built UI served by the API |

---

## Testing

```bash
npm test                                      # 59 server tests on in-memory Postgres
npm run build --prefix web && npm run e2e     # 48 browser checks, starting from an empty database
```

The e2e run starts its own server on a throwaway database, creates the owner through the setup screen, and builds a realistic incident through the public API. That test scenario lives only in `e2e/scenario.mjs`, never in the application. It then clicks through every control and confirms each action through the API. See [VERIFICATION.md](VERIFICATION.md).

---

## Known limitations

- **Single instance for real-time.** The SSE bus, presence and the login rate limiter live in-process. Running several replicas needs Postgres `LISTEN/NOTIFY` or Redis behind the existing interfaces.
- **Browser connection limit.** Over HTTP/1.1 a browser allows about 6 connections per host, and each tab holds one stream. Serve over HTTP/2 for many tabs.
- **Suspect ranking is heuristic.** It uses timing against the error-rate onset, service, environment, file history and keywords. It doesn't read diffs or stack traces. It explains itself, and human verdicts override it.
- **Rollback is a request, not an action.** bisect records a pending deploy for your CD system to execute and report back on.
- **Accounts are self-contained.** Email and password with global roles. There is no SSO, no email-based password reset (admins reset passwords), and no per-project membership.
