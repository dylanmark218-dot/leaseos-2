# Live Assist LA-1a — owner ruling and its limits

**Recorded 2026-09-25. LA-1a merged to `main` on 2026-10-01 by PR #81 (head `3dfcb3e`, merge `bdec6a5`).** LA-1b is not built; its prerequisites are in `docs/live-assist/LA1B_READINESS.md`.

**Recorded 2026-09-25.** This is the owner's ruling on the three decisions put to them after the LA-1
implementation plan (`docs/live-assist/LIVE_ASSIST_LA1_IMPLEMENTATION_PLAN.md`). It is the only authority for
the Live Assist code on `main`. Read it before extending that code.

> **A narrow infrastructure exception for LA-1a only.** It is not an exemption for Live Assist, for LA-1, or
> for any AI feature. The SPINE moratorium (`docs/register/SPINE_WIRING_PLAN.md`) and the Wave 0 security
> freeze stay in force for everything else.

---

## 1. Moratorium and Wave 0

**Ruling:** a narrow carve-out for **LA-1a only**. The general moratorium and the Wave 0 freeze are **not**
lifted.

The carve-out builds the Live Assist foundational session and lifecycle spine that later work needs. It is
granted in the same discipline as the Document Control precedent (one bounded checkpoint; every new module
reached from a mounted router or declared; nothing wider). **It does not claim Document Control's
justification.** LA-1a is not driver-job-spine work and does not advance a SPINE item.

**What it authorizes, exhaustively:**

- the `liveAssistSessions`, `liveAssistTurns`, `liveAssistFrames`, `liveAssistObservations`,
  `liveAssistEvents` and `liveAssistPolicies` tables (migrations `0202`, `0203`). The three transient tables
  have **no writer** in LA-1a; they exist so their purge exists first;
- session identity, tenant ownership, the authenticated actor, lifecycle states, start, heartbeat, pause,
  resume, end, expiry, retention, budgets, the policy and kill switch, the purge, authorization, and a
  metadata-only lifecycle record;
- the eight procedures `liveAssist.{start,heartbeat,pause,resume,end,policyGet,policySet,lifecycleList}`.

