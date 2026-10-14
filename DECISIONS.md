# Decisions

Notes on how I built **bisect** and why: the four questions from the brief, then the product and design choices behind the interface.

---

## 01 · The most technically challenging part

**Making the final state independent of the order events arrive in.**

The brief says events can be late, duplicated or contradictory. Each of these is easy alone. The difficulty is that they interact. A retried CI webhook can deliver `succeeded` before `started`. The same alert can fire three times. A Jenkins job and Kubernetes can disagree about which commit a deploy shipped. A customer report can land an hour and a half after the outage began. If each of these is handled with its own special case, the result depends on timing, and a timeline that depends on timing can't be trusted during an incident.

I approached it in three layers:

1. **One way in.** Every fact goes through a single ingestion function: UI forms, the REST API, CI, GitHub webhooks and alerts. Each event gets its own transaction, and the first thing that transaction does is insert into an append-only `events` table that has a `UNIQUE(project_id, dedup_key)` constraint. The key is the source's own event id if it has one, else the UI's `Idempotency-Key`, else a content hash. Because the database enforces it, two concurrent copies of the same webhook cannot both get through. The second one only increments a counter.
2. **Event time, not arrival time.** Every event stores both `occurred_at` and `received_at`. Deploy status is last-writer-wins by *event time* (`status_at`). Start and finish take the widest interval. Commit membership is keyed by SHA rather than a foreign key, so a deploy can list commits we haven't received yet and they join up automatically. One of my tests delivers a deploy's `succeeded` before its `started` and asserts the final status, start and finish are what really happened.
3. **Never silently overwrite.** When two sources disagree, I keep the first value, store the rejected one in `deployments.conflicts`, return it as a warning to the sender, and show both in the UI. Incident edits work the same way at a human level (see 02).

The rest of the product builds on this guarantee. The timeline, the suspect ranking and the dashboard only have to read a consistent state.

## 02 · An important design decision

**Optimistic concurrency with field-level merge, and rejected edits kept in the activity feed.**

During an outage several people edit the same incident at once. I considered three options:

- **Last write wins.** Simple, but it silently loses someone's change. In an incident that might be the severity bump that pages the right people.
- **Pessimistic locking (one editor at a time).** Safe, but it blocks responders at exactly the moment speed matters, and locks get abandoned when a tab is closed.
- **Optimistic concurrency.** Every save carries the version it was based on.

I chose optimistic concurrency, but plain version checks are too strict: two people editing *different* fields would conflict for no reason. So each saved version records which fields it changed (`incident_revisions`). When a save arrives from an older version, the server locks the row, looks up what changed since, and then:

- if the fields don't overlap, the edits **merge** automatically;
- if the same field changed to a *different* value, it returns **409** with both values and who made the other change.

The UI shows a "theirs / mine" choice per field. The rejected edit is also written to the activity feed as *"Concurrent edits to severity: v3 · Alice — kept · v2 · Bob — saved to history"*, with **Compare** and **Keep Bob's instead**. Nobody's input disappears, nobody is blocked, and no update is lost. A test fires three simultaneous writers at the same incident to prove that last point.

## 03 · A limitation or failure case

**The suspect ranking is a heuristic. It's explainable, but it can be confidently wrong.**

bisect scores candidates on:

- timing against the *onset* of the error-rate spike;
- whether the deploy touched the affected service and environment;
- whether it shipped files that caused the same error before;
- keywords shared between the incident and the commits.

It never reads diffs, stack traces or logs. Some cases it handles badly:

- **A regression that surfaces slowly**, such as a memory leak that takes two days to bite. The recency decay pushes the real culprit down below whatever shipped that morning.
- **A cause outside the recorded world**, such as a provider outage or a dependency upgraded in a base image. The best-scoring deploy still looks guilty, because something always went out recently.
- **Without metrics**, the reference time falls back to the *detection* time. A slow alert then makes innocent deploys that went live between onset and detection look plausible.

I mitigate rather than solve this. Every point of score comes with a sentence explaining it. "Not it → next" rules a suspect out in one click and re-ranks the rest. Confirmed causes feed back into future ranking. But a responder still has to read the evidence; the tool shouldn't be trusted blindly.

Two smaller limitations are documented in the README. The real-time bus and presence are in-process, so multiple API replicas would need Postgres `LISTEN/NOTIFY` or Redis. And a "rollback" is a recorded request for the CD system, not an action bisect performs itself.

## 04 · With another week

