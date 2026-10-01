# Live Assist LA-1b — prerequisites and readiness

**Status: readiness assessment only. Nothing here is approved, and LA-1b is not built.** Every
"recommended ruling" below is a recommendation for the owner. None becomes architecture until the owner
rules on it explicitly, in the way `docs/live-assist/LA1A_OWNER_RULING.md` recorded LA-1a.

The architecture and the sixteen proposed rulings built on these prerequisites are in
`docs/live-assist/LA1B_RULING_PROPOSAL.md`. That document is also a proposal, and nothing in it is approved.

| | |
|---|---|
| Written against | `main` = `2a76920` (LA-1a merged by PR #81 at `3dfcb3e`) |
| LA-1b, as planned | ask about a photo: one still image and a question go to a vision model; the answer comes back with certainty wording and safety notices (`docs/live-assist/LIVE_ASSIST_LA1_IMPLEMENTATION_PLAN.md` §3) |
| What LA-1a already provides | the session, its tenancy, lifecycle, deadlines, policy and kill switch, the transient tables and their purge, and the metadata-only lifecycle record |

---

## 1. Two constraints that change the LA-1b plan

These were recorded on `main` after the LA-1 plan was written. They bind LA-1b whatever the owner decides below.

1. **No model call inside a request handler.** The owner's decisions in
   `docs/register/AI_AGENT_RUNTIME_ARCHITECTURE.md` §22 put inference in the worker, behind the outbox.
   `server/aiRequestBoundary.test.ts` pins the one known violation (`assistant.draft`) and fails the
   build at a second. The plan's synchronous `liveAssist.ask` would be that second violation. **LA-1b
   must therefore submit the question as a durable job and return immediately; the worker calls the
   model; the client polls or is told the answer is ready.** A photo question becomes an asynchronous
   request with a visible "working" state.
2. **No second budget representation.** The same decisions say inference, token, cost and deadline
   budgets are designed "on the same row" as `agentRuns.maxSteps` (P9.5), consumed atomically before
   the step. LA-1a put `framesSubmitted`, `inferenceCalls`, `inputTokens` and `outputTokens` on
   `liveAssistSessions`. Before LA-1b writes them, the owner must decide whether those counters are the
   Live Assist instance of the one budget mechanism, or are retired in favour of an `agentRuns` row
   per Live Assist session (§2, decision 5).

## 2. Decisions required before LA-1b

| # | Decision | State on `main` now | Recommended ruling |
|---|---|---|---|
| 1 | **P9.1 / AI-001 / SEC-12 fail-closed hardening** | Open. `server/_core/llm.ts:220-223` still falls back to `https://forge.manus.im` when `BUILT_IN_FORGE_API_URL` is unset, and the request-path door has no timeout. | Close it before LA-1b: no default host, refuse when unconfigured, a timeout, provider and model recorded. LA-1b must not use `invokeLLM` at all (decision 2). |
| 2 | **Which provider abstraction carries images** | `server/_core/ai/llm/provider.ts` (`LlmProvider`, merged with PR #7) refuses to run unconfigured and has a 60 s timeout, but its messages are text only ("no tools, no images"). | Extend `LlmProvider` with an image content part and a per-request byte limit. Do **not** add a second provider abstraction, and do not add images to `invokeLLM`. |
| 3 | **Vision provider requirements** | No vision provider is configured. `modelGateway` has no `vision` task. | Choose a provider only after decisions 4 and 7. Requirements: image input by value (inline bytes, no publicly fetchable URL), structured JSON output, a published data-residency answer, a licence that passes `modelGateway`'s licence gate, and an API that honours a request timeout. |
| 4 | **Written no-training / no-retention terms** | No terms on file for any AI vendor. | Required before any image leaves LeaseOS: written zero-retention (or a stated maximum) and no training on inputs or outputs, recorded against the provider credential (`providerCredentials`, S2-C) so the terms are discoverable from the credential that uses them. |
| 5 | **AI usage accounting and telemetry** | P9.6 / AI-006 open: no record of provider, model, latency, tokens, failure class or cost for any call. | Build the single telemetry seam P9.6 describes before LA-1b, written by the worker for every inference. Live Assist writes through it; it does not keep its own copy. Decide at the same time whether the session's LA-1a counters are kept as the Live Assist view of that seam or removed. |
| 6 | **Spend ceiling at the model-call boundary** | LA-1a requires a daily spend ceiling for Live Assist to be enabled, but nothing enforces it because nothing spends. | The worker checks and consumes budget atomically **before** the call (conditional `UPDATE … WHERE spent + estimate <= ceiling`), per the §22 budget invariant. Unknown cost (no price on file for the model) is refused, not assumed zero. |
| 7 | **What may leave LeaseOS** | Undefined for images. The security design proposes data classes where RESTRICTED is excluded from AI and HIGHLY_RESTRICTED is never sent; not built (SEC-6). | For LA-1b: only the image the person chose to send (the crop, by default), their question, and server-authored instructions. No LeaseOS records, no names or identifiers from the database, no location, no device identifiers. Admitted LeaseOS context waits for SEC-6. |
| 8 | **Document images** (D-12) | Unresolved. The scanner work reads documents **on the device only**; the design proposed cloud reading of the five typed forms. | Keep LA-1b to non-document photos (equipment, conditions, labels). Document reading stays with LA-1c and needs its own ruling with security and privacy review. LA-1b should not weaken the scanner policy by accident: if the model reports that an image is a document, the answer says so and stops. |
| 9 | **What may be persisted** | LA-1a tables exist; nothing writes the transient ones. | Persist only: the question and answer text (redacted, capped, in `liveAssistTurns`), observations with server certainty and safety class, and frame hashes and dimensions. Never image bytes, never the raw model response, never model reasoning (P9.9). |
| 10 | **What must stay transient** | LA-1a purges turns, observations and unsaved frames after the session's retention. | Image bytes live only in the worker's memory for the duration of one call; the job payload carries a short-lived reference, not the bytes, if the job store would otherwise hold them. Retention of turns and observations stays at the session's `purgeAfter` (24 h default, D-05). |
| 11 | **Timeouts, retries, circuit breaker** | `LlmProvider`: 60 s timeout, no retries (the outbox owns them). | Per call: a timeout shorter than the session's idle window. Retries: at most one, only for transport failures, never for a schema-invalid answer. A provider failing repeatedly opens a per-provider breaker that turns Live Assist questions into an immediate "not available right now" until it half-opens. |
| 12 | **Outage behaviour** | Not defined. | A question during an outage is refused with a clear state, not queued for later answering without the person's knowledge. The session stays open; the person may retry. No fallback to another provider unless that provider is separately approved under decision 4. |
| 13 | **Login/session binding** | LA-1a binds to the authenticated user and the acting organization per call; it stores no login reference. Access credentials live up to 15 minutes after revocation. | Before images flow, bind each Live Assist session to the login family that opened it (a nullable `authSessionRef`), and refuse a job whose login family has since been revoked, checked again in the worker before the call. |
| 14 | **The owner ruling itself** | LA-1a's ruling explicitly excludes vision calls, cloud image processing, and LA-1b. | A new, explicit ruling naming LA-1b's scope, the provider (decision 3), the terms on file (decision 4), and the answers to decisions 1–13. Without it, LA-1b does not start. |

## 3. Order, if the owner approves

1. P9.1 closed (decision 1).
2. The P9.6 telemetry seam, and the budget decision (decisions 5 and 6).
3. `LlmProvider` image support, with tests that no image reaches a log or the job store (decisions 2, 9, 10).
4. Provider chosen with terms on file (decisions 3 and 4).
5. Login-family binding (decision 13).
6. The owner's LA-1b ruling (decision 14), then LA-1b as an asynchronous worker job.

## 4. What this document does not do

It does not choose a vendor, approve any recommendation, change LA-1a, resolve the document policy, or
start LA-1b.