**What it does NOT authorize** (the owner's list, verbatim in substance):

- vision-model calls;
- cloud image processing;
- document-image transmission;
- form extraction;
- AI-generated form commits;
- permanent evidence creation;
- camera streaming;
- video streaming;
- screen sharing;
- autonomous actions;
- additional provider or vendor integration;
- LA-1b, LA-1c, LA-1d, or anything later.

Each of those remains blocked by its own prerequisites (§5). Adding any of them needs a new, explicit owner
ruling. Code review should refuse a change to the Live Assist files that reaches past the list above, and
`server/liveAssistBoundary.test.ts` fails the build for the mechanical cases (a model, storage, network,
capture or evidence import or call; logging; a non-strict input; a widened grant).

## 2. Cleanup lifecycle

**Ruling:** approved on the existing production worker, provided inspection shows it does not weaken the
worker's existing responsibilities. No second generic scheduler unless the worker genuinely cannot do it.

**What inspection found, and why the worker is appropriate:**

- `server/_core/drainWorker.ts` awaits `ports.heartbeat` after every poll, **outside** its own try/catch. A
  heartbeat that throws ends the loop, and with it outbox processing, enforcement notifications and webhook
  retries. The existing webhook retry sweep already runs there and guards itself.
- The heartbeat fires about once a second per process, and more than one worker process may run.

**How LA-1a rides it** (`server/_core/liveAssist/sweepTicker.ts`, composed in
`server/_core/productionWorker.ts`):

- after the existing heartbeat, never instead of it; `workflowRuntime.ts` is unchanged;
- at most once per 60 s per process, and never overlapping itself;
- never throws: every failure, including a logger failure, is caught;
- logs counts and a driver error code only, never a message, row, reference or content.

**How the purge meets each condition** (`sweepLiveAssist` in `server/liveAssistService.ts`, proved in
`server/liveAssistSweep.db.test.ts`):

| Condition | How |
|---|---|
| Deterministic | id order; fixed phases (expire, then purge) |
| Bounded per tick | at most 100 sessions per phase, 2,000 transient rows deleted |
| Retry-safe, idempotent, safe after restart | every stop is a conditional UPDATE; the purge marks a session only once all its rows are gone; a restarted worker simply continues |
| Safe with concurrent workers | only the worker whose UPDATE changed the row writes the event; tested with four concurrent sweeps |
| Tenant-safe | every DELETE names the session and its organization |
| Cannot delete permanent evidence | it issues no statement against any evidence table, and deletes frames only where `savedEvidenceRecordId IS NULL` |
| Server-controlled expiry | reads only `idleDeadlineAt`, `hardDeadlineAt` and `purgeAfter`, all written by the server |
| Failures contained | a failing session is counted and skipped; the next tick retries it |
| No visual media in logs | none exists in LA-1a, and the ticker logs counts only |
| Independent of the kill switch | retention is honoured with Live Assist switched off |

## 3. Roles

**Ruling:** `live_assist.use` for driver, dispatcher, mechanic, shop lead, office and management. No
administrator role is invented. No permission is widened to make Live Assist work.

As built:

| Permission | Roles | Sensitive |
|---|---|---|
| `live_assist.use` | driver, dispatcher, mechanic, shop_lead, office, management | yes |
| `live_assist.administer` | management | yes |
| `live_assist.review` | safety, management | yes |

These permissions authorize use of the session spine only. They do **not** imply permission to create
evidence, verify credentials, change safety records or perform any other domain action. LA-1b, LA-1c and
LA-1d operations must each satisfy the permissions of the domain they touch. In particular, dispatchers are
**not** given `evidence.upload`, and no `live_assist.save_evidence` permission exists yet.

## 4. Tenancy

LA-1a does **not** make organization-wide isolation a system property; `LEASEOS_CURRENT_STATE.md` still says
it is not, and that stays true. What LA-1a does:

- every new table carries `orgRef NOT NULL`, written from `resolveActingScope` and never from input;
- every input is strict, so a client-sent organization, user, state, deadline or image is refused;
- a session is found by its reference **and** its owner **and** the caller's current organization. Anything
  else is `NOT_FOUND` and is **not modified**, including the same person's session after their acting
  organization changes. That session stops by its own server deadline;
- the start retry key and the one-open-session rule are unique per (organization, user), never global;
- the purge's deletes name the organization as well as the session.

## 5. What remains blocked, and by what

| Blocked work | Prerequisite still open |
|---|---|
| LA-1b (ask about a photo) | P9.1 / AI-001 / SEC-12 hardening; D-13 model door (extend the Secretary `LlmProvider` with image parts, now on `main` via PR #7); D-03 vendor with written zero-retention and no-training terms; P9.6 telemetry seam or D-10 |
| LA-1c (photo → typed proposal) | everything LA-1b needs, plus **D-12, unresolved**: the scanner work's policy that document images are read **on the device only** conflicts with sending document frames to any cloud model. This ruling does not weaken that policy. It must be decided by the owner with security and privacy review before any document frame leaves a device |
| LA-1d (save as evidence) | the canonical per-uploader capture-reference / idempotency fix (tenant-scope `0173` or SEC-1 item 7), not duplicated here; the evidence viewer (`records.files.*`) |
| LA-2 and later | camera, streaming voice, screen share, video, native shell, proposed actions — each needs its own ruling |

## 6. Session designs reconciled

Two open-branch session-table designs were found by the 2026-09-24 survey. Since then, the identity design's
`sessionFamilies` (`0175`) has merged to `main`; the security design's `sessions` table has not.

A Live Assist session is **not** a login session, and LA-1a creates no third authentication abstraction:

- **identity** is `ctx.user`, established by `sdk.authenticateRequest`. Access credentials are stateless for
  `ACCESS_TOKEN_TTL_MS` (15 minutes, `server/_core/sessionFamily.ts`) and a revoked `sessionFamilies` row is
  refused at the next refresh, so a revoked login keeps at most that long to call Live Assist, as it does
  every other procedure;
- **acting organization** is `resolveActingScope`, per request, exactly as `sessionFamilies.tenantContext`
  ("reserved; acting scope stays resolved per request") intends;
- **the Live Assist row** is a unit of work owned by (organization, user). It stores no login reference.

Future reconciliation: if `ctx` later exposes the login family (or the security design's `sessions` row),
a nullable `authSessionRef` column can bind a Live Assist session to the login that opened it so that logout
ends it server-side. Until then logout is enforced by authentication on every call, by the client's
teardown, and by the idle deadline. Nothing in LA-1a has to be undone for that change.
