# Live Assist LA-1b — architecture and owner-ruling proposal

**Status: PROPOSAL. Nothing in this document is approved.** Every "recommended ruling" is a recommendation
for the owner. It becomes architecture only when the owner rules on it explicitly, as
`docs/live-assist/LA1A_OWNER_RULING.md` did for LA-1a. Until then:

- no LA-1b runtime code;
- no model call, image, vision, provider or Live Assist behaviour change;
- no migration number is claimed.

| | |
|---|---|
| Written against | `main` = `5be215d` (LA-1a merged by #81; test-id isolation by #88) |
| Builds on | `docs/live-assist/LA1B_READINESS.md` (the fourteen prerequisites). This document turns them into rulings and an architecture |
| Scope of LA-1b | Ask a text question inside an open Live Assist session and get a text answer. **Images are not in LA-1b**; they are a later checkpoint (§10, LA-1v) |
| Survey basis | `main` at `5be215d`, read in full for the AI runtime, both model doors, the outbox and drain worker, identity and session families, and LA-1a. File and line references below are to that commit |

Each ruling has the same six parts: **constraint now** (what the repository already says or does), **risk**, **recommended ruling**,
**alternatives**, **consequence** (what implementation it implies) and **owner approval**.

---

## 1. What `main` already decides or contains

Read these as facts, not proposals.

| # | Fact | Where |
|---|---|---|
| F-1 | Inference runs in the worker behind the outbox, never in request code. The one known violation, `assistant.draft → invokeLLM`, is pinned at exactly 1; a second fails the build | `docs/register/AI_AGENT_RUNTIME_ARCHITECTURE.md` §22 (F1); `server/aiRequestBoundary.test.ts:39-48, 199-218`; `server/_core/ai/workerBoundary.test.ts:35-118` |
| F-2 | The eventual worker loop is "a production-worker handler (the same shape as the existing `enforcement` handler)". No orchestrator module is to be created | `AI_AGENT_RUNTIME_ARCHITECTURE.md` §2, §22 |
| F-3 | "No second budget representation." Budget is consumed atomically *before* a step by a conditional `UPDATE`; "inference, token, cost and deadline budgets are designed later, on the same row" | §22 (P9.5) |
| F-4 | **No AI usage, token or cost ledger exists.** `agentRuns.stepsUsed`/`maxSteps` exist but nothing reads or writes them. Both model doors receive `usage` and discard it | `drizzle/schema.ts:7309-7310`; `server/_core/llm.ts:101-104`; `server/_core/ai/llm/openAiCompatibleProvider.ts:154-159` |
| F-5 | Two model doors. **Door 1** `invokeLLM` (`server/_core/llm.ts`): hard-coded fallback host, no timeout, four retries, raw upstream body in errors, shares the forge key with storage. **Door 2** `LlmProvider` (`server/_core/ai/llm/`): refuses unconfigured, no default host, 60 s timeout, no retries, text only ("no tools, no images"), **not wired** to any worker | §4 below |
| F-6 | The Secretary worker job (`runSecretaryExtractionJob`, event `secretary.narration.captured`) exists but is deliberately **not registered**; a test fails if it is | `server/_core/ai/worker/secretaryExtractionJob.ts:35, 64-108`; `workerBoundary.test.ts:123-131` |
| F-7 | The outbox (`domainEventOutbox`) gives same-transaction enqueue, a unique `eventId`, `SKIP LOCKED` claims, persisted backoff, dead-letter and lease-expiry recovery. It has **no fencing token on finish, one 120 s lease per batch, sequential processing, no per-handler timeout, no non-retryable class, raw `err.message` in `lastError`, and no claim-time dead-letter** | `server/_core/workflowRuntime.ts:360-466`; `server/_core/drainWorker.ts:25-225` |
| F-8 | Access tokens carry only `openId`, `appId`, `name` and `exp`, live 15 minutes, and are verified statelessly. `ctx` has no login reference. Revocation acts at the next refresh | `server/_core/sdk.ts:203-210`; `server/_core/context.ts:5-9`; `server/_core/sessionFamily.ts:34` |
| F-9 | LA-1a provides the session, tenancy, lifecycle, policy and kill switch, a required (but never compared) daily spend ceiling, the transient `liveAssistTurns`/`liveAssistObservations` tables with no writer, the bounded sweep, and session counters `inferenceCalls`, `inputTokens`, `outputTokens` that nothing writes | `drizzle/schema.ts:9438-9583`; `server/_core/liveAssist/policy.ts:28-38, 64-66, 92-102` |
| F-10 | `modelGateway` (licence gate, task routing) is pure and unwired, and has no `vision` task | `server/_core/modelGateway.ts:26-34, 87-148` |
| F-11 | The egress guard refuses private and link-local destinations and enforces a deadline with `AbortController`. Webhooks use it; neither model door does | `server/_core/egressGuard.ts:201-243, 334, 440` |

**The design document is superseded in one place.** `LIVE_ASSIST_DESIGN.md` D-10 said to "build the P9.6 telemetry
seam inside LA-1 if not already built". This proposal recommends building it in the shared AI layer (`server/_core/ai/`)
instead, so it is written by every inference and not owned by Live Assist (Ruling 13).

---

## 2. Rulings

### Ruling 1 — Execution topology

- **Constraint now:** F-1, F-2. `aiRequestBoundary.test.ts` fails the build at a second request-path model call.
- **Risk:** a synchronous `liveAssist.ask` would hold an HTTP request for up to the provider timeout. A provider outage
  would then exhaust request capacity and take Live Assist, and possibly the whole API process, down with it. It would
  also break the build guard.
- **Recommended ruling:** no model execution in any tRPC, HTTP or request handler. The split:

  `liveAssist.ask` (request path, no model module imported):
  1. authenticates the caller (`roleProcedure("liveAssist.ask")`, `live_assist.use`);
  2. resolves the acting organization and the caller's own open session (ref + owner + organization);
  3. applies deadlines, the kill switch and organization policy, refusing in the same way LA-1a's operations do;
  4. validates input shape and size with a strict schema (question text only; §2 Ruling 11);
  5. in **one transaction**: inserts the ask row (`queued`), the user's turn, and the outbox event; counts the ask as session activity;
  6. returns the opaque `turnRef` immediately.

  The worker (a registered production-worker handler):
  1. claims the ask by a conditional transition (`queued → running`) carrying a fresh run token;
  2. re-checks the caller's authority (Ruling 3);
  3. re-checks organization policy;
  4. re-checks the deployment kill switch;
  5. checks the circuit breaker (Ruling 7);
  6. reserves spend from the canonical budget (Ruling 2);
  7. builds the minimal context (Rulings 10, 11);
  8. calls the provider under a timeout;
  9. records the attempt's usage (Ruling 13) and settles the reservation;
  10. writes the permitted result (Ruling 12);
  11. transitions the ask to its terminal state, only if its run token still holds;
  12. leaves the result for the client to read (Ruling 14).
- **Alternatives:**
  - (a) A synchronous call with a short timeout. It is refused by F-1 and fails the build.
  - (b) A separate queue service. Refused unless the outbox is shown unsuitable; §4 shows it is suitable with the fixes in Ruling 1a.
- **Consequence:**
  - a new outbox event type (proposed `liveAssist.ask.requested`) and its handler registered in `productionWorker.ts`;
  - `aiRequestBoundary.test.ts` and `liveAssistBoundary.test.ts` stay unchanged, and both must stay green;
  - `liveAssistBoundary.test.ts` gains a second scope: the router and service may not import `server/_core/ai/**`, and only the new handler may.
- **Owner approval:** **REQUIRED**.

### Ruling 1a — Outbox hardening needed before an AI handler rides it

The outbox can carry one Live Assist ask as one durable job, but it needs five fixes first (F-7).

| Gap | Recommended fix | Where |
|---|---|---|
| A slow AI event delays every other event, because events are processed sequentially and the whole batch shares one lease | A dedicated AI worker process. `claimBatch` gains an event-type filter, so the AI process claims only AI events, one at a time, and the general worker excludes them | `workflowRuntime.ts`, `productionWorker.ts`, `worker.ts` |
| A worker whose lease expired can overwrite another worker's outcome (no fencing) | Correctness is fenced on **the ask row** (run token, Ruling 4), so a duplicate delivery is a no-op. Fencing `markProcessed`/`markFailed` by `claimedBy` is still recommended, following `webhookDispatchService.ts:140-152` | ask service; optionally `workflowRuntime.ts` |
| No per-handler timeout | The handler enforces its own total deadline with an `AbortSignal` passed to the provider | handler |
| No non-retryable class; every throw is retried five times | The handler **owns the ask state machine**. It classifies every outcome itself, writes the terminal state, and returns normally to the outbox. It throws only for an unexpected infrastructure failure, such as a lost database. The outbox's retry therefore never repeats a model call | handler |
| Raw `err.message` stored in `lastError` | The handler throws only sanitized errors carrying a code. A static test forbids interpolating provider errors into thrown messages | handler; test |
| A reclaimed event that crashes the process every time is never dead-lettered | The ask's own deadline bounds it: past `deadlineAt`, a claim converts the ask to `timed_out` and returns normally. Claim-time dead-lettering in the outbox is recommended separately (shared infrastructure) | handler; optionally `workflowRuntime.ts` |

- **Owner approval:** **REQUIRED** for the dedicated AI worker process and for any change to `workflowRuntime.ts`, because they touch shared infrastructure used by enforcement and webhooks.

### Ruling 2 — Budget authority

- **Constraint now:** F-3, F-4, F-9.
  - There is **no** canonical AI spend or usage implementation to point at.
  - `agentRuns.stepsUsed`/`maxSteps` are the only budget-shaped columns, and they are dead.
  - LA-1a added `inferenceCalls`, `inputTokens` and `outputTokens` on `liveAssistSessions`, plus a required `dailySpendCeilingCents` on its policy. Nothing compares the ceiling.
- **Risk:**
  - Building spend authority inside Live Assist creates the second representation §22 forbids. The next AI feature would then build a third.
  - Session counters that authorize spend could be bypassed by opening another session.
  - A ceiling that nothing compares gives false assurance.
- **Recommended ruling:** **one** authoritative AI spend mechanism, in the shared AI layer, used by every inference:

  1. **Spend authority (money):** a per-organization, per-UTC-day budget row.
     - The worker **reserves** an estimate with a conditional `UPDATE … SET reservedMicros = reservedMicros + :est WHERE reservedMicros + settledMicros + :est <= ceilingMicros` *before* the call. Zero rows affected means `refused / budget_exhausted`, with no call.
     - After the call, it **settles** the reservation to the measured cost.
     - Unknown price (no price on file for the model) is refused, not assumed zero.
     - This row is the only thing that authorizes a provider call on cost grounds.
  2. **The ceiling's source:** for Live Assist, the organization's `liveAssistPolicies.dailySpendCeilingCents`, applied as a **sub-limit** on the same row, with the feature named. It is not a separate counter. A future organization-wide AI ceiling lives on the same row.
  3. **Usage facts** (tokens, latency) go to the attempt telemetry record (Ruling 13). It is **not** a ledger: the settled cost is written once, to the spend row, referencing the attempt.
  4. **The Live Assist session counters:**
     - `inputTokens` and `outputTokens` are **retired**: derived on read from the attempts, never written.
     - `inferenceCalls` stays only as the **per-session abuse cap** against `maxInferenceCallsPerSession`. It is a policy limit on the unit of work's own row, matching §22's "on the same row" for counts. It can only refuse; it never authorizes spend.
     - `framesSubmitted` and `bytesSubmitted` are input caps for LA-1v, not AI spend.
- **Alternatives:**
  - **(A)** Keep all session counters, as a projection updated in the settling transaction. This writes token facts twice, which is a second representation in practice.
  - **(B)** Retire every session counter. This loses the cheap per-session abuse cap, so a policy limit on calls per session would need the attempts table read on every ask.
  - **(C, recommended)** Split by kind as above: money in one place, facts in one place, and a call-count cap on the unit of work.
  - **(D)** An `agentRuns` row per Live Assist session, carrying the budget columns. This forces Live Assist into the agent-run lifecycle, which has its own tRPC actions and states, and it still cannot express an organization-wide daily ceiling.
- **Consequence:**
  - New shared AI tables for spend and attempts (§5). They are built in LA-1b3, but **LA-1b2 may not call a provider until they exist**: no provider call without a reservation.
  - Retiring the two token columns is an `ALTER TABLE … DROP COLUMN` migration, or leaving them unwritten with a comment. The owner chooses.
- **Owner approval:** **REQUIRED**, both for the choice (C or another) and for building the shared spend authority. That authority also closes the cost part of P9.5.

### Ruling 3 — Re-authorization at execution time

- **Constraint now:** F-8, and the surveyed helpers.
  - `resolveActingScope(db, userId, {preferredOrgRef})` works outside a request (`server/_core/actingScope.ts:106-176`).
  - `authorize()` is pure (`server/_core/recordsAuthorization.ts:2170`), with grants from `listActiveUserRoles` (`server/db.ts:1181`).
  - `effectivePolicy` and `deploymentSwitchOn` are exported and read-only.
  - No worker anywhere re-validates a user's authority today. The nearest pattern is `server/assistantCommitService.ts:188-244`.
- **What the worker can and cannot check:**

| Authority | Checkable at execution? | How |
|---|---|---|
| User exists | Yes | Read `users` by id. There is no disabled flag (`schema.ts:4-14`), so existence is all it proves |
| Organization membership | Yes | `resolveActingScope(db, userId, {preferredOrgRef: ask.orgRef})` must return `tenantId === ask.orgRef`. `MembershipRevoked` or `AmbiguousOrganization` means refuse |
| Organization active | Yes | Built into the resolver (`organizations.status`) |
| Role and permission | Yes | Grants from `listActiveUserRoles`, then `authorize({permission: "live_assist.use", organization: ask.orgRef})`. Write `authorizationDecisions` and fail closed if that write fails, because the permission is sensitive |
| Live Assist session state | Yes | A new **read-only** lookup by ref + organization + owner, then `isOpen` and `evaluateDeadlines`. Do not use `applyOperation("heartbeat")`, which writes |
| Organization Live Assist policy | Yes | `effectivePolicy(db, orgRef, env).enabled` |
| Deployment kill switch | Yes, but with a caveat | `deploymentSwitchOn(process.env)` reads the **worker's** environment, which can differ from the web process's. Both processes must be configured identically; Ruling 16's deployment check enforces that |
| Spend authority | Yes | The reservation itself (Ruling 2) |
| A revoked **login** | **No** | Access tokens are stateless and carry no family claim. Holding the token in the job proves nothing beyond its `exp`. **The worker cannot tell that the login which asked has since logged out** |
| A disabled user | **No** | No such flag exists. The nearest signals are no live membership, or no unrevoked family |

- **Risk:** someone whose login was revoked keeps up to 15 minutes of access-token validity, as on every procedure. A queued ask adds at most its own total deadline on top.
- **Recommended ruling (smallest safe mechanism):**
  - **For text-only LA-1b,** the ask carries the actor's identity only (user id and organization). The worker re-checks every row in the table above that *can* be checked, immediately before the reservation and again before writing the result.
  - **The total deadline is short** (Ruling 5). The revocation window for a queued ask is then bounded by the access-token lifetime plus that deadline. State this residual risk plainly.
  - **Before any image is accepted (LA-1v),** bind each Live Assist session to the login family that opened it (`authSessionRef`, as `LA1A_OWNER_RULING.md` §6 anticipated):
    1. a **non-rotating** verification of the refresh cookie (verifier hash plus `openId` match) at session start;
    2. a session refused when no family exists (Bearer-only or family-less login);
    3. a worker point-read on `sessionFamilies.familyRef` (`revokedAt IS NULL AND absoluteExpiresAt > now`).
- **Alternatives:**
  - (a) Family binding from LA-1b1. It is stronger, but it needs a new function in the identity layer and refuses Bearer-only clients.
  - (b) A check that "the user holds *some* unrevoked family". It is cheap, but it does not prove *this* login is live.
  - (c) A per-user token generation counter bumped on logout and revoke-all, embedded in the access token. It changes the token format and every verifier, so it is too wide for this checkpoint.
- **Consequence:**
  - a re-authorization function in the Live Assist service;
  - one new read-only session lookup;
  - tests in which the worker refuses after the membership ends, the grant is revoked, the policy is disabled, the switch is off or the session has ended — **each before any provider call**.
- **Owner approval:** **REQUIRED**, both to accept the stated residual window for text-only LA-1b and to choose when family binding lands.

### Ruling 4 — States and fail-closed provider behaviour

- **Constraint now:** none. No ask exists.
- **Risk:** a vague state machine retries refusals, hides outages, and makes "it's still thinking" indistinguishable from "it died".
- **Recommended ruling:** the ask's state machine. Non-terminal states are `queued`, `running` and `retry_wait`; every other state is terminal.

```
queued ──claim──▶ running ──ok──────────────▶ completed
  │                 │ ├─ permanent refusal ─▶ refused        (code: see below)
  │                 │ ├─ transient, retry left, deadline left ─▶ retry_wait ─▶ running
  │                 │ ├─ transient, nothing left ─▶ provider_unavailable
  │                 │ ├─ deadline passed ─────────▶ timed_out
  │                 │ └─ unexpected internal fault ▶ failed
  ├─ session ended / paused / user cancel ──────▶ cancelled
  └─ queue age exceeded ────────────────────────▶ timed_out
running + cancel requested ──(result discarded)──▶ cancelled
```

| Terminal state | When | Retryable by the **user**? |
|---|---|---|
| `completed` | An answer was validated and stored | — |
| `refused` | A final decision. Codes: `kill_switch_off`, `policy_disabled`, `permission_denied`, `membership_ended`, `session_not_open`, `budget_exhausted`, `session_call_cap`, `input_invalid`, `unsupported_modality`, `content_refused`, `price_unknown`, `provider_not_configured` | No, not without something changing |
| `provider_unavailable` | The breaker was open, or transient failures exhausted the retry | Yes, later |
| `timed_out` | Queue age or the total deadline was exceeded | Yes |
| `cancelled` | The session ended, the session was paused, or the user cancelled | — |
| `failed` | An internal fault, such as an invalid model output after validation or a bug. It is logged by code only | Yes |

  - **Fencing:** the claim writes a fresh `runToken`. Every later write includes `WHERE runToken = ? AND state = 'running'`, so a duplicate or late delivery cannot overwrite the outcome.
  - **No unbounded wait:** every non-terminal state carries `deadlineAt`. The sweep converts anything past it to `timed_out` (Ruling 16).
  - **Unconfigured provider:** an unconfigured or invalid provider is `refused / provider_not_configured`, never a fallback.
- **Alternatives:** a single `failed` state with a free-text reason. That loses the distinction between "retry later" and "don't".
- **Consequence:** an enum column and a codes list shared by the server and client. Every transition is a conditional `UPDATE`.
- **Owner approval:** **REQUIRED** for the state set and the codes.

### Ruling 5 — Timeouts

- **Constraint now:**
  - the LA-1a idle window is 120 s (`policy.ts:28-38`);
  - `LlmProvider` defaults to 60 s;
  - the outbox lease is 120 s;
  - there is no production evidence for model latency here, because nothing has ever called a model in this system's worker.
- **Risk:** the timeouts nest wrongly. A provider timeout longer than the lease causes double delivery; a total deadline longer than the idle window lets a session expire under a running ask.
- **Recommended ruling:** three separate ceilings, configured in code with policy able only to *lower* them, and recorded as **initial recommendations, not approved policy**. The values must satisfy these invariants:

| Ceiling | Measures | Initial recommendation | Invariant |
|---|---|---|---|
| Queue/claim age | Enqueue → claim | 30 s | < total deadline |
| Provider request timeout | One HTTP attempt | 30 s | < total deadline; × 2 + margin < outbox lease (120 s) |
| Total job deadline | Enqueue → terminal state | 90 s | < session idle window (120 s) |

  - Each value is tuned in a pilot from attempt telemetry (Ruling 13).
  - The client is told `deadlineAt` so it can stop polling.
- **Alternatives:** a single timeout. It cannot separate "never started" from "started and hung".
- **Consequence:** constants in the Live Assist hard limits, plus tests that each ceiling is enforced (§8).
- **Owner approval:** **REQUIRED** to accept the invariants. The numbers are flagged as recommendations.

### Ruling 6 — Retry policy

- **Constraint now:**
  - Door 1 retries everything four times with up to 30 s backoff;
  - Door 2 does not retry ("the outbox owns them");
  - the outbox retries every throw five times.
- **Risk:** retrying refusals multiplies cost. Retrying without idempotency charges twice.
- **Recommended ruling:**
  - **Retryable**, and only while the total deadline allows: network errors, a single attempt's timeout, HTTP 408, 429 (honouring `Retry-After` only if it fits the deadline), 500, 502, 503 and 504.
  - **At most one retry** (two attempts) per ask.
  - **Never retried:** policy denial, permission denial, membership ended, session not open, kill switch off, budget exhausted, session call cap, malformed request, unsupported modality, content or security refusal, any other 4xx, and an invalid structured output.
  - **Idempotency:**
    1. the client sends `clientAskKey`, unique per (organization, user, session), so a re-sent ask returns the same `turnRef`;
    2. the outbox `eventId` is derived from `turnRef`;
    3. the attempt is numbered, with (`turnRef`, `attemptNo`) unique;
    4. the spend reservation is keyed by attempt, so one attempt can be charged once.
  - Outbox retries never re-run a model call, because the handler returns normally on every classified outcome (Ruling 1a).
- **Alternatives:** let the outbox's five-attempt backoff do the retrying. Refused: it retries permanent errors and keeps no attempt identity.
- **Consequence:** an error taxonomy on `LlmProvider` (Ruling 8) and a retry-classification table with tests.
- **Owner approval:** **REQUIRED**.

### Ruling 7 — Circuit breaker

- **Constraint now:** no circuit breaker exists anywhere in `server/`.
- **Risk:** during an outage every queued ask spends its timeout against a dead provider, which multiplies cost and delays answers.
- **Recommended ruling:** a breaker per (`providerKey`, `modelId`), held **in memory per AI worker process**. That is enough while the dedicated AI worker runs a handful of processes; a shared, database-backed breaker is a later option.
  - **States:** `closed` → `open` → `half_open` → `closed`.
  - **Opens** after N consecutive transient failures, or a failure rate above R over a window W.
  - **Cooldown** of C, then half-open.
  - **Half-open** admits exactly one probe. Success closes the breaker; failure re-opens it with the cooldown doubled up to a cap.
  - **Only transient failures count.** Refusals and invalid inputs never trip it.
  - **Telemetry:** every state change is a structured log line (provider, model, from, to, reason code). Each attempt records the breaker state it saw (Ruling 13).
  - **User-facing:** while it is open, the ask goes to `provider_unavailable` **without a provider call and without a reservation**. The message is "Live Assist can't answer right now. Try again in a minute."
  - **Initial recommendations, not policy:** N = 5, W = 60 s, R = 50 % with at least 10 calls, C = 30 s doubling to a 5-minute cap.
- **Alternatives:**
  - (a) A shared breaker in the database. It is consistent across processes, but it adds a write per call.
  - (b) No breaker, relying on timeouts only. Refused because of the amplification risk (§7, T-10).
- **Consequence:** a small pure breaker module in `server/_core/ai/`, with fake-clock unit tests.
- **Owner approval:** **REQUIRED** for adoption. The numbers are recommendations.

### Ruling 8 — Provider abstraction

- **Constraint now:** F-5, D-13 ("extend the Secretary layer's `LlmProvider`; never add images to `invokeLLM`").
  - `LlmProvider` already fails closed, has a timeout and is tested (`server/_core/ai/llmProvider.test.ts`).
  - Its gaps:
    - text only;
    - no caller-supplied `AbortSignal`;
    - one error class for every transport failure;
    - error messages include the base URL and up to 300 characters of the upstream body (`openAiCompatibleProvider.ts:128-139`);
    - credentials come from `LLM_API_KEY` rather than the S2-C `providerCredentials` service;
    - requests do not pass through the egress guard.
- **Risk:** a second, Live-Assist-only provider stack would duplicate configuration, error handling and tests, and drift from the Secretary path.
- **Recommended ruling:** extend `LlmProvider`, and do not create a Live Assist provider.
  1. **Capabilities are declared, not enabled:** `{ textInput, imageInput, structuredOutput, streaming, tools }`.
     - **Enablement** is a separate, deployment-level allow-list naming the provider, the model and the approved modalities. The owner's ruling populates it.
     - A request needing a capability that is declared but not enabled is `refused / unsupported_modality` before any network call.
  2. **Content parts:** `LlmMessage.content` becomes `string | LlmPart[]`. LA-1b defines only `{type: "text"}`; `{type: "image"}` is **reserved, not implemented**.
  3. **Signals:** `complete(request, { signal })`, so the job's deadline aborts the HTTP request.
  4. **Error taxonomy:** `LlmNotConfigured`, `LlmTimeout`, `LlmRateLimited` (with `retryAfterMs`), `LlmUnavailable` (5xx/network), `LlmRejected` (other 4xx) and `LlmOutputInvalid`. The retryable ones are marked. **Messages carry a code and an HTTP status only, never the base URL, headers or body.**
  5. **Egress:** provider requests go through the egress guard (`egressGuard.ts`), and the base URL's host must be on an allow-list set in configuration.
  6. **Credentials:**
     - LA-1b keeps `LLM_API_KEY`, which is already fail-closed and distinct from the storage credential.
     - Moving to `providerCredentials.resolveForOutbound` is a separate decision (SEC-9).
  7. **The job/state machine** depends only on the interface, so adding image input later changes the context builder and the capability allow-list, not the worker states.
- **Alternatives:**
  - (a) Wire `modelGateway` now for licence gating. It is useful, but it is optional for one approved model; recommended for when there is more than one.
  - (b) A new provider abstraction. Refused (D-13).
- **Consequence:**
  - changes under `server/_core/ai/llm/`;
  - `llmProvider.test.ts` extended;
  - the unwired Secretary job is unaffected, apart from adopting the new error classes.
- **Owner approval:** **REQUIRED** (it extends a shared module).

### Ruling 9 — Vision and image policy (not in LA-1b)

- **Constraint now:**
  - LA-1a hard limits allow `sourcesAllowed: ["photo"]`, but there is no image path;
  - D-03, D-11, D-12 and D-14 are open or recorded in the design;
  - `LA1A_OWNER_RULING.md` §1 excludes vision.
- **Recommended ruling:** **no image is accepted until a separate owner ruling (LA-1v) records every item below.**
  - an approved provider and model;
  - written retention terms;
  - written training and data-use terms, recorded against the credential;
  - the data-processing region;
  - maximum image size and images per ask;
  - accepted MIME types, checked by content and not by extension;
  - metadata stripping, with the EXIF/GPS rule from D-11;
  - whether bytes are transient only (proposed: worker memory for one call; the job carries a short-lived reference, not bytes);
  - the evidence-separation rule;
  - the file-validation boundary (decode and re-encode before sending, and a size limit before decode);
  - per-image cost accounting in the canonical budget;
  - the document-image rule (D-12, unresolved).
  - **A Live Assist image never becomes evidence by being asked about.** Saving is a separate, deliberate act (LA-1d), with the domain's own permission and record type (D-14).
- **Owner approval:** **REQUIRED**. It is a separate ruling.

### Ruling 10 — Data minimization

- **Constraint now:**
  - SEC-6 data classes are not built (`docs/security/…` on an unmerged branch);
  - `LA1B_READINESS.md` decision 7.
- **Recommended ruling:** the worker's context builder is a pure function with a closed, typed input.

| Source | Included? | Reason |
|---|---|---|
| The user's question for this ask (capped) | Yes | It is the request |
| Server-authored instructions (versioned) | Yes | Behaviour, certainty wording, safety rules |
| Up to the last *k* turns **of this session only** (proposed *k* = 6, capped by characters) | Yes | Conversational continuity, and D-05 retention already applies |
| The organization's display name, the user's name, ids, references, location, device data | **No** | Not needed to answer |
| Any LeaseOS record, database row, evidence, file or blob | **No** | No reason has been ruled. Admitting any source needs SEC-6 and its own reason |
| Credentials, API keys, tokens, cookies, headers | **Never** | — |
| Earlier sessions | **Never** | D-05: never retrievable across sessions |

  - A test enforces this by construction: the builder's input type has no field through which a row could pass.
- **Owner approval:** **REQUIRED**.

### Ruling 11 — Prompt construction

- **Recommended ruling:**
  - **What the client sends:** `liveAssist.ask` accepts exactly `{ sessionRef, clientAskKey, question }` through a strict schema; the question is plain text with a proposed cap of 2,000 characters.
  - **What the client cannot choose:** the system prompt, provider, model, temperature, token limit, organization or context. A strict schema refuses any extra key.
  - **Prompt versioning:** the system prompt is a server-side constant with a `promptVersion` id. The ask records the version, **not the full prompt text**.
  - **Fencing user text:** user text is enclosed in a delimited, labelled block, and the instructions state that content inside it cannot change instructions. This is a mitigation, not a guarantee (T-1).
  - **Output:** structured output against a schema (answer text, certainty, safety class, optional request for another view), validated server-side with zod. Wording for certainty and safety notices is applied server-side.
  - **Persistence:** the question and answer are persisted under D-05 (purged 24 h after the session ends). Prompt material beyond the version id is not persisted.
- **Owner approval:** **REQUIRED**.

### Ruling 12 — Result persistence

| Item | Stored? | Where | Retention |
|---|---|---|---|
| Ask metadata (ref, state, timestamps, attempt count, final code, prompt version, provider and model ids) | Yes | Ask row | With the session purge (D-05) |
| The user's question | Yes, capped and redacted per the existing `redactionFlagsJson` | `liveAssistTurns` (role `user`) | D-05 |
| The answer | Yes, after validation | `liveAssistTurns` (role `assistant`) and `liveAssistObservations` | D-05 |
| Usage (tokens, latency) | Yes | Attempt telemetry (shared) | Its own retention ruling (Ruling 16) |
| Cost | Yes | Spend authority only | Finance retention |
| Provider request and response ids | Yes, the request id only | Attempt | As the attempt |
| Final error or refusal code | Code only | Ask and attempt | As above |
| Sensitive context (the builder's assembled input) | **No** | — | — |
| Raw provider response, SDK error, headers, body | **Never** | — | — |
| Model reasoning | **Never** (P9.9) | — | — |

- **Owner approval:** **REQUIRED**.

### Ruling 13 — Telemetry

- **Constraint now:**
  - P9.6 / AI-006 are open;
  - D-10 proposed building the seam inside Live Assist; this proposal supersedes that (§1).
- **Recommended ruling:** one shared attempt record per provider call, written by the worker in `server/_core/ai/`.
  - **Fields:** correlation id (the `turnRef`), feature (`live_assist`), organization, attempt number, provider, requested model and answered model, prompt version, start, latency, input and output tokens (where reported), result category, retry number, whether it timed out, the breaker state seen, and the provider request id.
  - **Exactly once per attempt:** the row is inserted at start under a unique (correlation, attempt) key and finished once. A row left `started` is closed as `abandoned` by the sweep.
  - **Not a billing ledger:** it holds **no money**. The settled cost lives only on the spend authority, referencing the attempt.
  - **No content:** no question, answer or error text.
- **Owner approval:** **REQUIRED**. It also closes the P9.6 seam for door 2.

### Ruling 14 — Result retrieval

- **Recommended ruling:** polling first, no streaming.

| Procedure | Permission | Returns |
|---|---|---|
| `liveAssist.ask({sessionRef, clientAskKey, question})` | `live_assist.use` | `{ turnRef, state: "queued", deadlineAt }` |
| `liveAssist.getTurn({sessionRef, turnRef})` | `live_assist.use` | State, final code, answer (when completed), `retryAfterMs` hint |
| `liveAssist.listTurns({sessionRef, afterSeq?})` | `live_assist.use` | This session's asks and turns, newest last, capped |
| `liveAssist.cancelTurn({sessionRef, turnRef})` | `live_assist.use` | The new state (Ruling 15) |

  - **Opaque references:** `LAT-…`, the same pattern as `LAS-…` and `LAP-…`. Database ids are never exposed.
  - **Every read** filters by ref + organization + owner. Anything else is `NOT_FOUND`, as in LA-1a.
  - **Reviewers** keep `lifecycleList`, which is metadata only and never content.
  - **Reads write nothing.** `getTurn` does not extend the session; heartbeats do.
- **Consequence:**
  - four procedures, so the census and permission pins move by 4;
  - client polling uses backoff of 1 s, then 2 s, then 5 s, stopping at `deadlineAt`.
- **Owner approval:** **REQUIRED**.

### Ruling 15 — Cancellation

- **Recommended ruling:**
  - **Ending or expiring a session** cancels the session's `queued` and `retry_wait` asks *in the same transaction*, and marks `running` asks `cancelRequested`.
  - **Pausing** does the same. A queued ask does not survive a pause; the user asks again after resuming. This keeps the rule simple and deterministic.
  - **User cancellation** is supported: `queued`/`retry_wait` go to `cancelled`, and `running` sets `cancelRequested`.
  - **In-flight requests:** the worker aborts its HTTP request through its `AbortSignal` if it observes cancellation between steps, which it checks before the call and before writing the result. **An HTTP request already sent cannot be recalled from the provider.** Its tokens may still be billed and are settled to the spend authority. Its answer is discarded and never shown.
  - **Races:** every transition is a conditional `UPDATE`, so the first commit wins.
    - A claim that loses to a session end finds the ask `cancelled` and does nothing.
    - A completion that loses finds `cancelRequested` and writes `cancelled`.
- **Alternatives:**
  - (a) Keep queued asks across a pause, up to the queue-age ceiling. That needs a re-check on resume.
  - (b) No user cancel.
- **Owner approval:** **REQUIRED**.

### Ruling 16 — Cleanup and retention

- **Constraint now:**
  - LA-1a's bounded sweep (`sweepLiveAssist`) expires sessions, then purges the transient rows after `purgeAfter`;
  - `liveAssistEvents` is append-only (triggers);
  - frames with `savedEvidenceRecordId` are never deleted.
- **Recommended ruling:** extend the same sweep, still bounded per tick, idempotent and safe across concurrent workers.
  1. **Time out** asks past `deadlineAt`: non-terminal → `timed_out`.
  2. **Close abandoned attempts:** started rows past the lease become `abandoned`, and their reservations are released or settled.
  3. **Purge** asks with the session's turns and observations at `purgeAfter`.
  4. **Lifecycle events** stay immutable and carry metadata only, never question or answer text.
  5. **Shared data** is never touched by the Live Assist sweep: attempt telemetry and spend rows have their own retention, which the owner rules on (proposed: telemetry 90 days; spend per finance retention).
  6. Anything promoted into another retained subsystem is never deleted by it (evidence is out of scope).
  7. **Deployment check:** the worker logs at start whether `LIVE_ASSIST_ENABLED` is set, so a mismatch between the web and worker processes is visible (Ruling 3).
- **Owner approval:** **REQUIRED**, including the retention periods for the shared rows.

---

## 3. Unresolved owner decisions (checklist)

1. Rulings 1–16 above, each marked REQUIRED.
2. The dedicated AI worker process, and whether to change the shared `workflowRuntime.ts` (Ruling 1a).
3. Budget option C (or A, B or D), and building the shared spend authority (Ruling 2).
4. Accepting the residual revocation window for text-only LA-1b, and when family binding lands (Ruling 3).
5. Whether to drop the two token columns or leave them unwritten (Ruling 2).
6. Retention periods for attempt telemetry and spend rows (Ruling 16).
7. A text provider and model for LA-1b2, with written terms (`LA1B_READINESS.md` decisions 3 and 4). **No vendor is chosen here.**
8. P9.1 as its own checkpoint LA-1b0, and the deployment-configuration change it implies (§4).
9. The separate vision ruling LA-1v (Ruling 9), including D-12.

## 4. P9.1 / AI-001 / SEC-12 — survey and remediation plan

**State: OPEN.** `docs/REMAINING_BUILD_REGISTER.md:125` (P9.1, "high priority, security") is unchanged on `main`.

**What the survey found** (all on `main` `5be215d`):

| Area | Door 1 `invokeLLM` (`server/_core/llm.ts`) | Door 2 `LlmProvider` (`server/_core/ai/llm/`) |
|---|---|---|
| URL resolution | `resolveApiUrl` falls back to `https://forge.manus.im/v1/chat/completions` when `BUILT_IN_FORGE_API_URL` is unset (`:220-223`). `listLLMModels` repeats the fallback (`:441-444`). **Fails open** | `LLM_BASE_URL` with no default; throws `LlmNotConfigured` (`config.ts:34-46`, `openAiCompatibleProvider.ts:58-63, 82-84`) |
| Credential | `BUILT_IN_FORGE_API_KEY` only. The error names the wrong variable, `OPENAI_API_KEY` (`:225-229`). It is the **same key storage uses** (`server/storage.ts:17-27`) | `LLM_API_KEY`. No auth header without a key (`:122`) |
| Default model | None sent; the gateway chooses | `LLM_MODEL` required |
| Network client | Global `fetch` with no egress guard | Injectable `fetchImpl` with no egress guard |
| Timeout | **None** | 60 s via `AbortController` (`:46, 113-126`), untested |
| Retries | 4, up to 30 s each, on any non-2xx (`:276-343`) | None |
| Errors | **Raw upstream body** in the thrown message (`:417-420, 451-454`). There is no tRPC error formatter (`trpc.ts:13-15`) | Base URL plus up to 300 characters of the body (`:128-139`) |
| Provider/model recorded | `assistant.draft` reads only the message content and discards `result.model` (`server/routers.ts:869`) | Returns `modelId`, which nothing stores |
| Callers | One: `assistant.draft` (`server/routers.ts:816, 857`), a request handler, which is the pinned violation | No production caller (unwired worker job, eval script) |
| Tests | **None for `llm.ts`** | `llmProvider.test.ts`: refusal, no foreign host in source, no auth without a key, no retry |
| Production boot check | `assertProductionSecrets` does not check the forge variables (`env.ts:116-152`) | — |

The other forge modules share door 1's URL and key, but **none has a hard-coded host**, and each refuses when its configuration is missing.

| Module | Status |
|---|---|
| `storage` | Live |
| `notification` | Live, through an admin procedure. Fails soft |
| `imageGeneration` | Unused |
| `voiceTranscription` | Unused |
| `dataApi` | Unused |
| `map` | Unused. Puts the key in a query string |
| `heartbeat` | Unused |

All of them put raw upstream text into errors and have no timeouts. The only `forge.manus.im` literals in `server/` are the two in `llm.ts`.

**The security property:** if provider configuration or a credential is missing or invalid, the AI execution path refuses
safely before any network call, and never falls back to an unapproved host or credential.

**Remediation plan.** This is proposed checkpoint **LA-1b0**, on its own branch. It is narrow, independent of Live Assist, and implemented only when the owner rules.

1. **No fallback host.** Remove both `forge.manus.im` fallbacks. An unset or blank `BUILT_IN_FORGE_API_URL` throws a not-configured error before `fetch`, and the error names the right variable.
2. **Bounded time.** Add an `AbortController` timeout to `invokeLLM`, and cap its retries so the worst case is bounded and shorter than a request should be held. Proposed: one retry and a 30 s ceiling overall. This is the request-path call `assistant.draft` still makes.
3. **No raw bodies.**
   - Thrown errors carry an HTTP status and a code only.
   - `assistant.draft` maps them to a generic `TRPCError`.
   - Door 2's messages drop the base URL and body.
4. **Guards** (tests):
   - no `https?://` literal for a vendor host in `llm.ts`, following `llmProvider.test.ts:48-63`;
   - an unconfigured URL or key refuses with `fetch` never called;
   - the timeout aborts;
   - a thrown error never contains the upstream body;
   - a `server/`-wide guard that `forge.manus.im` appears nowhere.
5. **Out of scope for LA-1b0** (named so they are not lost):
   - moving `assistant.draft` to the worker (F1 is "guard only");
   - recording model and provenance on proposals (P9.2);
   - splitting the storage and LLM credentials (SEC-9);
   - timeouts and body redaction for the other forge modules (SEC-12, tracked separately);
   - egress-guarding door 1.

**Behaviour change the owner must accept.** A deployment that sets `BUILT_IN_FORGE_API_KEY` but not the URL, and is
silently using the fallback today, will refuse instead. The deployment must set the URL explicitly before LA-1b0 ships.
`assistant.draft` is the only affected feature.

**Recommendation:** LA-1b0 can be fixed independently and safely, as its own branch and PR, **before** any LA-1b code.
It touches one request-path feature and no schema.

## 5. Proposed LA-1b schema (design only; no migration numbers claimed)

**The migration survey** found:
- `main` holds migrations up to `0209`;
- remote branches claim `0200`–`0201`, `0205`–`0206` and `0210`–`0213`;
- the highest claim is `0213_runtime_instances.sql` on `security/s2-fleet-runtime-identity`.

Numbers are taken at PR time by the scan in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

### 5.1 `liveAssistAsks` (new, Live Assist, transient)

One row per question. It holds state and identity; the text lives in `liveAssistTurns`.

| Column | Purpose |
|---|---|
| `id` | Internal key |
| `turnRef` | Opaque public reference (`LAT-…`), unique |
| `sessionId`, `orgRef`, `userId` | Owner binding. `orgRef` comes from `resolveActingScope`, never from input; `userId` from `ctx.user` |
| `clientAskKey` | Unique (`orgRef`, `userId`, `sessionId`, `clientAskKey`), for idempotent enqueue |
| `state` | Ruling 4 enum |
| `finalCode` | Ruling 4 codes, null until terminal |
| `cancelRequested` | Boolean |
| `runToken` | Fencing token, rewritten at each claim |
| `attemptCount` | Attempts started |
| `questionTurnId`, `answerTurnId` | → `liveAssistTurns` |
| `promptVersion` | Server constant id |
| `providerKey`, `modelId` | The answered model, from the last attempt |
| `requestedAt` / `claimedAt` / `startedAt` / `completedAt` | Timeline |
| `deadlineAt`, `queueDeadlineAt` | Ruling 5 |
| `createdAt`, `updatedAt` | — |

- **Indexes:**
  - unique `turnRef`;
  - unique idempotency key;
  - `(state, deadlineAt)` for the sweep;
  - `(orgRef, sessionId)` for reads.
- **What it deliberately does not hold:** no tenant authority beyond `orgRef`, no money, and no tokens. A `canonical usage reference` is not a column: attempts are found by `turnRef`, the correlation id.

### 5.2 Shared AI tables (new, `server/_core/ai/`, not Live Assist)

| Table | Key columns | Notes |
|---|---|---|
| `aiInferenceAttempts` | `correlationId`, `attemptNo` (unique together), `feature`, `orgRef`, `providerKey`, `modelRequested`, `modelAnswered`, `promptVersion`, `state` (started/finished/abandoned), `resultCategory`, `latencyMs`, `inputTokens`, `outputTokens`, `timedOut`, `breakerState`, `providerRequestId`, `startedAt`, `finishedAt` | Telemetry. No money and no content |
| `aiSpendBudgets` | (`orgRef`, `day`, `feature`) unique, `ceilingMicros`, `reservedMicros`, `settledMicros` | The **only** spend authority. Reserve by conditional `UPDATE` before the call |
| `aiSpendEntries` | `attemptId` unique, `budgetId`, `reservedMicros`, `settledMicros`, `state` (reserved/settled/released) | Each reservation and settlement, so one attempt is charged once and reconciliation is possible |
| `aiModelPrices` (or a config constant) | `providerKey`, `modelId`, input/output price per token, `effectiveFrom` | No price means refusal (Ruling 2) |

The alternative to `aiSpendBudgets` with `feature` is one row per organization and day, with feature sub-limits; Ruling 2 decides.

### 5.3 Changes to LA-1a tables

- `liveAssistSessions.inputTokens` and `outputTokens`: retire them (drop, or leave unwritten). This is Ruling 2's choice.
- `liveAssistTurns`: no change. Its `user` and `assistant` rows gain a writer.
- `liveAssistObservations`: no change; written from validated output.

### 5.4 Job and outbox

- **Event:** `liveAssist.ask.requested`. The payload is `{ turnRef }` only: no question text, no organization authority and no bytes. `tenantId` is the ask's `orgRef`.
- **Dedupe:** `eventId` is a hash of `turnRef` (as `enforcementOutbox.ts:47-48` derives its own), inserted in the ask's transaction.
- **Claim:** the AI worker claims AI events only, one at a time (Ruling 1a). The handler then claims **the ask** by `UPDATE … SET state='running', runToken=:t, attemptCount=attemptCount+1 WHERE turnRef=? AND state IN ('queued','retry_wait') AND deadlineAt > NOW()`. Zero rows means already handled, so the handler returns normally.
- **Retries:** inside the handler, per Ruling 6. The outbox's own retry covers only infrastructure faults.
- **Leases:** the outbox lease is 120 s, longer than the provider timeout plus margin. The ask's `runToken` fences everything that matters.
- **Dead-letter:** after the outbox's five infrastructure failures the event is dead-lettered, and the sweep moves the ask to `failed` (or `timed_out` past its deadline). The user is never left polling.
- **Crash recovery:**
  - The outbox lease expires and the event is redelivered.
  - If the ask is still `running` with a stale token past its attempt lease, the handler re-claims it if the deadline allows, or the sweep times it out.
  - The abandoned attempt is closed and its reservation released or settled.

**Migration estimate (no numbers claimed):** **two to three** migrations.
- one for `liveAssistAsks`;
- one or two for the shared AI tables (attempts, spend, prices);
- plus, at the owner's choice, one to drop the two session token columns.

## 6. Threat model (LA-1b, text)

| # | Threat | Prevention | Detection | Test | Residual |
|---|---|---|---|---|---|
| T-1 | Prompt injection in the question | Fenced user block, a server-owned prompt, schema-constrained output, no tools, no data sources (Ruling 10), so an injection can change only the answer text | Output validation failures counted per attempt | The builder fences the input; any extra output fields are rejected | The model can still be talked into a misleading **answer**. The certainty and safety wording is server-side |
| T-2 | Tenant-data crossover | `orgRef` from `resolveActingScope`; every read and write keyed by ref + org + owner; context from this session only | `authorizationDecisions` refusals | Organization B cannot ask in, read or cancel organization A's ask; the builder cannot receive another session's turns | None known |
| T-3 | Role escalation | `live_assist.use` only; no new grant; the worker re-checks grants | Decisions recorded | A revoked grant means the worker refuses before the call | — |
| T-4 | Stale queued authorization | Worker re-authorization (Ruling 3), a short deadline | Refusal codes | Membership ended, policy off or switch off between enqueue and claim means refused, with no provider call | A revoked **login** within the token lifetime plus the deadline (Ruling 3) |
| T-5 | Replay of `ask` | `clientAskKey` uniqueness returns the same `turnRef` | — | The same key twice gives one ask and one event | — |
| T-6 | Duplicate jobs or deliveries | Event id derived from `turnRef`; ask claim by conditional `UPDATE`; `runToken` fencing | Attempt rows per `turnRef` | Concurrent workers give one attempt; a stale worker cannot overwrite | — |
| T-7 | Provider outage | Timeout, one retry, breaker | Breaker transitions, attempt categories | The breaker opens and the ask is `provider_unavailable` with no call | Asks made during the outage fail fast |
| T-8 | Provider compromise or malicious output | Schema validation, length caps, rendered as text only (no HTML or markdown execution), no tools | Validation failures | Oversized or invalid output is `failed`, and nothing is stored | A compromised provider sees questions. That is the terms and residency decision (Ruling 9 for images) |
| T-9 | Budget bypass | Reservation before the call, on the one authority; no call without a reservation; unknown price refused | Spend versus attempts reconciliation | A call path without a reservation fails a static test; an exhausted budget means no `fetch` | An estimate below the actual cost; settlement records the overrun |
| T-10 | Model-call amplification | One ask is one job and at most two attempts; outbox retries never re-call; per-session call cap; breaker | Attempts per ask | A permanent error is not retried; the outbox retry does not reach the provider | — |
| T-11 | Oversized input | Strict schema and character cap; request body limit | Refusal code `input_invalid` | 2,001 characters is refused and not queued | — |
| T-12 | Credential leakage | Credentials only in the provider module; no headers or bodies in errors or logs; no key in a URL | Log scan test | Errors and logs never contain the key or the `Authorization` value | — |
| T-13 | SSRF or provider URL manipulation | URL from deployment configuration only, never from the client; host allow-list; egress guard | Configuration refusal at start | A client-supplied provider or model is refused by the schema; a non-allow-listed host refuses | Misconfiguration by an operator |
| T-14 | Raw error leakage | The taxonomy carries codes only (Ruling 8); the handler stores codes | — | The upstream body never reaches the client, `lastError` or logs | — |
| T-15 | Retained sensitive prompts | Only the version id is persisted; question and answer purged per D-05; no content in telemetry or events | — | Telemetry and event rows contain no question text | Questions live up to 24 h after the session |
| T-16 | Cancellation race | Conditional transitions; `cancelRequested` | — | End versus claim and cancel versus completion: exactly one outcome | A sent request may still be billed |
| T-17 | Lifecycle race (session ends while running) | The completion write requires `running` plus the token, and checks `cancelRequested` | — | Session end during the call gives `cancelled` and no answer shown | Same as T-16 |
| T-18 | Cleanup race | The sweep uses the same conditional transitions and never touches non-expired rows | Sweep counts | Concurrent sweeps and a worker: no double transition | — |

## 7. Test plan (written before runtime code)

Each line is a test that must exist and pass in the checkpoint that introduces the behaviour.

| # | Test | Checkpoint |
|---|---|---|
| 1 | The request handler cannot import or call a model provider (the AST boundary stays at 1; Live Assist router and service import nothing from `_core/ai`) | b1 |
| 2 | `ask` queues and does not execute: no provider called, one ask, one event, one user turn | b1 |
| 3 | A malformed request (extra key, too long, empty) does not queue | b1 |
| 4 | An unauthorized user (no `live_assist.use`) does not queue, and a decision is recorded | b1 |
| 5 | The wrong organization cannot queue, read, list or cancel | b1 / b4 |
| 6 | Paused, ended and expired sessions refuse to queue | b1 |
| 7 | The kill switch off refuses to queue **and** refuses execution of an already-queued ask | b1 / b2 |
| 8 | Organization policy disabled refuses to queue and to execute | b1 / b2 |
| 9 | An exhausted budget means the provider is never called (`refused / budget_exhausted`) | b3 |
| 10 | The worker re-authorizes before the call: membership ended, grant revoked or session ended means no call | b2 |
| 11 | A missing provider credential fails closed (`provider_not_configured`, `fetch` not called) | b0 / b2 |
| 12 | Invalid provider configuration (blank URL, non-allow-listed host) fails closed | b0 / b2 |
| 13 | Provider timeout is bounded: a hung fake provider is aborted at the ceiling and the ask ends `timed_out` or retries once | b2 |
| 14 | Retry count is bounded: at most two attempts | b2 |
| 15 | Permanent errors are not retried, for each code | b2 |
| 16 | An open circuit breaker prevents the provider call | b5 |
| 17 | Idempotent enqueue: the same `clientAskKey` gives the same `turnRef` and one event | b1 |
| 18 | Concurrent workers give one logical attempt (four racing claims) | b2 |
| 19 | Worker crash and reclaim: a stale `running` is re-claimed within the deadline or timed out after it; a stale token cannot write | b2 |
| 20 | Cancellation, of queued and of running asks | b4 |
| 21 | The session-end versus queued-ask race | b4 |
| 22 | Cleanup: time-out, abandoned-attempt closure and purge, all bounded per tick | b4 |
| 23 | Telemetry is emitted exactly once per attempt | b3 |
| 24 | The canonical budget entry is emitted exactly once per attempt; settle is idempotent | b3 |
| 25 | Raw secrets are absent from logs, errors, `lastError` and attempt rows | b0 / b2 |
| 26 | A cross-tenant result read is refused (`NOT_FOUND`) | b4 |
| 27 | The request-boundary guards (`aiRequestBoundary`, `workerBoundary`, `liveAssistBoundary`) remain green with their pins unchanged | every |
| 28 | The census and permission pins move by exactly the new procedures | b1 / b4 |
| 29 | The context builder cannot accept a database row or another session's turns (a type-level and runtime test) | b2 |
| 30 | Answer output failing the schema is `failed` and nothing is stored | b2 |

## 8. Diagrams

**8.1 Request and enqueue**
```
Client
  │ liveAssist.ask {sessionRef, clientAskKey, question}
  ▼
roleProcedure("liveAssist.ask")  ── live_assist.use, decision recorded
  ▼
resolveActingScope → orgRef      (never from input)
  ▼
own session by ref+org+owner → deadlines → kill switch → org policy → per-session call cap
  ▼
ONE transaction:  liveAssistAsks(queued) + liveAssistTurns(user) + domainEventOutbox(liveAssist.ask.requested)
  ▼
{ turnRef, state: queued, deadlineAt }   ← immediate
```

**8.2 Worker and provider**
```
AI worker (dedicated)  claim event (AI type, one at a time)
  ▼
claim ask: queued|retry_wait → running, runToken   (0 rows ⇒ done)
  ▼
re-authorize: user · membership(org) · grant · session open · org policy · kill switch
  ▼            └─ any fails ⇒ refused/<code>, no call
breaker closed?  └─ open ⇒ provider_unavailable, no call
  ▼
reserve spend (conditional UPDATE)  └─ 0 rows ⇒ refused/budget_exhausted, no call
  ▼
attempt row (started) → context builder (question + session turns + server prompt)
  ▼
LlmProvider.complete(signal = min(provider timeout, deadline))
  ▼
validate output → attempt finished (usage) → settle spend
  ▼
UPDATE ask SET completed … WHERE runToken = ? AND state = running   (+ turns, observations)
```

**8.3 Budget enforcement**
```
estimate = price(model) × (inputTokensEst + maxOutputTokens)     no price ⇒ refuse
UPDATE aiSpendBudgets SET reserved = reserved + est
 WHERE org = ? AND day = ? AND reserved + settled + est <= ceiling     ← the only spend gate
   │ 1 row ⇒ call allowed      │ 0 rows ⇒ refused/budget_exhausted
   ▼
after call: settled += actual, reserved -= est   (once, keyed by attemptId)
abandoned attempt: sweep releases or settles the reservation
```

**8.4 Cancellation**
```
session end / pause / expiry / user cancel
  ├─ ask queued|retry_wait ──▶ cancelled                     (same transaction)
  └─ ask running ──▶ cancelRequested = 1
                         ▼
               worker checks before call ⇒ abort, cancelled
               worker checks before write ⇒ discard answer, cancelled (spend settled)
```

**8.5 Provider failure and circuit breaker**
```
attempt fails
  ├─ permanent (4xx, invalid output) ──▶ refused / failed           no retry, breaker unaffected
  └─ transient (timeout, 429, 5xx, network)
        ├─ breaker.recordFailure → may open
        ├─ retries left && deadline left ──▶ retry_wait ──▶ running
        └─ else ──▶ provider_unavailable
breaker open ──(cooldown)──▶ half_open ── one probe ──┬─ ok   ──▶ closed
                                                      └─ fail ──▶ open (cooldown × 2, capped)
```

## 9. Files likely to change, by checkpoint

| Checkpoint | Files |
|---|---|
| **b0** | `server/_core/llm.ts`, `server/routers.ts` (`assistant.draft` error mapping only), new `server/_core/llm.test.ts`, `server/_core/ai/llm/openAiCompatibleProvider.ts` (error text), `server/_core/ai/llmProvider.test.ts`, `docs/REMAINING_BUILD_REGISTER.md` (P9.1 row) |
| **b1** | `drizzle/schema.ts`, one migration, `server/liveAssistService.ts`, `server/liveAssistRouter.ts`, `server/_core/liveAssist/session.ts` (ask states), `server/_core/recordsAuthorization.ts` (procedure map), census pins in `procedureAuthorization.test.ts`, `operationalApiAuthorization.test.ts` and `crossLayerIntegrity.test.ts`, `server/liveAssistBoundary.test.ts`, new database tests, `LEASEOS_CURRENT_STATE.md` |
| **b2** | `server/_core/ai/llm/provider.ts` and `openAiCompatibleProvider.ts` (signal, taxonomy, capabilities), a new Live Assist ask handler under `server/_core/liveAssist/`, `server/_core/productionWorker.ts` and `server/_core/worker.ts` (dedicated AI worker), `server/_core/workflowRuntime.ts` (event-type filter, if ruled), `server/_core/ai/workerBoundary.test.ts` (allow the one new handler) |
| **b3** | Shared AI tables (migration), new `server/_core/ai/usage/` (attempts) and `server/_core/ai/budget/` (spend), the handler, `liveAssistSessions` token-column decision |
| **b4** | `server/liveAssistRouter.ts` (`getTurn`, `listTurns`, `cancelTurn`), `server/liveAssistService.ts` (cancellation in end/pause/expiry, sweep phases) |
| **b5** | New `server/_core/ai/circuitBreaker.ts` and its tests; the handler |
| **b6** | `client/src/…` Live Assist text UI (ask, poll, cancel, states) |

## 10. Recommended checkpoints

Each is its own PR, implemented only after the owner rules. None is started.

| Checkpoint | Scope | Depends on |
|---|---|---|
| **LA-1b0** | P9.1 fail-closed repair (§4). Independent of Live Assist; its own branch | Owner accepts §4 and the deployment change |
| **LA-1b1** | `liveAssistAsks` schema, `liveAssist.ask` enqueue only, idempotency, refusals. **No handler registered; nothing executes** | Rulings 1, 4, 11, 14 |
| **LA-1b2** | Dedicated AI worker and handler: claim, re-authorization, context builder, `LlmProvider` call (text), validation, fencing, retries. **Does not ship to an organization until b3**: no provider call without a reservation | b0, b1, Rulings 1a, 3, 5, 6, 8, 10, a provider with terms on file |
| **LA-1b3** | Shared spend authority and attempt telemetry; Live Assist token columns retired | Ruling 2, 13 |
| **LA-1b4** | `getTurn`, `listTurns`, `cancelTurn`; cancellation in end/pause/expiry; sweep phases | Rulings 14, 15, 16 |
| **LA-1b5** | Circuit breaker | Ruling 7 |
| **LA-1b6** | Client text UI | b1–b5 |
| **LA-1v** (later) | Image input. A separate owner ruling; family-bound sessions (Ruling 3) | Ruling 9, D-12, D-03 |

b2 and b3 may be developed in either order but **ship together**: the provider-call path must not reach an organization
before the reservation gate exists.

## 11. Risks and conflicts

1. **Changing shared infrastructure.** Ruling 1a's dedicated worker and the `workflowRuntime.ts` filter touch the path enforcement and webhooks use. They need their own tests and review.
2. **The §22 wording.** It says budgets are designed "on the same row" as `agentRuns.maxSteps`. Ruling 2(C) reads that as *counts on the unit of work's row, money on one shared authority*. The owner must confirm that reading or choose D.
3. **D-10 is superseded** (telemetry is built shared, not inside Live Assist). The design document should record that when the owner rules.
4. **P9.5/P9.6 scope creep.** Building the spend authority and telemetry for Live Assist also builds them for every future AI feature. That is intended, but it widens b3 beyond Live Assist.
5. **Revocation residual** (Ruling 3) for text-only LA-1b is a deliberate, stated acceptance, not a gap to discover later.
6. **No provider has written terms on file.** b2 cannot ship until decisions 3 and 4 of `LA1B_READINESS.md` are made.
7. **The SPINE moratorium and Wave 0 freeze** still stand (`docs/register/SPINE_WIRING_PLAN.md`). Each LA-1b checkpoint needs the owner's carve-out in the way LA-1a had one. This proposal is not that carve-out.
8. **The outbox header comments misdescribe its transactions** (`drainWorker.ts:4-7`, `workflowRuntime.ts:8-10`). Correcting them belongs to whichever checkpoint touches that file.
