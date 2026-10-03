# LeaseOS AI — the agentic runtime, mapped onto what exists

**Documentation only. No production code changes.** This is the agent-runtime layer of
`docs/register/AI_RUNTIME_TERMINOLOGY.md` (the terminology survey). That document maps the
vocabulary; this one maps the *runtime design* — loop, plan, evaluator, budgets, HITL, retrieval,
context, memory, workers, idempotency, durability, observability, cancellation, failures — onto
this repository, so the eventual runtime is built from parts that exist rather than beside them.

**Surveyed against:** `6f52b57` (`claude/compassionate-mendel-8sa4vg`: `main` + SPINE item 1's
resolver and chain rule), then re-checked after merging `main` at `88608f3` into this branch: the
agent runtime, `llm.ts`, the worker and `0100_agent_runs.sql` are unchanged on `main`; the one
request-handler model call moved from `routers.ts:690` to `routers.ts:794` with no second call
added. **PR #7 (the Secretary model layer, `server/_core/ai/`) is still open
and is not in this tree.** Everything this document attributes to `server/_core/ai/` is described
from PR #7's head (`929f721`), exactly as the terminology survey did, and is marked
`DECLARED_UNWIRED (PR #7)`. That includes `server/_core/ai/workerBoundary.test.ts`, the test that
pins the one synchronous model call; on this branch that pin does not exist yet (§20, finding F1).

**The SPINE is first.** Nothing here is authorization to build. §18 restates the order and §21
answers whether anything found here changes it (it does not).

---

## 0. Status vocabulary

| Status | Meaning |
|---|---|
| `IMPLEMENTED` | Exists and is reached from a mounted `roleProcedure` or the production worker. |
| `PARTIAL` | Some of it is reached; a named piece is missing. |
| `DECLARED_UNWIRED` | Code and tests exist, no production caller. `(PR #7)` means the code is in the open PR, not this tree. |
| `MISSING` | Needed by the design; nothing exists. |
| `DEFERRED` | Not built on purpose until a named condition holds. |
| `NOT_NEEDED` | The design asks for it, the repository already answers it another way, or LeaseOS declines it on principle. |

Mapping to the terminology survey's words: `implemented` → `IMPLEMENTED`; `partial` → `PARTIAL`;
`declared / unwired` → `DECLARED_UNWIRED`; `deferred` → `DEFERRED`; `intentionally unsupported` →
`NOT_NEEDED`. `MISSING` is new: the survey recorded missing seams in prose (§19 there).

---

## 1. The conceptual model, in repository names

