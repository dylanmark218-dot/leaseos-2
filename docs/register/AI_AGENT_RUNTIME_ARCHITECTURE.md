# LeaseOS AI — the agentic runtime, mapped onto what exists

**Documentation only. No production code changes.** This is the agent-runtime layer of
`docs/register/AI_RUNTIME_TERMINOLOGY.md` (the terminology survey). That document maps the
vocabulary; this one maps the *runtime design* — loop, plan, evaluator, budgets, HITL, retrieval,
context, memory, workers, idempotency, durability, observability, cancellation, failures — onto
this repository, so the eventual runtime is built from parts that exist rather than beside them.

**Surveyed against:** `6f52b57` (`claude/compassionate-mendel-8sa4vg`: `main` + SPINE item 1's
resolver and chain rule). **PR #7 (the Secretary model layer, `server/_core/ai/`) is still open
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
  │                                              (routers.ts:690); door 2 unwired (PR #7)
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
BoundaryConfirmation            ← in progress (resolver + chain rule landed; reader waits on 0169 → PR #17)
      ↓
remaining SPINE wiring          ← four duplications → offlineCapability → dispatch gate … job close
      ↓
remove synchronous request-handler LLM call (routers.ts:690, owner's carve-out ruling)
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

**F1 — the synchronous LLM pin is not on this branch.** `server/routers.ts:690` calls
`invokeLLM()` inside `fieldRoute.assistant.draft`. The test that pins that at exactly one call
(`server/_core/ai/workerBoundary.test.ts`) and the moratorium document it cites
(`docs/register/SECRETARY_SPINE_MORATORIUM.md`) arrive with PR #7, which is open. Until #7 lands,
nothing on `main`-line branches stops a second in-request model call. Not fixed here (the pin is
PR #7's to carry); recorded.

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
prerequisite for cancellation. Recorded as P9.12.

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
    d. unique index on `agentActions.idempotencyKey` (P9.11) and a terminal-run guard + `agent.cancel`
       procedure that writes an audit row (P9.12);
    e. provenance + inference telemetry columns (P9.2, P9.6);
    f. join tool → capability (P9.8); persist `evidenceRefs` (P9.10);
    g. only then, a bounded multi-step executor over `agentSteps`.
13. **Does anything change the SPINE sequence?** No. F1 argues for landing PR #7 (declared
    unwired) before any further in-request AI work, which is already the moratorium's intent.
    F2 and F3 are agent-runtime defects that nothing executes on; they belong at step (d), after
    the SPINE.