**First: ingest stack traces and use them as evidence.**

The strongest signal an engineer actually uses is *"the top frame of the new errors is in a file this deploy changed."* I would add an error-sample ingestion endpoint (message, stack frames, count, time) and fingerprint traces the same way incidents are fingerprinted today. A deploy would then score on the share of new errors whose top frames it touched: a much stronger and more specific signal than file history, and it directly addresses the "confidently wrong" case in 03.

After that, in order:

1. **Multi-instance real-time.** Swap the in-process bus for Postgres `LISTEN/NOTIFY` behind the same interface, so the API can scale horizontally.
2. **Source trust for conflicting events.** Let a project rank its sources (e.g. "GitHub beats legacy Jenkins") instead of always keeping the first value.
3. **Outbound rollback.** A signed webhook to the CD system when a rollback is requested, closing the loop that is currently left to the pipeline.
4. **Run the Docker setup against a real PostgreSQL in CI.** Today I verify on PGlite (the same engine, compiled to WASM) and by type-checking the `pg` adapter. I'd like the networked path tested too.

---

## Product and design decisions

### Name and mark

**bisect**, after `git bisect`: binary search through history for the change that introduced a bug, which is exactly what the product helps people do. The mark is a rounded square holding a range of bars with the *middle* one picked out in the accent colour: a range, split, with the culprit highlighted. It's an SVG (`web/public/bisect.svg`) so it stays crisp at favicon size, plus a 512 px PNG for touch icons.

### Colour

I wanted the screen to stay calm when production isn't, and to make the one important thing impossible to miss.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#f4f0e8` warm paper | `#13110e` | page |
| `--surface` | `#fffdf9` | `#1d1915` | cards |
| `--text` | `#1d1813` warm near-black | `#f2ece2` | body text, primary buttons |
| `--muted` | `#857a6c` | `#9d9284` | metadata, labels |
| `--accent` | `#c2410c` rust | `#f0773b` | what broke (live pill, top suspect, onset line, SEV1, failing projects) and the primary action that fixes it |
| `--blue` | `#2f6bd8` | `#6f9ff5` | deploys, everywhere they appear |
| `--warn` | `#9a6408` amber | `#e2b04e` | messy data: late, conflicting, no deploy record |
| `--ok` | `#3b7a4c` | `#7cc28d` | resolved, all clear |

- **Warm neutrals instead of cool greys.** Most dev tools are blue-grey. Paper tones read as a document you can reason with rather than an alarm panel, and they keep a long incident page comfortable to look at.
- **One accent, used sparingly.** If everything is red, nothing is. Rust marks the culprit and the primary action on each screen; everything else stays neutral, so the eye goes there first.
- **Colour encodes meaning consistently.** Blue is always a deploy, amber is always "this data was messy", green is always "fine". The legend in the swimlane is the same vocabulary as the badges in the ledger.
- **Severity uses a heat ramp** (rust → orange → ochre → grey) instead of four unrelated hues.
- **Dark mode is designed, not inverted.** Every token has a dark counterpart chosen for contrast on a warm-black background. The accent gets lighter so it stays readable. Light is the default; the choice is remembered per browser and applied before first paint, so there's no flash.

### Typography

- **Inter Tight, 800, tight tracking** for headlines. The hero sentence ("1 in 6 checkout requests are failing. Deploy #2481 most likely broke it.") is meant to be read from across a room.
- **Inter** for body text.
- **JetBrains Mono** for anything a machine produced: SHAs, deploy and incident numbers, timestamps, uppercase labels. Mono makes those values scannable and signals "this is data, not prose".

### Layout and interaction

- **Lead with an answer, not a dashboard.** The overview opens with a sentence and one primary action, then the evidence (swimlanes, suspects), then the people (activity), history (recurring), and the record (ledger, intake).
- **Show the mess instead of hiding it.** The swimlane draws "when it happened" ● and "when we heard" ◌ as separate marks joined by a dashed line. The intake card counts duplicates folded and late arrivals. Responders trust data more when they can see how it was cleaned.
- **Every sentence is computed.** Headlines, reasons, ledger labels and the recurring-issue note are composed from data at read time. [VERIFICATION.md](VERIFICATION.md) traces each one to its source.
- **Human words for machine ids.** `INC-102` and `#2481` are per-project sequences, because people say "two-four-eight-one" in a call, not a UUID.
- **Keyboard first where it counts.** ⌘K / Ctrl K searches incidents, deploys, SHAs, people and projects from anywhere.
