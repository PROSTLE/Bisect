# Verification

This file is how to check that bisect does what the README says. For every feature and every control in the UI it names:

- **the code** that implements it,
- **the automated check** that proves it, either a server test (`server/test/*.test.ts`) or a browser end-to-end step (`e2e/run.mjs`),
- what is **not** verified.

The browser checks never trust the UI alone. After each click, the script reads the **API** to confirm the action really happened in the database.

---

## 1. Run it yourself

| Command (from the repo root) | What it proves | Time |
|---|---|---|
| `npm run setup` | installs `server/` and `web/` | ~1 min |
| `npm test` | **59 server tests** on a fresh in-memory Postgres per suite: ingestion rules, concurrency, ranking, war-room read models, HTTP auth/RBAC, first-run setup, sessions and passwords, production hardening | ~15 s |
| `npm run typecheck --prefix server` · `npm run typecheck --prefix web` | both TypeScript projects compile with `strict` | ~5 s |
| `npm run build` | production builds of web and server | ~10 s |
| `npm run e2e` | **48 browser checks**. Starts its own API on an **empty** in-memory DB, creates the owner through the setup screen, builds an incident through the public API (`e2e/scenario.mjs`), drives Chrome through every control, verifies each action through the API, then fails on any uncaught page error or 5xx | ~3 min |