| Concept | Meaning | Canonical LeaseOS home |
|---|---|---|
| **LLM** | reasoning/language component | `invokeLLM()` (`server/_core/llm.ts`, door 1, live); `LlmProvider` (door 2, PR #7) |
| **Agent** | the controlled runtime around the LLM | the **agent runtime**: `server/agentRouter.ts` + `server/_core/actionGateway.ts` |
| **Orchestrator** | coordinates tasks, workers, tools, state | not a new module. Deterministic coordination already lives in the **workflow runtime** (`workflowEngine.ts` + `workflowRuntime.ts`, §11) and the agent runtime's `TRANSITIONS` |
| **Tool** | server-authorized operation | model-facing `ToolDefinition` (PR #7) bound to a `ProcedureName`; gateway-facing `CapabilityDefinition` |
| **Memory** | controlled persisted/retrieved information | not one thing — six classes, §9 |
| **Agent loop** | bounded decide → act → observe → evaluate | does not execute anywhere today; §2 |
| **LeaseOS** | the authority | `roleProcedure` → `authorizationDecisions`; domain tables; receipts |

Three invariants, each already enforced somewhere in code:

1. **The model is never the authority.** No model output reaches a table except through
   parse → schema → domain validation → proposal → human/policy → `executeAssistantCommit()`
   (terminology survey §9).
2. **The agent is never the authorization boundary.** `agent.requestAction` records a gateway
   decision and *executes nothing*; any real write goes through the target's own `roleProcedure`.
3. **Authority only narrows.** Automation policy clamps (`SafetyCeiling`), overrides move only
   toward MANUAL (`evaluateOperationalOverride()`), and `NEVER_AUTONOMOUS` / `NEVER_AUTOMATIC`
   cannot be configured away (`validatePolicy()`).

---

## 2. The canonical agent loop — each hop against the tree

```
USER GOAL
  │
  ▼
Authenticated request ............ IMPLEMENTED   roleProcedure()  server/_core/trpc.ts
  ▼
Acting scope + authorization ..... IMPLEMENTED   resolveActingScope(); permissionForProcedure()
  ▼
Durable agent job ................ PARTIAL       agentRuns / agentSteps / agentActions / agentApprovals
  │                                              (records decisions; no executor claims a run)
  ▼
Authorized context assembly ...... PARTIAL       admitSource() live for knowledge passages;
  │                                              ContextPack (PR #7) unwired; assembleContext() no caller
  ▼
Model inference .................. PARTIAL       door 1 live but synchronous in a request handler
  │                                              (routers.ts, assistant.draft); door 2 unwired (PR #7)
  ▼
Structured decision .............. PARTIAL       door 1 proposal path live; no decision envelope
  │                                              with COMPLETE / CLARIFY / REFUSE / TOOL_REQUEST exists
  ├─► COMPLETE ................... IMPLEMENTED   proposal committed; agentRuns "completed" (unreached)
  ├─► NEEDS_CLARIFICATION ........ IMPLEMENTED   assistantQuestions; Gap; agentRuns "waiting_for_input"
  ├─► REFUSED .................... IMPLEMENTED   Decision "deny" / "compliance_block"; authorizationDecisions
  └─► TOOL_REQUEST
        ▼
      Server tool registry ....... DECLARED_UNWIRED (PR #7)  SECRETARY_TOOLS, resolveTool()
        ▼
      Authorization check ........ IMPLEMENTED   decide() at the gateway; roleProcedure at the target
        ▼
      Tool execution ............. DECLARED_UNWIRED (PR #7)  invokeTool({ createCaller }) — no composition root
        ▼
      Observation ................ MISSING       ToolResult returned and lost; agentActions.outcome stuck at "requested"
        ▼
      Evaluation ................. PARTIAL       validateExtraction() (PR #7); verifyClaim() live; checkCommit() live
        ├─► finish / clarify / human approval / next inference
        └── server-enforced limits: MISSING at run level (agentRuns.maxSteps never read, §5)
```

**No path today closes the loop.** Inference produces a proposal and stops; the agent runtime
records decisions and stops; retrieval quotes passages and stops. That is correct under the
moratorium. The loop's eventual shape is a production-worker handler (the same shape as the
existing `enforcement` handler in `productionWorker.ts`), not a new engine.

---

## 3. ReAct — the auditable variant

LeaseOS ReAct is **Decision → Action → Observation → Evaluation**. Hidden chain-of-thought is
neither requested nor stored. Each persisted element, and where it would live:

| Persist | Existing home | Status |
|---|---|---|
| objective | `agentRuns.goal`; `SecretaryExtractionEvent.transcript` (PR #7) | IMPLEMENTED |
| tool requested | `agentActions.capability` (capability key); `ToolInvocation.toolKey` (PR #7, unpersisted) | PARTIAL |
| validated arguments | zod `.input()` on the target procedure; `agentActions.payloadHash` (hash, not payload) | IMPLEMENTED |
| authorization result | `agentActions.decision` + `decisionReasons`; `authorizationDecisions` | IMPLEMENTED |
| execution result | `agentActions.outcome` exists, never advanced | MISSING (P9.3) |
| evidence references | `evidenceRefs` accepted by `agent.requestAction` and **dropped**; `ContextItem.id` / `evidenceRef` (PR #7); `assistantQueries` cited refs (live) | PARTIAL |
| satisfied the objective? | `isComplete(outcome)` in `actionGateway.ts` (outcome never reaches `verified`) | DECLARED_UNWIRED |
| another action needed? | `detectNoProgress()` (no caller); `advance()` (PR #7) | DECLARED_UNWIRED |
| reason code for clarify/refuse | `assistantQuestions.reason`; `decisionReasons`; `FieldVerdict.reasonCodes` (PR #7) | IMPLEMENTED (two of three) |
| final outcome | `agentRuns.status`; `assistantProposals.commitState`; receipts | PARTIAL (run status never reaches a terminal state) |

**Do not persist:** chain-of-thought, private reasoning tokens, scratchpads, deliberation
transcripts. §20 F4 reports the three places near this line; none crosses it.

The audit surface is a **reason code**, not prose:

```text
decision:       NEEDS_CLARIFICATION     → agentRuns.status = waiting_for_input
reasonCode:     DISPOSAL_QUANTITY_MISSING → assistantQuestions.reason = missing_required (+ finer code, PR #7)
evidence:       ticket_84721            → evidenceRefs (to be persisted, P9.10)
requestedField: quantity                → assistantQuestions field key
```

---

## 4. Plan-and-Execute

The plan is **structured state**, and the state already exists:

| Design | Existing | Status |
|---|---|---|
| `AgentJob` | `agentRuns` | IMPLEMENTED (as a record) |
| objective | `agentRuns.goal` | IMPLEMENTED |
| constraints | `automationPolicies` snapshot; `NEVER_AUTONOMOUS`; `TaskAllowlist` (PR #7) | PARTIAL |
| allowedTools | `TaskAllowlist.toolKeys` (PR #7); `buildRegistry()` capabilities | PARTIAL |
| automationCeiling | `SafetyCeiling` / `ceilingFor()`; `SecretaryProposal.ceiling = "HYBRID"` (PR #7) | IMPLEMENTED (mechanism; list empty by owner decision) |
| stepBudget | `agentRuns.maxSteps` (never read); `TaskAllowlist.stepBudget` (PR #7) | PARTIAL |
| Plan / Steps | `agentSteps` (`stepNumber`, `capability`, unique per run) | IMPLEMENTED (stored, never advanced) |
| step validity | plan may name only registered capabilities (`REGISTRY.has`); ≤ 40 steps (zod) | IMPLEMENTED |

**Step states — use the existing vocabularies, do not add one.**

| Requested | `agentSteps.status` | `agentRuns.status` (run level) |
|---|---|---|
| PENDING | `planned` | `created`, `planning` |
| READY | `planned` (no distinct value) | `ready` |
| RUNNING | `running` | `executing` |
| WAITING_FOR_APPROVAL | `blocked` + reason | `waiting_for_approval` |
| WAITING_FOR_CLARIFICATION | `blocked` + reason | `waiting_for_input` |
| COMPLETED | `completed` | `completed` |
| REFUSED | `blocked` / `skipped` + reason | `blocked` |
| FAILED | `failed` | `failed` |
| SKIPPED | `skipped` | — |

The run enum already carries every waiting state; the step enum is coarser on purpose, because a
step waits *because the run waits*. If a step-level waiting distinction is ever needed, add values
to `agentSteps.status` — not a parallel table.

**Existing plan/workflow engines found:** two, neither a duplicate of the other.

- **Agent runtime** (`agentRouter.ts`) — a *caller-supplied* capability plan, per run. No model
  generates plans; no code advances steps.
- **Workflow runtime** (`workflowEngine.ts` rules → `operationalTasks`, `workflowInstances`,
  `workflowTransitions`, `ESCALATIONS`) — deterministic *rule-generated* human tasks, **live**
  through the worker's generic `workflow_rules` fallback (§11). It is the repository's real
  orchestrator for human work, and its task statuses (`open`, `acknowledged`, `in_progress`,
  `waiting`, `completed`, `cancelled`) are the natural home for "a person must do something about
  what the agent found".

---

## 5. Evaluation (not "reflection")

Evaluation is an explicit, mostly deterministic verification stage. The disposal-ticket chain:

| Stage | Existing | Status |
|---|---|---|
| schema validation | `buildOutputSchema()` + `parseExtraction()` (door 1); `strict` json_schema + `parseExtractionEnvelope()` (PR #7) | IMPLEMENTED / DECLARED_UNWIRED |
| required fields | `detectGaps()` → `missing_required` | IMPLEMENTED |
| domain validation | normalizers + `validateExtraction()` (PR #7); `precisionSensitive` → question | PARTIAL |
| cross-check against evidence | `quoteIsInTranscript()` (PR #7); `verifyClaim()` (retrieval, live) | PARTIAL |
| policy evaluation | `resolveAutomation()`; `decide()`; `checkCommit()` refusals | IMPLEMENTED |
| arithmetic, job/customer, unit/equipment consistency | cross-checks in `validator.ts` (PR #7); `capacity_unknown` → `NOT_EVALUATED` | DECLARED_UNWIRED |
| ticket number format | `ticket_prefix_missing`, `ticket_not_open` (PR #7) | DECLARED_UNWIRED |
| duplicate detection | `documentFingerprint.ts` (disposal/document fingerprints, v20.16) | IMPLEMENTED |
| safety implications | `detectOverreach()`; `NEVER_AUTONOMOUS` | IMPLEMENTED |
| authorization | `roleProcedure` on commit (second authorization in `executeAssistantCommit()`) | IMPLEMENTED |

**Evaluator outcomes → existing `Verdict`** (`BLOCKED | UNKNOWN | NOT_EVALUATED | REVIEW | PASS`,
PR #7) and gateway `Decision`:

| Requested | Existing |
|---|---|
| PASS | `PASS` |
| CORRECTION_REQUIRED | `REVIEW`; `proposalFields.status = corrected` after a person acts |
| NEEDS_CLARIFICATION | `UNKNOWN` + `needsClarification[]`; `assistantQuestions` |
| INSUFFICIENT_EVIDENCE | `NOT_EVALUATED` (never conjoins to `PASS`); retrieval `insufficient_evidence` |
| POLICY_BLOCKED | `BLOCKED`; `Decision = compliance_block` |
| FAILED | `ExtractionUnparseable` (PR #7); outbox dead-letter |

An evaluator may trigger another inference; the iteration cap is `MAX_CLARIFY_ROUNDS = 3`
(PR #7) for clarification and must be the run budget (§6) for everything else.

---

## 6. Agent budgets

| `AgentBudget` field | Existing | Status |
|---|---|---|
| `maxSteps` | `agentRuns.maxSteps` (40) / `stepsUsed` — **no code reads or writes either** | PARTIAL (P9.5) |
| | `TaskAllowlist.stepBudget` + `spendStep()` → `StepBudgetExhausted` (PR #7) | DECLARED_UNWIRED |
| `maxInferenceCalls` | none | MISSING |
| `maxToolCalls` | `stepBudget` counts tool calls (PR #7) | DECLARED_UNWIRED |
| `maxRetries` | outbox `maxAttempts = 5` → dead-letter (live); `shouldRetry()` (no caller); `llm.ts` 4 retries | IMPLEMENTED (job level) |
| `deadline` | none on `agentRuns`; outbox claim lease `CLAIM_LEASE_SECONDS = 120` is a lease, not a deadline; `operationalTasks.dueAt` + `ESCALATIONS` is a human-task deadline | MISSING (run level) |
| wall-clock | provider timeout 60 s (PR #7); door 1 none | PARTIAL |
| token budget | `usage` captured on responses, never summed or stored | MISSING |
| cost budget | none | MISSING / DEFERRED |
| clarification rounds | `MAX_CLARIFY_ROUNDS = 3` (PR #7) | DECLARED_UNWIRED |
| no-progress stop | `detectNoProgress()` (no caller) | DECLARED_UNWIRED |

**Widening rules hold today by construction:** every budget is a constant or a column default;
no procedure input sets `maxSteps`, `stepBudget` or any cap; a caller-supplied plan may be
shorter than the cap, never longer. The missing piece is *enforcement*, not policy.

**Exhaustion outcome.** No `BUDGET_EXHAUSTED` value exists. The existing mapping is
`agentRuns.status = blocked` with `blockedReason = "budget_exhausted: <which>"` — deterministic,
already in the enum, and `blocked → failed` is a legal transition. Recommend that mapping over a
new status when P9.5 is built.

---

## 7. Human-in-the-loop

```
Agent proposes action
      │
      ▼
Automation policy ── resolveAutomation()  (tenant → role → task → customer; clamped by SafetyCeiling)
      │
      ├── AUTO_ALLOWED       → Decision "allow" — requires RiskLevel ≤ low_risk_action AND the company's
      │                        autoExecute list (currently [] in agentRouter.ts) → nothing is auto today
      ├── APPROVAL_REQUIRED  → Decision "require_approval" → agentApprovals (payloadHash-bound) →
      │                        agent.decideApproval; for proposals: readBack → acknowledge → commit (HYBRID)
      └── FORBIDDEN          → Decision "deny" / "compliance_block"; NEVER_AUTONOMOUS; NEVER_AUTOMATIC
```

| Property | Enforcement | Status |
|---|---|---|
| AI never promotes itself to automatic | `ActionRequest.origin` forced to `authorized_user`, `actor.type` to `agent`; `external_content` / `workflow_data` may never instruct (`MAY_INSTRUCT`) | IMPLEMENTED |
| policy may narrow, never widen | `SafetyCeiling` clamp (`clamped: true` recorded); overrides only toward MANUAL; entitled-but-unconfigured is MANUAL | IMPLEMENTED |
| approval bound to exact payload | `approvalCovers()` compares `payloadHash` | IMPLEMENTED |
| requester cannot approve restricted | `decideApproval` refuses self-approval of `NEVER_AUTONOMOUS` | IMPLEMENTED |
| approval resumes the run | `decideApproval` records the decision but does not move the run; the next `requestAction` re-decides with the approval | PARTIAL (acceptable until an executor exists) |
| safety-ceiling list | `SAFETY_CEILINGS = {}` — an owner decision (P8.4) | DEFERRED (owner) |

**Verdict: HITL is the most complete part of the agent design.** It needs no new mechanism.

---

## 8. Agentic RAG and context engineering

**Retrieval as an authorized, auditable tool.**

| Requirement | Existing | Status |
|---|---|---|
| retrieval request is tool-like | knowledge: `assistant.ask` (a `roleProcedure`); records: ordinary scoped read procedures (`tripStops.list`, `loads.list`, `units.list`, …) reached via `SECRETARY_TOOLS` read category (PR #7) | IMPLEMENTED (knowledge) / DECLARED_UNWIRED (records) |
| server authorization + tenant scope | tenant in the SQL, then `admitSource()` per passage with real permissions; `orgScopeWhere` on records | IMPLEMENTED |
| no "give me the database" | no tool category exposes a query; tools are keys bound to procedures | IMPLEMENTED by construction |
| audit: type, query, scope, refs, time | `assistantQueries` (question, verdict, counts, cited refs); `authorizationDecisions` per read procedure | IMPLEMENTED (knowledge); PARTIAL (record reads audited only as authorization) |
| context fingerprint | `inputHash` over rendered context (PR #7); `retrievalMeasurements.corpusHash` | DECLARED_UNWIRED |
| store references, not payloads | `assistantQueries` stores refs; `agentActions` stores `payloadHash` | IMPLEMENTED |
| embeddings / vector store | none; gated on a recorded vocabulary-gap measurement | DEFERRED |

**Context engineering — the layers.**

| Layer | Existing | Status |
|---|---|---|
| system contract | `secretary-extract.v1.md` + `promptHash()` (PR #7); inline `buildSystemPrompt()` (door 1) | PARTIAL |
| agent/task instructions | `TaskAllowlist`, form key (PR #7) | DECLARED_UNWIRED |
| authenticated user + acting scope | `TrpcContext`; `resolveActingScope()` — never rendered into model text as a tenant id | IMPLEMENTED |
| job context | `ContextPack` from records (PR #7; pure, no imports) | DECLARED_UNWIRED |
| retrieved evidence | `AdmittedContextBlock` (branded; only resolvers mint it) | IMPLEMENTED |
| conversation state | `DialogueState` (PR #7, unpersisted); `assistantQuestions`; read-back | PARTIAL |
| tool results | nowhere persisted | MISSING |
| remaining budget | not rendered into context | MISSING |
| single-tenant rule, instruction authority | `assembleContext()` refuses mixed tenants; `external_content` may not instruct | PARTIAL (no production caller) |
| staleness / pruning / window fit | none; the only context today is one-shot (one transcript, one form) | MISSING — not needed until multi-step loops exist |

The context window is working memory. It is never LeaseOS durable memory (terminology survey §6).

---

## 9. Memory — six classes, no generic store

| Class | Existing | Status |
|---|---|---|
| Authoritative operational memory | domain tables via `roleProcedure` and typed commit adapters | IMPLEMENTED |
| Conversation state | `assistantQuestions`, `assistantProposals.readBack*`; `DialogueState` unpersisted (PR #7) | PARTIAL |
| Agent job state | `agentRuns`, `agentSteps`, `agentActions`, `agentApprovals` | IMPLEMENTED (state), MISSING (results) |
| Retrieval / index state | `knowledgePassages`, corpus tables, `retrievalMeasurements`; no embeddings | IMPLEMENTED / DEFERRED |
| Audit history | `authorizationDecisions`, `assistantCommitReceipts`, `agentActions`, `assistantQueries`, `domainEventOutbox`, `workflowTransitions` | IMPLEMENTED |
| User/company preferences | `automationPolicies`, `capabilityEntitlements`, widget layouts | IMPLEMENTED |
| Generic `agentMemory` | — | NOT_NEEDED (intentionally unsupported) |
| Hidden reasoning store | — | NOT_NEEDED (intentionally unsupported) |

`merchantMemory` is vendor-name normalization, not AI memory; do not rename it or build on it.

---

## 10. Multi-agent, orchestrator-worker, handoffs, worker isolation

**Is multi-agent justified today? No.** There is one inference use case (form extraction from a
transcript), one planned worker job (`secretary.narration.captured`), and one tool allowlist per
task. Specialisation is justified only when responsibilities differ in tools, permissions,
context, evaluation, model or risk; today that difference is already expressed as **per-task
allowlists under one runtime** (`LOAD_UNLOAD_NARRATION`, `BILL_SCAN`), which gives least
privilege without a second persona. Status: multi-agent runtime `DEFERRED`; named agents
(Document / Dispatch / Safety / Billing / Compliance) `NOT_NEEDED` yet.

**The trigger to revisit** is concrete: a second task whose allowlist would include a capability
at `approval_required` or `restricted` risk that the first task's context must never be able to
reach (the Safety vs Billing case). At that point the split is a security boundary, and it is
built as a second `TaskAllowlist` + worker handler, not a new engine.

**Orchestrator-worker, if ever needed — mapped.**

| Orchestrator owns | Existing home |
|---|---|
| objective | `agentRuns.goal` |
| decomposition | `agentSteps` (plan) |
| budgets | `agentRuns.maxSteps` (to be enforced) |
| allowed workers | `productionWorker.ts` handler list (`withHandlers()`) |
| dependency ordering | `stepNumber`; outbox `causationId` / `correlationId` |
| cancellation | `TRANSITIONS → cancelled` (no procedure reaches it, §15) |
| completion | `isComplete()`; `agentRuns.status = completed` |

**Handoffs.** `AgentHandoff` / `AgentResult` have **no immediate use case and are not implemented**
(`NOT_NEEDED` now). If built, they are not new transport: a handoff is a `domainEventOutbox` row
(`correlationId` = run, `causationId` = parent step, typed `payloadJson`), and a result is the
`agentActions` / `agentSteps` update it causes. Untyped prose between workers stays forbidden —
the same rule `contextAssembly.ts` applies to `external_content`.

**Worker isolation — the intersection.**

```
authenticated actor      TrpcContext of the person (driver-scoped createCaller; no service account)
∩ role permission        permissionForProcedure() + authorize()
∩ job policy             resolveAutomation() for the task/customer scope
∩ worker capability      TaskAllowlist.toolKeys (PR #7); resolveTool() refuses others
∩ automation ceiling     SafetyCeiling; NEVER_AUTONOMOUS re-checked in resolveTool()
```

Each term already exists; every one can only remove authority. The one missing join is tool ↔
capability (P9.8), which decides whether `decide()` sees the tool's risk level.

---

## 11. Existing durable-job infrastructure

| Piece | Existing | Status |
|---|---|---|
| transactional outbox | `domainEventOutbox` (written in the domain transaction) | IMPLEMENTED |
| claim | `SELECT … FOR UPDATE SKIP LOCKED`, lease `CLAIM_LEASE_SECONDS = 120` | IMPLEMENTED |
| retries | `classifyFailure()`, `backoffMs()` (exponential, full jitter, 1 s → 300 s), `attemptCount` | IMPLEMENTED |
| dead-letter | `deadLetteredAt`, `deadLetterReason` after `maxAttempts = 5` | IMPLEMENTED |
| handler routing | `withHandlers()`: `enforcement` handler, then **generic `workflow_rules` fallback** | IMPLEMENTED |
| rule-driven human tasks | `workflowEngine.ts` → `operationalTasks` (dedupe by rule + subject), `ESCALATIONS` | IMPLEMENTED |
| lifecycle | `startOnce()`, `onShutdown()` (worker stopped before pool closes) | IMPLEMENTED |
| queue health | `assessQueueHealth()`, `describeQueueHealth()` | IMPLEMENTED |
| AI job handler | `runSecretaryExtractionJob()` (PR #7); not registered | DECLARED_UNWIRED |
| run executor | nothing claims an `agentRuns` row | MISSING (by design until SPINE) |

Correction to the terminology survey: its §0 says the production worker "registers exactly one"
handler. That is true of *named* handlers, but every unmatched event falls through to the
workflow-rules runtime, which is live. So the repository already runs a durable, idempotent,
rule-driven coordinator in production; the future AI handler is the second named handler.

**Recovery matrix (target: survive restart, DB error, provider/tool timeout, client disconnect).**

| Failure | Behaviour today |
|---|---|
| worker restart | lease expires; another worker reclaims — IMPLEMENTED |
| server restart | outbox rows persist; `onShutdown` drains — IMPLEMENTED |
| temporary DB error | attempt fails → backoff → retry → dead-letter — IMPLEMENTED |
| provider timeout | door 2: 60 s then outbox retry (PR #7); door 1: in-request, no timeout — PARTIAL |
| tool timeout | no tool execution path — MISSING |
| client disconnect | irrelevant once the model call is in the worker; today door 1 runs in-request — PARTIAL |

**Durable job states** requested (`CREATED → QUEUED → RUNNING → WAITING_TOOL → WAITING_HUMAN →
COMPLETED`) map onto `agentRuns.status`: `created`, `ready`, `executing`, `waiting_for_event`,
`waiting_for_approval` / `waiting_for_input`, `completed`, plus `retry_scheduled`, `blocked`,
`paused`, `failed`, `cancelled`. **No new enum is needed.**

---

## 12. Idempotency

Every real-world action needs a replay key. Survey:

| Action class | Mechanism | Status |
|---|---|---|
| agent action decisions | `idempotencyKey = runId:requestId:capability:targetId`; replay returns the original; changed payload under same key → `CONFLICT` | IMPLEMENTED, **but see F2: no unique index** |
| AI proposal commit | `assistantCommitReceipts.proposalId` UNIQUE; lock; write once | IMPLEMENTED |
| outbox events | `eventId` UNIQUE | IMPLEMENTED |
| workflow tasks / notifications | `dedupeKey` (rule + subject); "reprocessing the same event must produce an empty plan" | IMPLEMENTED |
| inbound integrations | `inboundEvents` (`clientId`, `idempotencyKey`) → `duplicate` | IMPLEMENTED (check-then-insert) |
| dispatch award | `awardIdempotencyKey()` matched in `dispatchAuditEvents` | IMPLEMENTED |
| enforcement → violations, citations, OOS orders, work orders | deterministic refs from `idempotencyKey([...])` in `enforcementCommit.ts` | IMPLEMENTED |
| device sync | `deviceSyncNonces` UNIQUE(device, nonce) | IMPLEMENTED |
| documents / disposal | `documentFingerprint.ts` fingerprints | IMPLEMENTED |
| tool invocations | `idempotencyKeyFor({ clientCaptureId, toolKey })` (PR #7) | DECLARED_UNWIRED |
| billing lines added by an agent | no agent billing-write tool exists (`billing.issueInvoice` is a capability that executes nothing) | NOT_NEEDED until a billing tool exists; then it must carry a key |
| outbound notifications from an agent | `messaging.sendReminder` capability executes nothing | NOT_NEEDED until then |

Rule for every future tool: the key is derived server-side from the client capture id or run
step, never minted per retry. "Try again" from the model is a replay, not a second action.

---

## 13. Sensitive actions — existing classification is sufficient

| High-impact operation | Existing classification |
|---|---|
| changing HOS records | `hos.ignoreViolation` ∈ `NEVER_AUTONOMOUS`; HOS attestations are person-signed |
| modifying safety evidence | `safety.clearViolation`, `inspection.bypassFailure` ∈ `NEVER_AUTONOMOUS` |
| billing | `billing.issueInvoice` = `approval_required`; `billing.prepareInvoice` = `prepare` |
| payroll / time | `change_payroll`, `schedule_payment` ∈ `NEVER_AUTOMATIC` |
| dispatching personnel | `assign_person` ∈ `NEVER_AUTOMATIC` |
| equipment compliance | `maintenance.clearOutOfService` ∈ `NEVER_AUTONOMOUS`; `resolve_compliance` ∈ `NEVER_AUTOMATIC` |
| overriding compliance | `compliance.override` = `restricted`, ∈ `NEVER_AUTONOMOUS` |
| deleting sealed evidence | `audit.delete` ∈ `NEVER_AUTONOMOUS` |
| customer/regulatory submission | not a capability yet — **must be classified `approval_required` or higher when added** |
| external communications | `messaging.sendReminder` exists; outbound category forbidden to model tools (`FORBIDDEN_CATEGORIES`, PR #7) |

`RiskLevel` (read → prepare → low_risk_action → approval_required → restricted) plus the two
never-lists, kept consistent by `floorDisagreements()`, is the risk system. **Do not build a
second one.** The only gap is classification of capabilities that don't exist yet.

---

## 14. Observability — each question, answered from structured facts

| Question | Answer today | Status |
|---|---|---|
| What was requested? | `agentRuns.goal`; proposal transcript | IMPLEMENTED |
| Who? | `initiatedByUserId`; `delegatedByUserId`; `authorizationDecisions` | IMPLEMENTED |
| Which organization? | `agentRuns.tenantId` from acting scope | IMPLEMENTED |
| Which model/provider/version? | door 1 discards `result.model`; `RunProvenance` has no columns | MISSING (P9.1, P9.2) |
| Which authorized context? | `inputHash` (PR #7, unstored); `assistantQueries` refs | PARTIAL |
| Tools attempted / refused / succeeded | `agentActions.decision` (attempted, refused); success never recorded | PARTIAL (P9.3) |
| What authoritative data changed? | `assistantCommitReceipts` (`targetType`, `targetRecordId`, `fieldManifestHash`) | IMPLEMENTED |
| Did a human approve? | `agentApprovals`; `readBackAcknowledged`; `proposalFields.status` | IMPLEMENTED |
| What receipt proves it? | commit receipt; `domainEventOutbox.eventId` | IMPLEMENTED |
| How long? | no latency anywhere | MISSING (P9.6) |
| Budget consumed? | `stepsUsed` never incremented; tokens unstored | MISSING (P9.5, P9.6) |
| Why did it stop? | `blockedReason`; dead-letter reason; run never reaches a terminal state | PARTIAL |

---

## 15. Cancellation

| Requirement | Existing | Status |
|---|---|---|
| a cancel state | `agentRuns.status = cancelled`; legal from every non-terminal state in `TRANSITIONS`; `operationalTasks.status = cancelled` | IMPLEMENTED (state) |
| a way to cancel | **no procedure moves a run to `cancelled`** (`agent.*` is start, requestAction, decideApproval, awaitEvent, get) | MISSING |
| no new tool execution after cancel | `agent.requestAction` does **not** check for a terminal run; it records a new decision and can set `waiting_for_approval` / `blocked` on a `completed`/`failed`/`cancelled` run (§20 F3) | MISSING — defect |
| no new model calls after cancel | no executor exists | MISSING (by design) |
| committed work not rolled back | commits are receipted, not reversible by cancel; nothing tries to | IMPLEMENTED by construction |
| committed vs cancelled-future distinguishable | `agentActions.outcome` would show it once advanced | PARTIAL |
| audit event | none for a cancel | MISSING |
| outbox event cancel | none; dead-letter is the only terminal state other than processed | MISSING |

---

## 16. Failure model — mapped, not invented

| Requested | Existing |
|---|---|
| AUTHORIZATION_REFUSED | `authorizationDecisions.outcome = denied_*`; tRPC `FORBIDDEN`; `Decision = deny` |
| VALIDATION_FAILED | zod `BAD_REQUEST`; `Verdict = BLOCKED`; `ExtractionUnparseable` (PR #7) |
| NEEDS_CLARIFICATION | `waiting_for_input`; `assistantQuestions` |
| TOOL_FAILED | `agentActions.outcome = failed`; `FailureKind` (`actionGateway.ts`) |
| PROVIDER_FAILED | `LlmTransportError` (PR #7); door 1 throws, logs via `console.warn` |
| TIMEOUT | provider timeout (PR #7); outbox lease expiry |
| BUDGET_EXHAUSTED | none — map to `blocked` + `blockedReason` (§6) |
| POLICY_BLOCKED | `Decision = compliance_block`; `Verdict = BLOCKED` |
| CONFLICT | tRPC `CONFLICT` (idempotency payload mismatch); `Decision = stale` |
| CANCELLED | `agentRuns.status = cancelled` (unreachable, §15) |
| INTERNAL_ERROR | `failed`; outbox dead-letter |

`FailureKind` + `shouldRetry()` already classifies which of these retry. Nothing new is needed
except the budget reason string.

---

## 17. Pattern → status summary (§21 of the request)

| Component | Status | Where |
|---|---|---|
| job/worker system | IMPLEMENTED | `drainWorker.ts`, `workflowRuntime.ts`, `productionWorker.ts`, `workerLifecycle.ts` |
| outbox | IMPLEMENTED | `domainEventOutbox` |
| retries | IMPLEMENTED | `classifyFailure()`, `backoffMs()` |
| dead-letter | IMPLEMENTED | `deadLetteredAt` |
| receipts | IMPLEMENTED | `assistantCommitReceipts`, outbox `eventId` |
| idempotency fingerprints | IMPLEMENTED (F2 caveat) | §12 |
| authorization | IMPLEMENTED | `roleProcedure` |
| acting scope | IMPLEMENTED | `resolveActingScope()` |
| automation-policy ceiling | IMPLEMENTED (list empty by decision) | `automationPolicy.ts` |
| AI step budget | PARTIAL | `agentRuns.maxSteps` unread; `stepBudget` (PR #7) |
| tool budget | DECLARED_UNWIRED (PR #7) | `spendStep()` |
| tool registry | DECLARED_UNWIRED (PR #7) | `SECRETARY_TOOLS` |
| worker boundary | DECLARED_UNWIRED (PR #7) | `runSecretaryExtractionJob()` |
| model provider boundary | PARTIAL | door 1 live (fails open on host); door 2 PR #7 |
| structured output | IMPLEMENTED | door 1 `json_schema`; door 2 strict |
| clarification | IMPLEMENTED | `assistantQuestions`, `Gap` |
| proposal/approval flow | IMPLEMENTED | proposals → read-back → commit; `agentApprovals` |
| audit events | IMPLEMENTED | §9 audit history |
| telemetry | MISSING (inference); IMPLEMENTED (authorization, retrieval) | §14 |
| cancellation | PARTIAL (state only) | §15 |
| RAG/retrieval | IMPLEMENTED (extractive, no model) | `assistant.ask` |
| context construction | PARTIAL | `admitSource()` live; `ContextPack`, `assembleContext()` unwired |
| orchestrator module | NOT_NEEDED | the agent runtime + workflow runtime are the coordinators |
| multi-agent runtime | DEFERRED | §10 |
| embeddings | DEFERRED | terminology survey §7 |
| generic memory / reasoning store | NOT_NEEDED | §9 |

---

## 18. SPINE remains first

```
BoundaryConfirmation            ← resolver, chain rule and reader on main (#10, #17; 0169 reconciled forward as 0179)
      ↓
remaining SPINE wiring          ← four duplications → offlineCapability → dispatch gate … job close
      ↓
remove synchronous request-handler LLM call (assistant.draft, owner's carve-out ruling)
      ↓
durable AI worker path          ← register the Secretary handler (PR #7 lands first)
      ↓
tool execution                  ← createCaller composition root; persisted tool results (P9.3, P9.4)
      ↓
agent loop                      ← run executor, budget enforcement, cancel procedure
      ↓
advanced retrieval / RAG        ← records via tools; embeddings only on measured vocabulary gap
      ↓
possible multi-agent specialisation  ← only on the §10 trigger
```

Not built here, and not to be built ahead of the SPINE: multi-agent runtime, a new AI engine, an
orchestrator module, embeddings/vector DB, a generic memory DB, an autonomous long-running
production loop.

---

## 19. Terminology additions

Added to `AI_RUNTIME_TERMINOLOGY.md` §22 with status beside each term.

---

## 20. Findings

**F1 — the synchronous LLM pin is not on this branch.** `server/routers.ts` (line 794 on `main`)
calls `invokeLLM()` inside `fieldRoute.assistant.draft`. The test that pins that at exactly one call
(`server/_core/ai/workerBoundary.test.ts`) and the moratorium document it cites
(`docs/register/SECRETARY_SPINE_MORATORIUM.md`) arrive with PR #7, which is open. Until #7 lands,
nothing on `main`-line branches stops a second in-request model call. **Decision (2026-09-25):**
port only the guard, independently of PR #7, on its own branch (§22).

**F2 — `agentActions.idempotencyKey` is not unique.** `drizzle/0100_agent_runs.sql` line 16 says
"`idempotencyKey` is unique", but line 90 creates a plain `INDEX`. `agent.requestAction` does
check-then-insert (`agentRouter.ts:185`), so two concurrent requests with the same `requestId`
can both miss the check and write two decisions. Nothing executes, so the impact today is a
duplicated audit row, not a duplicated action — but this is the table the eventual executor
would trust for "has this been done". Fix is a migration (unique index), which is out of scope
for this checkpoint and would land in the contested migration range
(`docs/architecture/MIGRATION_COLLISION_REGISTER.md`). Recorded as P9.11.

**F3 — `agent.requestAction` ignores terminal runs.** It checks tenant and existence only, then
may set `waiting_for_approval` (line 253) or `blocked` (line 256) without consulting
`TRANSITIONS`. A `completed`, `failed` or `cancelled` run can be re-opened that way, which
contradicts `TRANSITIONS[cancelled] = []`. Harmless while nothing executes; a correctness
prerequisite for cancellation. Recorded as P9.12 (F3A, terminal runs) and P9.13 (F3B, the cancel action).

**F4 — hidden reasoning: none persisted or requested.** Re-verified on this tree:
`InvokeParams.thinking` / `.reasoning` in `llm.ts` are passthroughs **no caller sets**;
`agent.requestAction`'s `reasoningSummary` (≤ 600 chars, caller-supplied) is placed on
`ActionRequest` and **not persisted** (no column); `assistantProposals.notes` is observable,
overreach-checked model output. No table, column or type stores chain-of-thought. `evidenceRefs`
is also dropped, which is the wrong half to drop (P9.10).

**F5 — the terminology survey understated live orchestration.** See §11.

---

## 21. Final report

1. **How close LeaseOS is to an agent runtime.** Close in *authority* and *durability*, far in
   *execution*. Authorization, acting scope, policy ceilings, HITL, payload-bound approvals,
   proposal/receipt commits, the outbox with retry/dead-letter, and a live rule-driven task
   coordinator all exist and are reached. What does not exist is anything that *acts*: no
   executor claims an `agentRuns` row, no tool result is persisted, no budget is enforced, and
   the typed tool/context/provider layer is in an open PR, unwired.
2. **Is there an orchestrator?** Not by that name, and none should be added. Coordination lives
   in the agent runtime (`agentRouter.ts` + `actionGateway.ts`) and the live workflow runtime
   (`workflowEngine.ts` → `operationalTasks`). The missing piece is a worker handler, not an engine.
3. **Loop/budget mechanisms.** `TRANSITIONS` (live), `agentRuns.maxSteps`/`stepsUsed` (dead),
   `stepBudget`/`spendStep()`, `MAX_CLARIFY_ROUNDS`, `detectNoProgress()` (unwired), outbox
   `maxAttempts` (live). No inference-call, token, cost or deadline budget.
4. **Durable jobs.** Transactional outbox, SKIP LOCKED claim with 120 s lease, jittered
   exponential backoff, dead-letter after 5, graceful shutdown, queue-health — all live.
5. **Retry/idempotency.** Strong and widespread (commit receipts, outbox, workflow dedupe,
   dispatch award, enforcement refs, device nonces, inbound events, fingerprints). One real gap:
   F2.
6. **HITL / automation policy.** The most complete part: scope-ordered resolution, safety-ceiling
   clamp, narrow-only overrides, two never-lists kept consistent, payload-hash approvals,
   self-approval refusal. The ceiling list is an open owner decision, not a code gap.
7. **Context management.** Admission is live and strong (branded blocks, per-passage
   authorization, instruction authority). Operational context packs, mixed-tenant refusal,
   pruning and budget-in-context are unwired or absent — acceptable while every inference is
   one-shot.
8. **Retrieval/RAG.** Live, extractive, measured, model-free. Records reach a model via scoped
   read tools (unwired), not an index. Embeddings deferred on a measurable condition.
9. **Multi-agent justified?** No. One runtime with per-task allowlists gives least privilege now.
   Revisit on the specific trigger in §10.
10. **Duplicate agent architectures.** No duplicate *agent runtime*. The known parallels stand
    (two registries, two LLM doors, two prompt sources, two extraction contracts, two never-lists,
    three clarification vocabularies — terminology survey §18). Agent runtime vs workflow runtime
    is a split by responsibility (agent requests vs human tasks from rules), not a duplication.
11. **Hidden chain-of-thought.** Not persisted, not requested (F4). Keep `thinking`/`reasoning`
    unset; persist `evidenceRefs`, not `reasoningSummary`.
12. **Minimum additions after the SPINE** (in order, none new engines):
    a. register the Secretary worker handler; retire the in-request call (P9.4, P9.1);
    b. persist tool results by advancing `agentActions.outcome` + result hash, and give tools a
       version (P9.3);
    c. enforce `maxSteps`/`stepsUsed` with `blocked` + budget reason (P9.5);
    d. unique index on `agentActions.idempotencyKey` (P9.11) and a terminal-run guard (P9.12, F3A) and, later,
       an `agent.cancel` procedure that writes an audit row (P9.13, F3B);
    e. provenance + inference telemetry columns (P9.2, P9.6);
    f. join tool → capability (P9.8); persist `evidenceRefs` (P9.10);
    g. only then, a bounded multi-step executor over `agentSteps`.
13. **Does anything change the SPINE sequence?** No. F1 argues for landing PR #7 (declared
    unwired) before any further in-request AI work, which is already the moratorium's intent.
    F2 and F3 are agent-runtime defects that nothing executes on. After owner review (§22), F1's
    guard and F3A's state-integrity repair go ahead as narrow fixes on their own branches; F2 and
    F3B stay at step (d), after the SPINE.

---

## 22. Decisions recorded (owner review, 2026-09-25)

The documentation checkpoint is accepted. The architectural conclusions stand: no new
orchestrator; `workflowEngine` already performs much of the orchestration role; multi-agent and
embeddings stay deferred; hidden chain-of-thought is never stored; `evidenceRefs` should
eventually be retained; existing LeaseOS records are the authoritative memory; durable execution
reuses the existing outbox/worker. The findings are handled by risk, **not** as one AI bugfix
branch, and none of them moves ahead of the SPINE except narrow integrity fixes.

**Architecture is a composition, not a module.** The runtime is

```
durable outbox/worker  +  workflowEngine  +  agent router  +  authorization  +  automation policy
```

No `orchestrator.ts` is created for naming consistency. If the post-SPINE executor needs one
coordinating function, it adds the smallest controller required at that time and does not
duplicate the live workflow engine.

| Finding | Decision | Where |
|---|---|---|
| **F1** request-handler model guard | Fix now, guard only. Pin the known violation (`assistant.draft → invokeLLM`) at exactly 1; fail at 2+; fail at 0 with a message to lower the pin. The call itself is not refactored. Not obtained by merging PR #7. | own branch, `claude/ai-request-boundary-guard` |
| **F2** `agentActions.idempotencyKey` not unique | **Deferred, release-blocking.** Migration-bearing, and migration numbering is contended (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`: every number from 0175 to 0188 is claimed by at least one open branch). No migration number is chosen now. | P9.11 |
| **F3A** terminal runs can reopen | Fix now as a state-integrity repair of existing code, using the existing `TRANSITIONS` table; RED tests first; no second transition table. | own branch |
| **F3B** no cancellation action | **Deferred** to the post-SPINE executor. No cancel procedure in this checkpoint. | P9.13 |
| **P9.10** `evidenceRefs` dropped | Kept. Evidence references matter more than any reasoning text. No schema change yet. | P9.10 |
| Budgets | No second budget representation. | P9.5 |

**F2 — the eventual fix, in order.** (1) Identify the exact intended key (today
`runId:requestId:capability:targetId`, derived server-side). (2) Inspect existing rows for
duplicates. (3) Decide deterministic remediation if any exist. (4) Add the UNIQUE constraint —
never by flipping the existing index to unique without step 2. (5) Keep application-level
handling: a duplicate-key error on insert is a replay and returns the original decision, with the
existing `payloadHash` conflict check preserved. (6) A concurrency test proving two simultaneous
attempts produce one authoritative action.

**F3B — the semantics a cancellation must have** (designed with the worker executor):

- a cancelled job receives no new inference calls and executes no new tools;
- domain actions already committed stay committed — cancellation never rolls back a receipt;
- cancellation writes an audit event;
- cancellation is idempotent: cancelling a cancelled job returns the same outcome;
- cancellation requires authorization, like every other `agent.*` procedure;
- a completed or failed job cannot be reopened, or relabelled, through cancellation;
- a worker that observes cancellation between steps stops cleanly and records where it stopped.

**Budget invariant for the post-SPINE executor.** `stepsUsed <= maxSteps` is server-enforced, and
the loop consumes budget atomically (a conditional `UPDATE … SET stepsUsed = stepsUsed + 1 WHERE
stepsUsed < maxSteps`) *before* performing a step. The model never supplies or raises `maxSteps`.
Inference, token, cost and deadline budgets are designed later, on the same row.

**Evidence provenance, when the worker path is built,** is recorded alongside: model identifier,
provider, prompt version, tool results, authorization decision, human approval and the resulting
receipt. `evidenceRefs` is preferred over `reasoningSummary` for audit; model reasoning is never
persisted.

**The main sequence, unchanged:**

```
BoundaryConfirmation → SPINE item 1 → remaining SPINE wiring → remove assistant.draft synchronous
model call → register durable AI job → save tool results / evidence refs → enforce step budget →
database-backed idempotency → cancellation → multi-step agent executor → advanced RAG / context
management → only then reconsider multi-agent
```

---


## 23. Tools versus Skills

**Documentation only, added 2026-10-01 after merging `main` at `b35bac4`.** No code, type,
table, loader or registry was added for this section. "The survey" means
`AI_RUNTIME_TERMINOLOGY.md`; its §23 carries the short term entries for Tool and Skill. **PR #7 has
since merged:** `server/_core/ai/` is now in this tree. Every module in it is still listed in
`DECLARED_UNWIRED` in `server/engineReachability.test.ts` under the moratorium, so the statuses
below are unchanged. Only the "(PR #7)" qualifier no longer applies. Since §1–§22 were written,
#7's merge made one change that matters here: `idempotencyKeyFor()` now returns a versioned hash
(`IK1-…`, 40 characters, pinned by test), not `toolKey:captureId`.

### 23.1 The rule

> **A Tool carries authority and executes. A Skill carries procedure and judgement and grants
> zero authority.**

| Term | Definition | Question it answers |
|---|---|---|
| **Tool** | One narrowly defined executable capability, bound server-side to exactly one existing procedure. | "What can be done?" |
| **Skill** | A reusable operating procedure for a class of tasks: objective, required information, steps, expected tools, decision rules, verification, clarification, approval checkpoints, completion criteria, escalation. | "How should it be done?" |
| **Prompt** | The instructions supplied to one inference request. A Skill may contribute content to several prompts. | "What does the model read this call?" |
| **Agent** | The runtime that runs the procedure. In LeaseOS this is the **agent runtime**, `agentRouter.ts` + `actionGateway.ts` (survey §4). | "Who is executing?" |
| **Orchestration** | Coordination across jobs, steps and workers. Its homes are listed in survey §4, and "orchestrator" is not a LeaseOS word. | "What runs next, where?" |
| **Business workflow** | Deterministic coordination written as code or a state machine. It never becomes a Skill. See 23.13. | "What must always happen?" |

```text
                 AGENT (agent runtime)
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
       SKILLS              TOOLS
   "How to do it"      "What can be done"
   (grants nothing)          │
         │                   ▼
         │           ToolDefinition → ProcedureName
         │                   │
         └──────────► Tool selection (tool KEY only)
                             │
                             ▼
              Authorization gate — roleProcedure / decide()
                             │
                             ▼
                          Action
```

A Skill may recommend or require a Tool. It cannot bypass any of that Tool's controls:
authentication (`TrpcContext`), authorization (`roleProcedure` → `authorize()`), acting scope
(`resolveActingScope()`), automation policy (`resolveAutomation()`, `NEVER_AUTONOMOUS`,
`NEVER_AUTOMATIC`), argument validation (the procedure's zod `.input()`), human approval
(`agentApprovals`, read-back), budget (`spendStep()`), idempotency (`idempotencyKeyFor()`), or
audit (`authorizationDecisions`, `agentActions`).

### 23.2 Effective authority is an intersection

```text
Skill's expected tools        (a Skill can only name — never grant)
    ∩  Actor permission        roleProcedure → permissionForProcedure()      [live]
    ∩  Acting scope            resolveActingScope()                          [live]
    ∩  Tool allowlist          TaskAllowlist + resolveTool()                 [unwired]
    ∩  Gateway decision        decide(): origin, registry, NEVER_AUTONOMOUS,
                               compliance, heldPermissions, requiresOnline,
                               revision, risk ladder, autoExecute            [live, executes nothing]
    ∩  Automation policy       resolveAutomation(), SAFETY_CEILINGS          [live]
    ∩  Worker / device ability OfflineClass, CapabilityDefinition.requiresOnline
    =  Effective authority
```

Every term in the intersection can only make the set smaller. The code already has this shape
in three places. `resolveTool()` refuses anything outside the task list and re-checks
`NEVER_AUTONOMOUS` even for listed tools. `invokeTool()` calls through the driver's own
`createCaller(ctx)`, so `roleProcedure` refuses exactly what it would refuse the driver.
`evaluateOperationalOverride()` may narrow toward MANUAL and never widen.

**Worked example: Skill ≠ permission.** Suppose a detailed "Dispatch a vacuum truck to a lease"
Skill is loaded for a user who holds only Driver authority. The dispatch mutation is a
`roleProcedure`. The driver lacks its permission, so `authorize()` returns `denied_permission`
and writes an `authorizationDecisions` row, and the call is refused. The Skill has no field
that could change that outcome, and no future Skill format may add one.

### 23.3 Tools — the architecture that exists

Two registries exist, as recorded in survey §18 item 1. Neither refers to the other yet; P9.8
(§21 item 12f) and `SECRETARY_AGENT_ROSTER.md` §5 record where they will meet.

| | Model-facing **Tool** | Gateway-facing **Capability** |
|---|---|---|
| Type | `ToolDefinition` (`server/_core/ai/tools/registry.ts`) | `CapabilityDefinition` (`server/_core/actionGateway.ts`) |
| Registry | `SECRETARY_TOOLS` (11 tools: 5 `read.*`, 5 `propose.*`, `human.requestAction`) | `CAPABILITIES` in `agentRouter.ts` (6 entries) |
| Binds to | one `ProcedureName`, checked by the compiler | a list of permission names + `RiskLevel` |
| Categories / risk | `read`, `propose`, `human_step`; `FORBIDDEN_CATEGORIES` = commit, delete, permission_change, mode_change, payment, outbound_email, outbound_web | `read` → `restricted` |
| Status | **DECLARED_UNWIRED** | **IMPLEMENTED** as data and decision, never executes |

These are the actual tool keys. They are used below instead of the illustrative names in the
request (`read.currentJob`, `notify.dispatch`, `seal.document` do not exist):

| Key | Procedure | Pinned argument |
|---|---|---|
| `read.tripStops` | `tripStops.list` | — |
| `read.loads` | `loads.list` | — |
| `read.unitSpecs` | `units.list` | — |
| `read.closeoutState` | `closeout.state` | — |
| `read.approvedDocuments` | `assistant.passageList` | — |
| `propose.unloadStop` | `assistant.draft` | `formKey: "unload_stop"` |
| `propose.disposalTicket` | `assistant.draft` | `formKey: "disposal_ticket"` |
| `propose.preTripFinding` | `assistant.draft` | `formKey: "defect_report"` |
| `propose.expenseReceipt` | `assistant.draft` | `formKey: "expense_receipt"` |
| `propose.fuelReceipt` | `assistant.draft` | `formKey: "fuel_receipt"` |
| `human.requestAction` | `agent.requestAction` | — |

`PROPOSE_TOOLS_NOT_POSSIBLE_YET` records `propose.dutyEvent`, `propose.workOrder` and
`propose.billingLine` as blocked on missing `FORMS` entries. No facility-lookup tool, current-job
tool, notification tool or sealing tool exists.

**Authorization path for a tool, hop by hop.** This is the survey §5 path with the refusal point at
each hop:

| Hop | Code | Refuses when | Status |
|---|---|---|---|
| model emits key + args | — (no path does this) | — | MISSING |
| key → definition | `resolveTool(allowlist, key)` | key unknown **or** not on the task list (identical message); procedure on `NEVER_AUTONOMOUS` | DECLARED_UNWIRED |
| budget | `spendStep()` (after allowlist, so a refusal costs no step) | `stepBudget` spent → `StepBudgetExhausted` | DECLARED_UNWIRED |
| arguments pinned | `planToolCall()` overwrites `formKey`; derives idempotency key | — | DECLARED_UNWIRED |
| caller | `invokeTool({ ctx, createCaller })`, driver's own `TrpcContext` | no composition root supplies `createCaller` | DECLARED_UNWIRED |
| authorization | `roleProcedure(name)` → `permissionForProcedure()` → `authorize()` → `recordAuthorizationDecision()` | `denied_*` outcomes | IMPLEMENTED |
| validation | the procedure's zod `.input()` | malformed args → `BAD_REQUEST` | IMPLEMENTED |
| domain | the procedure body; for proposals, later `executeAssistantCommit()` with a second authorization | domain refusal | IMPLEMENTED |

**The requested `ToolDefinition` contract, mapped onto existing fields.** Nothing was added.

| Requested field | Existing home | Status |
|---|---|---|
| `key` | `ToolDefinition.key` | DECLARED_UNWIRED |
| `version` | none (survey §19 already lists it) | MISSING |
| `purpose` | `ToolDefinition.description` | DECLARED_UNWIRED |
| `inputSchema` | the target procedure's zod `.input()`; not restated on the tool, and the tool should not duplicate it | IMPLEMENTED (at the procedure) |
| `outputSchema` | the procedure's inferred return type; not declared on the tool | PARTIAL |
| `procedure` | `ToolDefinition.procedure: ProcedureName` | DECLARED_UNWIRED |
| `fixedArgs` | `ToolDefinition.formKey` only; the one pinned argument kind that exists | PARTIAL |
| `requiredCapability` | none; tool and capability are not joined (survey §18 item 1) | MISSING |
| `riskClass` | coarse proxy `ToolCategory`; real ladder is `CapabilityDefinition.riskLevel` | PARTIAL |
| `automationPolicy` | `automationPolicies` keyed by `CAPABILITY.*`, not by tool | PARTIAL |
| `idempotencyPolicy` | `requiresIdempotencyKey` + `idempotencyKeyFor()` | DECLARED_UNWIRED |
| `budgetCost` | none; every call costs one step | MISSING (not needed until costs differ) |
| `auditCategory` | none; audit is keyed by procedure in `authorizationDecisions` | NOT_NEEDED (procedure is the audit key) |

The model supplies none of the following, and the table shows where each is already enforced:
procedure name (`ProcedureName`, `invokeTool` takes a key), required permission
(`permissionForProcedure()`), fixed form key (`planToolCall()` overwrite), acting organization
(`resolveActingScope()`), caller identity (`TrpcContext` handed in; `caller.ts` builds none),
automation ceiling (`SAFETY_CEILINGS`, `SecretaryProposal.ceiling`), and risk classification
(server constants).

**Definition → Request → Execution → Result → Receipt.** Each stage already has a separate shape.
Keep them separate.

| Stage | Registry path | Gateway path | Status |
|---|---|---|---|
| ToolDefinition | `ToolDefinition` | `CapabilityDefinition` | unwired / implemented |
| ToolRequest | `ToolInvocation { toolKey, input, clientCaptureId }` | `ActionRequest` → `agentActions` row | unwired / implemented |
| ToolExecution | `invokeTool()` | none by design | unwired / DEFERRED |
| ToolResult | `ToolResult` returned, **not persisted** | `agentActions.outcome` never advanced past `requested` | PARTIAL |
| ToolReceipt | the `authorizationDecisions` row each `roleProcedure` call writes; `assistantCommitReceipts` for commits only | `agentActions` (refusals included) | PARTIAL — no receipt for a read tool beyond the authorization row |

The requested terminal outcomes map onto existing equivalents. **No new enum is needed.**

| Requested | Existing equivalent |
|---|---|
| SUCCEEDED | `ToolResult` returned; `agentActions.outcome` `executed` / `verified` |
| REFUSED | `ToolNotAllowed`; `StepBudgetExhausted`; `roleProcedure` `FORBIDDEN` + `authorizationDecisions.outcome denied_*`; `Decision` `deny` / `compliance_block` / `stale` |
| VALIDATION_FAILED | zod `BAD_REQUEST` from the procedure |
| APPROVAL_REQUIRED | `Decision` `require_approval` → `agentApprovals`; run `waiting_for_approval` |
| FAILED | `agentActions.outcome failed`; run `failed`; outbox dead-letter |
| CANCELLED | run `cancelled` (`TRANSITIONS`) |

**Tool discovery is not tool permission.** Four sets already exist:

| Set | Where | Example today |
|---|---|---|
| registered tools | `SECRETARY_TOOLS` | 11 |
| available to the job | `TaskAllowlist.toolKeys` | `LOAD_UNLOAD_NARRATION` 5, `BILL_SCAN` 2 |
| authorized for the actor | `roleProcedure` at call time | computed per call, not in advance |
| currently executable | `decide()` + automation policy + `requiresOnline` | computed per call |

The model should be shown the second set at most. Pre-filtering to the third set, by computing
`permissionForProcedure(tool.procedure)` against the actor's held permissions before rendering
tool descriptions, is possible from existing functions. It is an optimisation, not a control:
the call-time check stays authoritative. **DEFERRED** until door 2 is wired.

### 23.4 Does LeaseOS already have Skills?

**Not by name. The parts exist, split across four artifacts that nothing binds together.** For
the Secretary's form-driven tasks, the Skill is already present in decomposed form:

| Skill element | Existing artifact | Status |
|---|---|---|
| key | `TaskAllowlist.taskKey` (`load_unload_narration`, `bill_scan`) | DECLARED_UNWIRED |
| objective | `FormDefinition.title` + prompt prose | IMPLEMENTED / unwired |
| required information | `FormFieldDef.required` | IMPLEMENTED |
| clarification conditions | `precisionSensitive`, `Gap.kind`, `minimumQuestions()` (max 3), `MAX_CLARIFY_ROUNDS` | IMPLEMENTED (gaps) / unwired (rounds) |
| allowed / expected tools | `TaskAllowlist.toolKeys` | DECLARED_UNWIRED |
| budget | `TaskAllowlist.stepBudget` | DECLARED_UNWIRED |
| procedure / decision rules | `secretary-extract.v1.md` (status rules, never-convert rules, injection rule) | DECLARED_UNWIRED |
| step sequence | `DialoguePhase` LISTEN → … → PROPOSE, `advance()` | DECLARED_UNWIRED |
| verification | `validateExtraction()`, quote check, normalizers; `detectGaps()`; `checkCommit()` | unwired / IMPLEMENTED |
| approval checkpoint | read-back → `acknowledge` → `commit`; `SecretaryProposal.ceiling = "HYBRID"` | IMPLEMENTED / unwired |
| completion criteria | `commitState = "committed"` + `assistantCommitReceipts` row | IMPLEMENTED |
| escalation | `DRAFT_FOR_OFFICE`, `human.requestAction`, `heldBecause` | unwired |
| version | `FormDefinition.version` (stored as `assistantProposals.formVersion`); `PromptVersion` + `promptHash()` | PARTIAL — `TaskAllowlist` has none; prompt hash has no column |

Therefore **the survey §8 recommendation already describes the minimum Skills subsystem**: a
`PromptContract` binding `PromptVersion` + form key + `TaskAllowlist` + ceiling. A Skill is that
contract with verification and escalation named explicitly. **Do not build a second, parallel
"skill" artifact beside `FORMS` and `TaskAllowlist`.** Doing so would create a third
never-automatic list, a third clarification vocabulary, and one more copy of every duplication
in survey §18.

**Could existing forms become Skills instead of being duplicated?** Yes, for the five `FORMS`
(`unload_stop`, `defect_report`, `expense_receipt`, `disposal_ticket`, `fuel_receipt`). Each is
already the "required information + clarification" half of a Skill. The form stays the data
contract, and a Skill *references* a form key and never restates its fields. The request's
examples map as follows:

| Requested Skill | Existing basis | Verdict |
|---|---|---|
| Complete / process a disposal ticket | `disposal_ticket` form, `propose.disposalTicket` | candidate; worked example in 23.6 |
| Perform a pre-trip inspection | `defect_report` form, `propose.preTripFinding` ("a human signs the inspection") | candidate for *finding capture* only; the inspection itself stays human |
| Process a driver defect | `defect_report` form → `WORKFLOWS.critical_defect` | AI part = capture; the rest is a deterministic workflow |
| Prepare a lease departure package | `preDepartureCache`, `tripPassportPackage` | deterministic; not a Skill |
| Review a dangerous-goods load | `evaluateDangerousGoodsAssist()` (never classifies from free text) | AI may assist extraction only; classification stays deterministic + human |
| Close out a completed job | `closeout.state`, `fieldTicket`, `siteCloseout` | deterministic |
| Escalate a safety incident | `escalation.ts`, `DEFAULT_CRITICAL_POLICY` | deterministic |
| Prepare a billing package | `tripBillingProjection`, `linePricing`, invoice path | deterministic; `propose.billingLine` is blocked on a form anyway |

### 23.5 Skill mechanics — status of each seam

| Seam | Existing | Classification |
|---|---|---|
| Skill definition | decomposed across `FORMS` × `TaskAllowlist` × `PromptVersion` × validator (23.4) | PARTIAL |
| Skill loader | `loadPrompt()` loads one versioned prompt file with a cache; no loader for anything larger | NOT_NEEDED now; DEFERRED. A typed constant module (like `SECRETARY_TOOLS`) is preferable to a runtime file loader, because the compiler then checks tool keys and form keys. Do not assume `SKILL.md`. |
| Skill registry | two `TaskAllowlist` constants; no lookup by key | PARTIAL / DECLARED_UNWIRED |
| Skill selection | by entry point: `runSecretaryExtractionJob()` is handed its `FormDefinition` by the caller; `assistant.draft` takes `formKey` from a server route. The model never picks the task. | IMPLEMENTED deterministically — keep it that way |
| Unsupported Skill | an unknown form key has no schema; an unknown task has no allowlist; `resolveTool()` refuses; `classifyRequest()` refuses off-perimeter | IMPLEMENTED in effect. The requested `SKILL_NOT_AVAILABLE` is `ToolNotAllowed` / a perimeter refusal. No new code. |
| Skill versioning | `formVersion` stored; `promptHash` computed and **not stored**; tool and allowlist unversioned; policy via append-only `automationPolicies` + `PolicySnapshot` | PARTIAL |
| Verification | door 1: `detectGaps()`, read-back, `checkCommit()`, commit adapters; door 2: `validateExtraction()` | IMPLEMENTED (door 1) / unwired (door 2) |
| Progressive loading | by construction: each request loads **one** form schema, **one** prompt, **one** context pack (`buildSystemPrompt(form)`, `runExtraction()`) | IMPLEMENTED at form granularity |
| Skill tests | `agentTools.test.ts` resolves each tool's procedure through `permissionForProcedure()`; `FORBIDDEN_CATEGORIES` asserted structurally; `goldenSet.test.ts` scores per form | PARTIAL; the pattern exists |

**"Done" is defined by the procedure, not by the model.** This already holds on the live path.
The model cannot declare a proposal complete. `commitState` reaches `committed` only through
`assistant.commit` → `executeAssistantCommit()`, after gaps are cleared and a read-back is
acknowledged, and it leaves an `assistantCommitReceipts` row with `fieldManifestHash` and
`authorizationDecisionId`.

**Audit provenance ("why did LeaseOS do this, six months later?").** A reply today can name the
form key and version, the authorization decision, and the committed values. It cannot name
the prompt version or hash, the model, the tool versions, or the task/Skill version, because
none of these has a column (survey §19). The run-provenance columns already recommended in survey §19 are
the fix. Adding `taskKey` beside them would record the Skill key. **Do not rely on current
Skill content**: a Skill, like a prompt, must be a new version rather than an in-place edit.
`prompts/index.ts` already states this rule for prompts.

### 23.6 Worked example — "Process Disposal Ticket", with real names

```text
SKILL (not built; composed from what exists): disposal_ticket
  form: FORMS.disposal_ticket v1   prompt: secretary-extract.v1   ceiling: HYBRID

 1. Read trip stops ............ Tool read.tripStops     → tripStops.list      [roleProcedure]
 2. Read loads ................. Tool read.loads         → loads.list          [roleProcedure]
 3. Read closeout state ........ Tool read.closeoutState → closeout.state      [roleProcedure]
 4. Extract ticket fields ...... model inference, strict json_schema from FORMS
 5. Verify evidence ............ validateExtraction(): quote in transcript,
                                 ticket_prefix_missing, volume_unit_missing …   (deterministic)
 6. Facility known? ............ NO TOOL EXISTS for facility lookup. facilityName stays a
                                 stated/ambiguous field; a person resolves it.  (gap, not built)
 7. Critical value missing? .... facilityTicketNumber / ticketDate / quantities are
                                 precisionSensitive → Gap → assistantQuestions
        ├─ yes → NEEDS_CLARIFICATION (awaiting_answers; ≤ 3 questions, ≤ 3 rounds)
        └─ no
 8. Propose .................... Tool propose.disposalTicket → assistant.draft,
                                 formKey pinned, idempotency key from clientCaptureId
 9. Verify ..................... detectGaps() empty → read-back → human acknowledge
10. COMPLETE ................... assistant.commit → executeAssistantCommit()
                                 → assistantCommitReceipts row
```

The Skill supplies the order and the stopping rules. Only the Tools touch records. If the driver
lacks `assistant.draft`'s permission, step 8 is refused at `roleProcedure`, whatever the Skill
says.

### 23.7 Guardrails stay layered

| Layer | Example in LeaseOS | Lives in |
|---|---|---|
| Skill | "Never finalize without a facility ticket number" | `required` + `precisionSensitive` on the form; prompt rules |
| Tool | `propose.disposalTicket` can only draft `disposal_ticket` | `ToolDefinition.formKey`, `planToolCall()` |
| Authorization | who may call `assistant.draft` | `roleProcedure`, `authorizationDecisions` |
| Automation policy | whether the AI may reach confirmed unattended | `resolveAutomation()`, `SAFETY_CEILINGS`, `NEVER_AUTOMATIC` |
| Domain validation | whether the record is valid | commit adapters, `checkCommit()` |
| Database | last-resort integrity | unique `assistantCommitReceipts.proposalId`, FKs, enums |
| Human approval | sensitive decisions | read-back + acknowledge; `agentApprovals` bound to `payloadHash` |

A Skill adds to these layers and replaces none of them. A rule that exists only in Skill prose
is a suggestion to a model, not a control.

### 23.8 MCP

**Status: MISSING, and NOT_NEEDED now.** No MCP client, server, SDK dependency or document exists
anywhere in `server/`, `client/`, `shared/` or `package.json`.

The canonical position if it is ever added:

```text
MCP                    = a transport for exposing tools/resources
LeaseOS tool registry  = the canonical list of what the AI may request   (SECRETARY_TOOLS)
LeaseOS authorization  = whether this actor may execute it              (roleProcedure / decide())

MCP server → discovery/import → LeaseOS allowlist → LeaseOS ToolDefinition wrapper
           → authorization → execution
```

Connecting an MCP server must never make its tools reachable automatically. The registry's
existing property enforces this: a tool must name a compiled `ProcedureName`, and an MCP tool
has none until someone writes a procedure for it. An MCP tool offering outbound email, web or
payment would also fall inside `FORBIDDEN_CATEGORIES`. **DEFERRED**, and not to be added simply
because the protocol is available.

### 23.9 External integrations

| Integration | Existing | Exposed to the agent as a Tool? |
|---|---|---|
| Outbound webhooks | `integrationGateway.ts` (HMAC-signed, 6 attempts, dead-letter) via `webhookDispatchService.ts` | no — and outbound categories are forbidden |
| Inbound feeds (GPS, fuel, ELD, telemetry, faults…) | `intakeDecision()` via `integrationRouter.ts`; each feed "becomes" evidence or a **proposal** | no — feeds arrive as `external_content`, which may never instruct (`MAY_INSTRUCT`) |
| External data sources | `externalDataRegistry.ts`, `feed*` family (not started) | no |
| Model providers | `llm.ts` (door 1), `LlmProvider` (door 2) | n/a — the model is not a tool of itself |

Secrets stay server-side and are read from environment variables (`ENV.*`, `LLM_API_KEY`). No
tool input carries a credential. Integration failures are already typed
(`deliveryOutcome() → delivered | failed | dead` with a reason; `LlmTransportError`), so no raw
API error body needs to reach model context. **Status: IMPLEMENTED as integrations, DEFERRED as
agent tools.** The first integration tool would need a new `ToolCategory`, and the existing
`FORBIDDEN_CATEGORIES` list is where the owner decides whether to allow it.

### 23.10 Sandbox / code execution

**Status: MISSING, and intentionally NOT_NEEDED.** No `child_process`, `vm`, `new Function` or
`eval` appears in non-test server, shared or client code. `ModelTask "code"` in `modelGateway.ts`
is a provider-routing label, not an execution capability. If execution is ever proposed, rank it
by risk and prefer the narrowest form:

| Form | Risk | LeaseOS preference |
|---|---|---|
| deterministic calculator / domain function | lowest | already how LeaseOS works (`money.ts`, `hos.ts`, `iftaEngine.ts`, …) |
| query abstraction | low if scoped | a read tool over an existing `roleProcedure`; never SQL (survey §5) |
| document parser | medium | `documentExtraction.ts` pattern, output → proposal |
| restricted script sandbox | high | not justified by any current workflow |
| general OS shell | unacceptable | never |

### 23.11 Offline tool capability

**The classification the request proposes already exists. Do not add a second one.**
`server/_core/offlineCapability.ts` (DECLARED_UNWIRED: "no device runtime calls them yet") defines
`OfflineClass` and binds it to the gateway's `RiskLevel` through `validateCapability()` /
`classRiskDisagreements()`. It states the rule this section needs: *the class is declared, never
inferred; a model deciding something "seems safe enough to do locally" is the model granting
itself authority.*

| Requested | Existing `OfflineClass` |
|---|---|
| LOCAL_TOOL | `local_capture` (record what the person observed) |
| OFFLINE_CAPABLE_TOOL | `local_safe` (read what is already on the device), `local_prepare` (draft for later server decision) |
| CONNECTED_TOOL / SERVER_ONLY_TOOL | `server_authoritative` (one class; LeaseOS draws no distinction between the two) |

Two more seams already exist: `CapabilityDefinition.requiresOnline`, which `decide()` enforces
live ("Offline, this can be prepared and not performed"), and the six client sync states in
`client/src/runtime/contracts.ts` (`saved_locally | queued | syncing | synchronized | failed |
conflict`). A Skill that captures offline therefore ends in `saved_locally` / `queued`, never in
COMPLETE, and the worker path in the Secretary job header ("the extraction happens after") is
already designed for that.

**Gap:** `ToolDefinition` carries no `offlineClass`. The consistent fix is the survey §18 item 1 join. A tool
declares its capability, and the capability carries `offlineClass`, so there is one vocabulary.
This is the HS1 seam that SPINE ordering step 3 already schedules.

### 23.12 Context budget

The target is **base contract + one selected Skill + relevant policy + authorized context +
current tool results**. Nothing today loads every form, prompt or manual into a request (23.5,
progressive loading). The record of which Skill ran belongs in the same provenance columns as
the prompt hash (23.5). Store it on the proposal and, when runs execute, on `agentRuns`/
`agentSteps`. No new table is needed.

### 23.13 What must stay deterministic

Use a Skill only where AI judgement helps: interpreting unstructured input, selecting relevant
information, choosing among valid alternatives, asking a clarifying question, summarising,
understanding documents, or coordinating existing capabilities. The following stay code, and
never become Skills:

- `WORKFLOWS` / `WorkflowRule` in `workflowEngine.ts`: *"Workflow rules COORDINATE. Domain
  engines DECIDE."* (e.g. `critical_defect`: reported → inspection → … → mechanic_release).
- Every domain decision engine: HOS (`hos.ts`), dispatch readiness and enforcement, route
  approval, DG readiness (`evaluateDangerousGoodsAssist()` explicitly never classifies from free
  text), compliance validity, pricing and billing (`linePricing`, `tripBillingProjection`), tax
  (`gstReturn`, `iftaEngine`), payroll, period close.
- Authorization, automation policy, approval binding, the never-automatic floors.
- Offline class assignment (23.11).
- Skill *selection* itself, for now (23.5).

### 23.14 Classification summary

| Concept | Classification | Evidence |
|---|---|---|
| Tool registry | PARTIAL | `SECRETARY_TOOLS` unwired; `CAPABILITIES` live, unjoined |
| Tool definition | DECLARED_UNWIRED | `ToolDefinition`; no version, no capability link |
| Tool request | PARTIAL | `ToolInvocation` unwired; `ActionRequest` live |
| Tool execution | DECLARED_UNWIRED | `invokeTool()`; no `createCaller` supplier |
| Tool result | PARTIAL | returned, not persisted; `agentActions.outcome` stuck at `requested` |
| Tool receipt | PARTIAL | `authorizationDecisions` per call; commit receipts for commits only |
| Skill definition | PARTIAL | decomposed across `FORMS` × `TaskAllowlist` × `PromptVersion` × validator |
| Skill loader | NOT_NEEDED (now) | typed constants preferred; `loadPrompt()` covers prompt files |
| Skill registry | DECLARED_UNWIRED | two `TaskAllowlist` constants |
| Skill selection | IMPLEMENTED (deterministic) | caller supplies form / task; model never selects |
| Skill versioning | PARTIAL | `formVersion` stored; prompt hash, tool and task versions not |
| Verification | IMPLEMENTED (door 1) / DECLARED_UNWIRED (door 2) | `detectGaps`, read-back, `checkCommit`; `validateExtraction` |
| Progressive loading | IMPLEMENTED (form granularity) | one form + one prompt + one pack per request |
| MCP | MISSING → DEFERRED | nothing in tree |
| External integrations | IMPLEMENTED (not as tools) | `integrationGateway.ts`, `integrationRouter.ts` |
| Sandbox / code execution | NOT_NEEDED | nothing in tree, by design |
| Offline capability | DECLARED_UNWIRED | `offlineCapability.ts`, `requiresOnline` (live in `decide()`) |
| Audit trail | IMPLEMENTED; provenance PARTIAL | `authorizationDecisions`, `agentActions`, receipts; no prompt/model/skill columns |

### 23.15 Genuine missing seams (additions to survey §19 / §20 here)

Only one entry is new. The rest are already in survey §19 and gain a Skills reason.

| Seam | New or existing | Smallest shape |
|---|---|---|
| Tool ↔ capability join | existing (survey §18 item 1) | `ToolDefinition` names its `CapabilityDefinition.key`; the capability supplies risk, `offlineClass`, automation ceiling |
| Tool version | existing (survey §19) | `version` on `ToolDefinition` |
| Run provenance columns | existing (survey §19) | add `taskKey` (the Skill key) beside `promptVersion`/`promptHash` |
| Persisted tool result | existing (survey §19) | advance `agentActions.outcome`, store output hash |
| **Binding contract (the Skill)** | **new, and it is survey §8's `PromptContract`** | one typed object per task: `taskKey`, `version`, form key, `PromptVersion`, `TaskAllowlist`, ceiling, verification checks (existing function refs), escalation target |
| Facility lookup read tool | new, domain gap | only if a `roleProcedure` for facilities is on the spine path; not a Skills concern |

### 23.16 The minimum future Skills subsystem

When the SPINE order reaches it, and not before:

1. **One type**, the survey §8 `PromptContract` renamed `SkillDefinition` or kept as is, which is the
   owner's call. It *references* existing artifacts by typed key and restates none of them:
   `taskKey`, `version`, `formKey`, `promptVersion`, `allowlist: TaskAllowlist`, `ceiling`,
   `verify: (existing validator functions)`, `escalation`.
2. **A constant registry** in the same shape as `SECRETARY_TOOLS`: typed, compiled and
   test-asserted. No runtime file loader.
3. **Registration-time tests** extending `agentTools.test.ts`: every referenced tool key exists;
   no tool in `FORBIDDEN_CATEGORIES`; every tool's procedure resolves through
   `permissionForProcedure()`; the form exists in `FORMS`; the ceiling is no wider than
   `SAFETY_CEILINGS` and never covers a `NEVER_AUTOMATIC` action; `(taskKey, version)` is unique;
   a clarification path exists; offline classes are consistent via `classRiskDisagreements()`;
   **and the type has no field that could name a permission, a procedure, a tenant or a mode.**
   The last property is the structural proof that a Skill grants nothing.
4. **Provenance**: `taskKey` + `version` recorded with the run-provenance columns.

**How this meets the agent roster.** `SECRETARY_AGENT_ROSTER.md` §5 proposes an
`AgentDeclaration` whose `tasks` field lists `TaskAllowlist["taskKey"]` values. A Skill is keyed
by the same `taskKey`, so the two fit with no new key space: an agent *declares which Skills it
may run*, and each Skill *binds the tools, form, prompt and verification for that task*. Neither
carries permissions. Effective authority stays *delegating user's permissions ∩ agent
capabilities ∩ the Skill's task tools ∩ policy*, and holding a Skill never widens it.

Nothing else is needed: no Skill agent, no Skill orchestrator, no MCP, no sandbox.

### 23.17 Relationship diagram

```text
                        USER GOAL
                            │
                            ▼
                  AGENT RUNTIME  (agentRouter.ts + actionGateway.ts)
                            │
          Select applicable SKILL — by entry point / form key, not by the model
          ┊  SKILL SELECTION GRANTS NO AUTHORITY  ┊
                            │
                            ▼
                    PROCEDURAL PLAN  (form + prompt + TaskAllowlist)
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
      read.tripStops   read.loads   propose.disposalTicket      (tool KEYS)
               │            │            │
               ▼            ▼            ▼
         roleProcedure roleProcedure roleProcedure  ← actor permission, acting scope,
         (+ decide())  (+ decide())  (+ decide())     automation policy, budget
               │            │            │
               └────────────┼────────────┘
                            ▼
                         RESULTS
                            │
                            ▼
                 VERIFY  (validateExtraction / detectGaps / checkCommit)
                            │
                   ┌────────┼────────┐
                   ▼        ▼        ▼
                COMPLETE  CLARIFY  REFUSE
          (commit+receipt) (assistantQuestions) (deny / ToolNotAllowed)
```

Conceptual hierarchy. This is not an implementation instruction, and each leaf is named with
its existing home:

```text
LeaseOS AI Runtime
├── Agent runtime ........ agentRuns / agentSteps / agentActions; budgets (survey §11);
│                          context (ContextPack, admitSource); evaluation (golden set)
├── Skills ............... FORMS × TaskAllowlist × PromptVersion × validator  (unbound — 23.4)
├── Tools ................ SECRETARY_TOOLS: read / propose / human_step
│                          (no communication or controlled-action category — FORBIDDEN_CATEGORIES)
├── Integration layer .... existing roleProcedures; integrationGateway; (no MCP)
└── Authority ............ TrpcContext · resolveActingScope · roleProcedure/authorize ·
                           automationPolicy + NEVER_AUTOMATIC/NEVER_AUTONOMOUS · agentApprovals
```

### 23.18 Effect on the SPINE order

**None.** Skills slot into the §18 / §22 sequence after the step-budget and executor work, and
before advanced retrieval:

```text
BoundaryConfirmation → remaining SPINE wiring → remove assistant.draft synchronous model call
  → register durable AI job → save tool results / evidence refs (P9.3, P9.10)
  → tool version + tool↔capability join (P9.3, P9.8) → enforce step budget (P9.5)
  → database-backed idempotency (P9.11) → cancellation (P9.13) → multi-step agent executor
  → Skills (23.16 — the bound contract)
  → advanced RAG / context management → only then reconsider multi-agent
```

The discovery *confirms* the order rather than changing it. Skills sit above tool execution
because a Skill is only as real as the tools it references, and every one of those tools is
still unwired. The one cross-link worth recording is that the offline half of a Skill depends on
the `offlineCapability` → HS1 seam, which is already part of the remaining SPINE wiring. No new
Tools, no Skills runtime, no MCP and no sandbox were added.
