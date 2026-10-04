# First production agent loop: inventory and the smallest delta

**Documentation only.** This changes no code, and it does not start the post-SPINE AI work. It answers
one question before that work starts: which existing modules already cover each part of the first
production agent loop, and what is the least new code that joins them. Checked against `6f52b57`
(`main`, SPINE item 1 resolver merged). Where this document and
`docs/register/AI_RUNTIME_TERMINOLOGY.md` overlap, the survey has the detail and this document has the
verdict.

## Where the SPINE stands (it still comes first)

| Step | State |
|---|---|
| SPINE 1: BoundaryConfirmation resolver + chain rule | **merged** (#10, `6f52b57`) |
| SPINE 1: receipt reader + 0179 trip-stop provenance (clears the 0169 release blocker) | **merged** ([dylanmark218-dot/leaseos-2#17](https://github.com/dylanmark218-dot/leaseos-2/pull/17), `d307ba4`) |
| SPINE 2: resolve the four duplications (`dispatchMatching`, `openShifts`, `complianceDocumentValidity`, `fieldTicket`) | **COMPLETE**: #52, #60, #89 (`3f2bcec`; main green at `c3f088b`, run 36912636248). Record: `docs/register/SPINE_ITEM2_DUPLICATIONS.md` |
| SPINE 3: `offlineCapability` → HS1 | **COMPLETE**: #143 (`6ecf2d49`; main green at `1f24b16b`, run 37162795053). HS1 hardware seam, one offline policy (`mayRunWithoutServer`), availability composition, gated device outbox. Contract wired; production device runtime not activated. Record: `docs/register/SPINE_ITEM3_OFFLINE_HS1.md` |
| SPINE 4: the rest of the spine, in path order | not started |
| Secretary model layer ("door 2") | **held off `main`**: [dylanmark218-dot/leaseos-2#7](https://github.com/dylanmark218-dot/leaseos-2/pull/7), declared unwired |

Nothing below changes that order. None of the AI work below may start until the SPINE is wired.

## Status vocabulary

**IMPLEMENTED**: reached from a mounted `roleProcedure` or the production worker, on `main`.
**PARTIAL**: some of it is reached, and a named piece is missing.
**DECLARED_UNWIRED**: code and tests exist, and no production caller does. "(#7)" means the code is on
the held Secretary branch, not on `main`.
**MISSING**: no code.

## Inventory

| Concern | Existing modules | Status | What is missing for the loop |
|---|---|---|---|
| **Inference provider** | Door 1: `invokeLLM()`, `server/_core/llm.ts`. It is live, has one caller (`assistant.draft`, `server/routers.ts:690`, inside a request handler), and fails open on host. Door 2: `LlmProvider`, `OpenAiCompatibleProvider`, `MockLlmProvider`, `server/_core/ai/llm/*` (#7). These fail closed. | **PARTIAL** | Door 2 on `main`. Door 1 retired from the request handler. P9.1 fail-closed hardening. |
| **Model routing** | `route()` / `routeOrThrow()` / `verifierFor()`, `server/_core/modelGateway.ts`, licence-gated | **DECLARED_UNWIRED** | A registered provider. For the first slice, `LLM_BASE_URL`/`LLM_MODEL` via `fromEnv()` is enough, so routing can stay unwired. |
| **AgentJob / run** | `agentRuns` + `agent.start` / `get` / `awaitEvent`, state set only by `TRANSITIONS` (`server/agentRouter.ts`) | **PARTIAL** | An executor. Today a run records and performs nothing, by design. |
| **Agent steps** | `agentSteps` (planned → running → completed/blocked/failed). A plan may only name registered capabilities. | **PARTIAL** | No code advances a step past `planned`. `startedAt`/`completedAt` are never set. |
| **Tool registry** | Gateway view: `CAPABILITIES` (`agentRouter.ts`) + `buildRegistry()` (`actionGateway.ts`). This is live data, and none of it executes. Model view: `SECRETARY_TOOLS`, `resolveTool()`, `TaskAllowlist` in `server/_core/ai/tools/registry.ts` (#7). | **PARTIAL** | The two registries are not joined: a tool should declare which capability it exercises (P9.8). `ToolDefinition` has no `version`. |
| **Tool invocation** | `invokeTool({ ctx, state, invocation, createCaller })`, `planToolCall()` in `server/_core/ai/tools/caller.ts` (#7). `FORBIDDEN` from `roleProcedure` propagates. | **DECLARED_UNWIRED** | A composition root that supplies the driver-scoped `createCaller(ctx)` (P9.4). A persisted result (P9.3). |
| **Budgets** | `TaskAllowlist.stepBudget` + `spendStep()` and `MAX_CLARIFY_ROUNDS = 3` (#7). `agentRuns.maxSteps`/`stepsUsed` exist and nothing reads them. The outbox has `maxAttempts = 5`, and door 2 has a 60 s timeout. | **PARTIAL** | A model-call cap (`maxModelCalls`) and a token cap are **MISSING**. The run-level step cap is never enforced (P9.5). |
| **Context builder** | Knowledge: `admitSource()` (`contextAdmission.ts`), which is IMPLEMENTED. Assembly: `assembleContext()` (`contextAssembly.ts`, with the cross-tenant refusal), which has no production caller. Operational: `buildContextPack()` / `renderContextPack()` (`server/_core/ai/context/contextPack.ts`, #7), which is pure and imports nothing. | **PARTIAL** | Nothing reads records into a `ContextPack`. Read tools through `invokeTool` are the intended reader, so this needs no new reader module. |
| **Document retrieval** | `assistantAsk.ask`: tenant-scoped full-text `retrieve()` → `admitSource()` per passage → ranking → citations → `assistantQueries`. Measured by `retrievalMeasurements`. | **IMPLEMENTED** | Nothing for the first slice. No vector store (survey §7: deferred until `vocabularyGaps` proves a need). |
| **Claim verification** | `verifyClaim()` / `verifyAnswer()` (`evidenceGrounding.ts`) on the retrieval path. Field-level `quoteIsInTranscript()` / `validateExtraction()` (`server/_core/ai/validate/*`, #7). `detectOverreach()` is live. | **IMPLEMENTED** (retrieval) / **DECLARED_UNWIRED** (extraction) | For the first slice, only the extraction validator matters, and it arrives with #7. |
| **Automation policy** | `resolveAutomation()` / `resolveFromStore()`, `automationPolicies` (append-only), `automationPolicyRouter.ts`, `NEVER_AUTOMATIC`. Proposal ceiling `HYBRID` (#7). | **IMPLEMENTED** | `SAFETY_CEILINGS = {}` until the owner makes the P8.4 decision. Six capabilities can be capped now. TDG and permit validity have no key. |
| **Approval gateway** | `decide()` / `NEVER_AUTONOMOUS` / `approvalCovers()` (`actionGateway.ts`) → `agentActions`. `agentApprovals` is bound to `payloadHash`. The proposal path runs `assistant.answer` → `readBack` → `acknowledge` → `commit`. | **IMPLEMENTED** | Nothing. The first slice reuses the proposal path unchanged. |
| **Audit receipts** | `authorizationDecisions` (every `roleProcedure` call), `assistantCommitReceipts` via `executeAssistantCommit()` (adapters: `trip_stop`, `disposal_ticket`, …), `agentActions` (refusals are rows too), `domainEventOutbox`. | **IMPLEMENTED** | No `RunProvenance` columns on `assistantProposals` (provider, model, prompt version/hash, input hash; P9.2). No inference telemetry (P9.6). No receipt for a read-only tool call. |
| **Worker / outbox** | `domainEventOutbox` + `drainWorker.ts` + `startProductionWorker()`. It registers **one** handler (`enforcementEvent`). `runSecretaryExtractionJob()`, event `secretary.narration.captured` (#7). `workerBoundary.test.ts` asserts the event is not dispatched. | **PARTIAL** | The Secretary handler registration. An enqueue point that replaces the inline model call in `assistant.draft`. |
| **Clarification states** | `assistantQuestions` (reason + status enums), `Gap` / `detectGaps()` / `minimumQuestions()` (`aiProposal.ts`), `assistantProposals.commitState = awaiting_answers`. `DialoguePhase` / `advance()` / `questionFor()` (#7). | **PARTIAL** | `persistQuestions()` (`server/questionQueueService.ts`) has no production caller. `DialogueState` is not persisted. |

**Reading the table.** No row is empty. Two rows (model routing and tool invocation) are entirely
unwired. The rest are live foundations with one missing join each. The work is wiring, not building
engines.

## The smallest delta that makes one loop run

The loop is: authenticated capture → durable job → authorized context → inference → structured output
→ clarification or proposal → existing authorization → human read-back → existing commit → receipt.

### Preconditions (decisions and merges, not code)

1. The SPINE is wired (the moratorium).
2. #7 merged, which puts door 2 on `main` as declared-unwired code.
3. The owner's carve-out ruling on retiring `invokeLLM` from `assistant.draft`. The target is zero
   model calls in request handlers.
4. A configured provider (`LLM_BASE_URL`, `LLM_MODEL`). P9.1 lands first, so an unconfigured
   deployment refuses instead of reaching a default host.

### New code: one module, one migration, three small extensions

| # | Change | Kind | Why it cannot be reused from something existing |
|---|---|---|---|
| 1 | **`server/_core/ai/worker/secretaryHandler.ts`**, the composition root. It claims `secretary.narration.captured`, rebuilds the delegating driver's `TrpcContext` from the event (`delegatedByUserId`, acting scope re-resolved server-side, never read from the payload), supplies `createCaller(ctx)` to `invokeTool`, calls the read tools to fill a `ContextPack`, runs `runSecretaryExtractionJob()` with `OpenAiCompatibleProvider.fromEnv()`, writes the proposal through the existing `createAssistantProposal` path, persists questions through `persistQuestions()`, and advances the `agentRuns`/`agentSteps`/`agentActions` rows. It is registered in `productionWorker.ts` beside the enforcement handler. | **new module** (the only one) | Nothing today supplies `createCaller` or dispatches the event. Survey §4: this is a handler, not an orchestrator. |
| 2 | **Migration**: five nullable `RunProvenance` columns plus `usage` on `assistantProposals`, and an output hash on `agentActions`, so `outcome` can move past `requested`. | schema | P9.2, P9.3 and P9.6 in one additive migration. It takes the next free number from `MIGRATION_COLLISION_REGISTER.md`. |
| 3 | **`assistant.draft` becomes an enqueue**. It validates, creates the `agentRuns` row, and writes the outbox event in the same transaction, instead of calling `invokeLLM` inline. `workerBoundary.test.ts` moves from "exactly one" to "zero". | edit to an existing procedure | Removes the one known worker-boundary violation. |
| 4 | **`ToolDefinition` gains `capability` and `version`**. `resolveTool()` checks the capability through `decide()`. | field | Joins the two registries without merging them (P9.8). |
| 5 | **`TaskAllowlist` gains `maxModelCalls`**. `requestAction` increments `agentRuns.stepsUsed` and refuses at `maxSteps`. | field + existing procedure | The only budgets that are MISSING (P9.5). |

Everything else is reused as is: authorization, acting scope, `contextAdmission`, retrieval, the
extraction validator, the gateway, automation policy, read-back, `executeAssistantCommit()`, receipts
and the outbox.

### The first slice: disposal/unload ticket, typed transcript

"Ticket 77492. Clean Harbors. Eighteen cubes. Arrived 14:10, unloaded at 14:35."

- The **form exists**: `FORMS.unload_stop` (`aiProposal.ts:113`). The **commit adapters exist**:
  `trip_stop` and `disposal_ticket` in `assistantCommitService.ts`.
- **Text, not voice.** `voiceTranscription` has no device path and stays off the slice.
- In this slice **the model never emits a tool request.** The server's fixed `DialoguePhase` sequence
  calls the read tools (current trip, stop, load, facility) and the one propose step. The model only
  extracts fields, marks them `stated | inferred | missing | ambiguous`, and quotes its evidence. A
  model-chosen tool (`tool_request` in the proposed `AssistantDecision` union) waits for the second
  slice. The four outcomes that union names already exist as `ExtractionOutcome` + `ValidationResult`
  + `CommitState` (survey §12), so **no new decision type is added**.
- A missing or `ambiguous` field produces **one** question (`needsClarification` ordered by
  `stakesOf()`, persisted to `assistantQuestions`). Everything after the driver's read-back
  acknowledgment is the existing commit path, which writes an `assistantCommitReceipts` row that
  SPINE item 1's resolver already reads as boundary evidence.

## Not built, restated

No multi-agent split, no generic agent memory, no vector database, no MCP layer, no second permission
system, no `/ai-v2` directory, no orchestrator module. Each concern above already has a home. A new
subsystem beside it would be a second answer to a question the codebase already answers once.