`npm run e2e` needs `web/dist`, so run `npm run build --prefix web` first, plus Chrome or Edge (set `CHROME_PATH` if it isn't in a standard location). Failing steps are screenshotted to `e2e/artifacts/`, and the results are written to `e2e/artifacts/results.json`.

### Results of the last run

| Check | Result |
|---|---|
| `npm test` | **59 / 59 passed** |
| web + server typecheck | **clean** |
| `npm run build` | **succeeded** |
| `npm run e2e` | **48 / 48 passed**, no page errors, no 5xx |
| Migrations `002`/`003` on an existing database | `002` was applied to a populated `001` database (19 deploys backfilled with numbers 1–19); `003` adds `users.password_changed_at` |
| Production start (`NODE_ENV=production node server/dist/index.js`) | refuses to start without `AUTH_SECRET` or with one shorter than 32 chars; with a proper secret it migrates, reports "no users yet", serves the setup screen with CSP/HSTS/nosniff/X-Frame-Options, `immutable` caching for `/assets/*` and `no-cache` for the shell; Chrome shows **no CSP violations** and all fonts load |

Environment: Windows 11, Node 24, Chrome (headless), PGlite 0.5.9 (embedded PostgreSQL 18.6).

---

## 2. Requirements → code → proof

| # | Requirement | Implementation | Proven by |
|---|---|---|---|
| 01 | Create and manage projects | `routes/projects.ts`, `components/NewProject.tsx`, `pages/ProjectSettings.tsx` | test *enforces roles*; e2e *New project is created, then archived*, *editing the project description saves it*, *rotating secrets changes the ingest token* |
| 02 | Record deploys, changes, incidents | `services/ingest.ts`, forms in `DeploymentsPage`, `ChangesPage`, `ReportIncident` | tests *accepts CI events with the ingest token…*, *maps push and deployment_status payloads*; e2e *"Record deploy" form…*, *"Record change" form…*, *"Report incident" creates an incident* |
| 03 | Event timeline per project | `events` table, `GET /timeline`, `GET /swimlanes`, `components/Swimlanes.tsx`, `components/Timeline.tsx` | tests *final deployment state does not depend on arrival order*, *serves the war-room read models*; e2e *swimlane range tabs re-query*, *"Reported late" filter…*, *unticking "deployments"…* |
| 04 | Associate incidents with deploys/changes | `services/suspects.ts`, `incident_links`, `components/Suspects.tsx` | tests *ranks the recent same-service production deploy first…*, *human verdicts override…*, *boosts deploys that ship files implicated…*, *scores commits inside a suspect deploy and config changes…*, *ranks deploys against the metric onset…*; e2e *Mark as cause…*, *Not it → next…*, *+ link commit…* |
| 05 | Severity, status, assignees, resolution | `services/incidents.ts` (`IncidentPatch`, `checkTransition`), `pages/IncidentDetail.tsx` | tests *requires resolution details before resolving*, *cannot close an unresolved incident…*, *records acknowledgement time…*; e2e *incident edit saves through optimistic concurrency* |
| 06 | Multiple users updating an incident | `updateIncident` + `keepRejectedEdits`, `incident_revisions`, `components/Feed.tsx`, `lib/presence.ts` | tests *merges edits to different fields…*, *rejects conflicting edits…*, *serialises truly simultaneous writers…*, *keeps the rejected edit in the activity feed*, *tracks viewers per incident…*; e2e *a second browser … triggers the conflict panel*, *Compare…*, *Keep Rohan Mehta's instead…*, *presence…* |
| 07 | Dashboard | `services/warroom.ts`, `services/dashboard.ts`, `pages/Overview.tsx` | tests *serves the war-room read models…*, *labels what happened after each deploy*; e2e *hero headline…*, *hero footer…*, *sidebar…*, *all-clear hero* |
| 08 | Duplicate / delayed / conflicting events | `services/ingest.ts` | tests in *deduplication*, *out-of-order and late events*, *conflicting events*; e2e *Conflicting reports filter…*, *Incomplete records filter…* |

**Bonus items**

| Bonus | Implementation | Proven by |
|---|---|---|
| GitHub webhooks | `routes/webhooks.ts` | tests *verifies HMAC signatures* (×2), *maps push and deployment_status payloads*, *archived projects stop accepting … webhooks* |
| Real-time updates | `routes/stream.ts`, `lib/bus.ts`, `shell.tsx` | e2e *live: a deploy sent to the ingestion API appears without a reload*, *presence…* |
| RBAC | `lib/auth.ts` `requireRole` | tests *enforces roles*, *only admins can read the audit log*, *guards rollback by role*; e2e *viewer sees no write controls* |
| Dedup + audit logs | `events.dedup_key`, `lib/audit.ts` | tests *suppresses an identical delivery…*, *honours an Idempotency-Key…*; e2e *Audit log lists entries and expands a before/after diff* |
| Failure ↔ deploy correlation | `services/suspects.ts`, `services/metrics.ts` | see row 04 |

---

## 3. Every UI control

✔ = clicked in `e2e/run.mjs` and confirmed via the API. ◐ = covered by a server test of the same endpoint but not clicked. ○ = not automated (see §5).

| Where | Control | API call | Check |
|---|---|---|---|
| First run | owner setup form (only while there are no users) | `GET/POST /auth/setup` | ✔ *empty database: the app asks for an owner account…*, *setup form creates the owner…*, *setup is closed once an owner exists* · ◐ *creates exactly one owner even when two setups race* |
| Sign-in | email + password form (rate-limited) | `POST /auth/login` | ✔ *sign-in form signs an engineer in…*, *a wrong password is refused* · ◐ *rate-limits repeated failures per email* |
| Account | Your account → change password (+ sign out) | `POST /auth/password` | ✔ *Your account: changing my password…* · ◐ *changing my password signs out my other sessions* |
| Phone width | project switcher + account menu in the top bar | — | ✔ *phone width (390 px)…* |
| Top bar | search box / Ctrl+K palette, ↑↓ Enter | `GET /search` | ✔ *Ctrl+K search…* · ◐ *search* suite |
| Top bar | presence avatars "N in INC-…" | `POST /incidents/:id/presence`, SSE `presence` | ✔ *presence…* |
| Top bar | theme toggle (light ↔ dark, persisted) | — (localStorage) | ✔ *theme toggle…* |
| Top bar | Report incident | `POST /projects/:id/incidents` | ✔ *"Report incident"…* |
| Sidebar | nav links, incident count badge | `GET /overview` | ✔ *sidebar: incident count…* |
| Sidebar | project list with failing/degraded health | `GET /projects` (`worst_open_severity`) | ✔ *sign-in form … opens the failing project*, *all-clear hero* |
| Sidebar | New project | `POST /projects` | ✔ *New project is created…* |
| Sidebar | event sources with live ages | `GET /sources` | ✔ *sidebar: … event sources match the API* |
| Sidebar | sign out | — | ✔ *sign out…* |
| Overview hero | headline (error rate + top suspect), confidence | `GET /incidents/:id/suspects` | ✔ *hero headline…* |
| Overview hero | Roll back to #N (confirm dialog) | `POST /incidents/:id/rollback` | ✔ *"Roll back to #N"…* · ◐ *rollback requests* |
| Overview hero | Open case | — | ✔ *"Open case"…* |
| Overview hero | Not it → next | `PUT /incidents/:id/links` (ruled_out) | ✔ *"Not it → next"…* |
| Overview hero | commander / rollback owner / channel / runbook / data fresh | `GET /overview` | ✔ *hero footer…* |
| Swimlanes | 1h / 6h / 24h / 7d | `GET /swimlanes` | ✔ *swimlane range tabs…* |
| Swimlanes | click a deploy / change / incident marker | navigation | ○ |
| Suspects | Mark as cause / Clear verdict / Rule out | `PUT`/`DELETE /incidents/:id/links` | ✔ *Mark as cause…*, *Not it…* |
| Suspects | View diff | commit URL | ✔ *"View diff" links…* |
| Suspects | Show all N (incident page) | — | ○ |
| Activity | Post update | `POST /incidents/:id/comments` | ✔ *composer posts an update…* |
| Activity | + link deploy / + link commit | `PUT /incidents/:id/links` | ✔ *+ link commit* · ○ *+ link deploy* (same code path) |
| Activity | Compare (concurrent edit) | — | ✔ *"Compare"…* |
| Activity | Keep X's instead | `PATCH /incidents/:id` | ✔ *"Keep <engineer>'s instead"…* |
| Recurring | window selector | `GET /recurring?days` | ✔ *Recurring: the window selector…* |
| Ledger | row click → deploy / change | navigation | ○ |
| Event intake | Inspect late events / Open audit log | navigation | ○ |
| Incident page | every field + Save / Discard | `PATCH /incidents/:id` | ✔ *incident edit saves…* · ○ Discard |
| Incident page | conflict panel (Theirs / Mine, Save with these choices) | `PATCH` | ✔ *a second browser … "Save with these choices" resolves it* · ○ *Discard all my edits* |
| Incidents | status / severity / assignee / search filters | `GET /incidents` | ✔ status + severity + search · ○ assignee select |
| Deploys | status / environment / data-quality filters, row → detail modal | `GET /deployments`, `GET /deployments/:id` | ✔ data-quality filters + modal · ○ status/env selects |
| Deploys | Record deploy | `POST /projects/:id/deployments` | ✔ |
| Changes | text filter, kind filter, Record change | `GET /changes`, `POST /changes` | ✔ kind filter + Record change |
| Timeline | kind checkboxes, flag filter | `GET /timeline` | ✔ both |
| Integrations | Show / Copy secrets | — | ✔ Show · ○ Copy (clipboard permission in headless Chrome) |
| Integrations | Rotate secrets, Save project, Archive project | `POST /rotate-secrets`, `PATCH`, `DELETE /projects/:id` | ✔ all three |
| Audit log | project / entity filters, row expand | `GET /audit` | ✔ row expand · ○ filters |
| Users | Add user, change role, reset password | `POST /users`, `PATCH /users/:id` | ✔ *Users: add a user, then change their role*, *Users: "Reset password" signs that person out everywhere* |

---

## 4. "Nothing hard-coded": where every number and sentence comes from

| On screen | Source |
|---|---|
| "1 in **6** checkout requests are failing." | `signal.latest` from `errorSignal()` (latest `error_rate` sample) → `round(100 / latest)`; `signal.service`. Without metrics, the incident title is used instead. |
| "**Deploy #2481** most likely broke it." | First item of deploys + changes, ranked by verdict then score (`mergeSuspects`); wording depends on `confidence` and on a confirmed link |
| Lede sentence | That suspect's `reasons[]` from `findSuspects` (positive-weight reasons only) |
| match confidence **95%** | `score × 100` |
| **Roll back to #2480** | `rollback_target` from `rollbackTarget()`. The button becomes "Rollback #N · {after}" once a `rollback:` deploy exists in the ledger |
| `INC-102 — mitigating · open for 2h 40m — started 16:59:17` | incident `number`, `status`, `detected_at`; ticking clock; browser time zone |
| commander / rollback owner / channel / runbook | incident columns `commander_id`, `rollback_owner_id`, `channel`, `runbook` |
| data fresh · 2m ago | `max(events.received_at)` |
| "first spike · 16:58:00" line | `signal.onset_at` (first sample > max(1 %, 5 × baseline)) |
| "baseline 0.4%", "17.3%" in the error lane | 25th percentile / last point of the samples in the window |
| "3 late events re-sorted · 4 duplicates folded" | `counts` from `/swimlanes` for the window |
| Ledger "after" labels | rules in `ledger()` ([ARCHITECTURE §9](docs/ARCHITECTURE.md#9-war-room-read-models)) |
| "4×", strips, "again today", "INC-102 matches …" | `recurringIssues()`: union-find clusters, occurrences, `median_resolve_minutes`, `confirmed_causes` |
| Event intake numbers | `intake(since = local midnight)` |
| Event intake policy rows | returned by the API (`policy`, including the configured late threshold) |

Static by design: UI copy (headings, help text), the scoring weights (constants in `suspects.ts`, documented), and the example payloads on the Integrations page.

---

## 5. No demo data, no demo accounts

| Claim | Proven by |
|---|---|
| A fresh install has no users, projects or events, and asks for an owner account | e2e *empty database: the app asks for an owner account…*; server log `[setup] no users yet` |
| There is no demo endpoint and no built-in credential | test *has no demo endpoint* (404); e2e asserts the same; no seed module exists in `server/src` |
| The owner is created exactly once, even under a race | test *creates exactly one owner even when two setups race* |
| Test data lives only in the test harness | `e2e/scenario.mjs` uses the public HTTP API only; nothing in `server/` or `web/` references it |

## 6. Not verified (and why)

| Item | Status |
|---|---|
| `docker compose up` / the Dockerfile | **Not run.** Docker isn't installed on the machine this was built on. The same production path (`npm run build` → `node dist/index.js`) was run and works. |
| A standalone PostgreSQL server | **Not run.** All tests and e2e use PGlite 0.5.9, which is the real PostgreSQL 18.6 engine compiled to WASM, running identical SQL. `docker-compose.yml` uses `postgres:16`; the schema only needs features available since PostgreSQL 13 (`gen_random_uuid`, partial unique indexes, `ON CONFLICT`), but that combination was not run. The `pg` driver adapter for a networked server is exercised only by type-checking. |
| Real GitHub deliveries | **Not sent.** Signature verification and payload mapping are tested with synthetic payloads in GitHub's documented shape. |
| Browsers other than Chrome | **Not tested** (Firefox, Safari, mobile browsers). Phone *width* is checked in Chrome. |
| Several API replicas | **Not supported.** The event bus and presence are in-process (see README limitations). |
| Load / performance | **Not measured.** |
| Controls marked ○ in §3 | Not clicked by the script. They share code paths with checked controls, but were not individually automated. |
