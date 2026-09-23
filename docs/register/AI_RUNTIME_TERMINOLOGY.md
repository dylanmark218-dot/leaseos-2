# LeaseOS AI runtime — canonical terminology and implementation map

**Documentation only.** This checkpoint changes no production code. It was written under the SPINE
moratorium (`docs/register/SECRETARY_SPINE_MORATORIUM.md`) and does not expand the
BoundaryConfirmation checkpoint, which has not started on this branch: `BoundaryConfirmation`
still appears only in `server/_core/siteBaseline.ts`, which defines and consumes it, and no
resolver supplies it.

**Authority rule.** Where an industry term and a repository name disagree, the repository name is
canonical. Every module, type, function, table and column named below exists in the tree at the
commit this document was written against: `929f721`, the head of PR #7
(`claude/secretary-model-dialogue-yzszcv`), which is `main` plus the declared-unwired Secretary
model layer. On `main` itself `server/_core/ai/` does not exist until PR #7 merges; everything
this document says about that directory describes PR #7, and its status column says "declared /
unwired" for all of it. Nothing below is aspirational unless its status column says so.

**Why the document lives here.** The repository has no `docs/architecture/`. The two existing
AI-layer register documents (`SECRETARY_MODEL_LAYER.md`, `SECRETARY_SPINE_MORATORIUM.md`) live in
`docs/register/`, so this one does too.

---

## 0. Status vocabulary

| Status | Meaning |
|---|---|
| **implemented** | Reached from a mounted router or the production worker and exercised in production paths. |
| **declared / unwired** | Code and tests exist; `server/engineReachability.test.ts` lists the module in `DECLARED_UNWIRED`, or no production caller was found. |
| **partial** | Some of the concept exists and is reached; a named piece is missing. |
| **deferred** | Not built, and this document recommends not building it until a named condition holds. |
| **intentionally unsupported** | LeaseOS declines to build it on principle. |

"Mounted" means a `roleProcedure` in `server/routers.ts` or a router it imports. "Wired to the
worker" means `server/_core/productionWorker.ts` registers a handler for it; today it registers
exactly one, for `aggregateType === "enforcementEvent"`.

---

## 1. The runtime, as it stands

Every box is annotated. **[live]** is reached in production today. **[unwired]** exists as code and
tests only. **[missing]** does not exist. Arrows between a live box and an unwired box are not
connected in code.

```
                          LEASEOS AI RUNTIME  (surveyed 2026-09-23)

User / Driver
     │
     ▼
Authenticated tRPC boundary                       [live]   roleProcedure()  server/_core/trpc.ts
     │                                                     → authorizationDecisions row per call
     ▼
Acting scope + authorization                      [live]   resolveActingScope()  server/_core/actingScope.ts
     │                                                     permissionForProcedure()  server/_core/recordsAuthorization.ts
     ▼
Durable agent job                                 [live, no executor]
     │                                                     agent.start / requestAction / decideApproval / awaitEvent / get
     │                                                     server/agentRouter.ts → agentRuns, agentSteps, agentActions, agentApprovals
     │                                                     (records decisions; performs nothing)
     ▼
Authorized context retrieval
     ├─ knowledge passages                        [live]   assistantAsk.ask  server/assistantAskRouter.ts
     │                                                     admitSource()  server/_core/contextAdmission.ts
     │                                                     verifyClaim()  server/_core/evidenceGrounding.ts   (no model on this path)
     └─ operational context pack                  [unwired] buildContextPack()  server/_core/ai/context/contextPack.ts
     │
     ▼
Inference / LLM boundary
     ├─ door 1: invokeLLM()                       [live]   server/_core/llm.ts  — hard-coded vendor default host
     │          called from fieldRoute.assistant.draft  (server/routers.ts:691, inside a request handler; pinned)
     └─ door 2: LlmProvider                       [unwired] server/_core/ai/llm/provider.ts — no default endpoint, fails closed
                modelGateway.route()             [unwired] server/_core/modelGateway.ts — licence-gated provider selection
     │
     ▼
Structured model output
     ├─ door 1: buildOutputSchema/parseExtraction [live]   server/_core/assistantExtraction.ts
     └─ door 2: ExtractionEnvelope + validator    [unwired] server/_core/ai/extraction/*, server/_core/ai/validate/*
     │
     ▼
Agent controller  (coordination, not a model)
     ├─ per-narration dialogue                    [unwired] advance()  server/_core/ai/dialogue/machine.ts
     ├─ per-action decision                       [live]   decide()  server/_core/actionGateway.ts
     └─ run state transitions                     [live]   TRANSITIONS  server/agentRouter.ts
     │
     ├──────────────► Clarification               [live]   assistantQuestions table; Proposal.gaps/questions (aiProposal.ts)
     │                                            [unwired] ValidationResult.needsClarification; questionFor()
     ├──────────────► Refusal                     [live]   Decision "deny" / "compliance_block"; classifyRequest()
     │                                            [unwired] ExtractionOutcome "refused"; DialoguePhase "REFUSED"
     └──────────────► Tool request
                          │
                          ▼
                  Server tool registry            [unwired] SECRETARY_TOOLS, resolveTool()  server/_core/ai/tools/registry.ts
                          │                                 (typed ProcedureName; the model never names a procedure)
                          ▼
                  Driver-scoped tRPC caller       [unwired] invokeTool({ createCaller })  server/_core/ai/tools/caller.ts
                          │                                 (createCaller is injected; no composition root supplies it yet)
                          ▼
                  Domain procedure                [live]   e.g. tripStops.list, assistant.draft, agent.requestAction
                          │
                          ▼
                  Proposal / receipt              [live]   assistantProposals + proposalFields  (proposal)
                                                  [live]   executeAssistantCommit() → assistantCommitReceipts  (receipt)
                                                  [live]   domainEventOutbox  (event receipt; actorSource includes "ai")

Worker boundary                                   [unwired] runSecretaryExtractionJob()  server/_core/ai/worker/secretaryExtractionJob.ts
                                                            event "secretary.narration.captured" — productionWorker.ts does not dispatch it
                                                            (asserted by server/_core/ai/workerBoundary.test.ts)
```

What the diagram must not be read as: there is **no path today** on which a model output reaches a
tool call, and no path on which an `agentRuns` row causes anything to execute. The live model call
(`assistant.draft`) produces a proposal and stops. The live agent runtime records decisions and
stops. The live retrieval path quotes passages and stops. Those three are separate and none of them
is joined to the unwired Secretary model layer.

---

## 2. Canonical vocabulary

Columns: canonical LeaseOS term · common industry synonym · definition · implementation ·
authority boundary · persistence · status.

### 2.1 Inference and the model boundary

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Inference request** | model call, completion, LLM invocation | One request to one model, with messages and a required JSON Schema. | `LlmRequest` in `server/_core/ai/llm/provider.ts`; `InvokeParams` in `server/_core/llm.ts` | Server builds it. The model never sees a procedure name, SQL, a tenant id or a permission. | Not persisted as a row. `RunProvenance` (§2.2) fingerprints it. | door 1 **implemented**; door 2 **declared / unwired** |
| **Model response** | completion, generation | Raw text back from a provider, untrusted until parsed and validated. | `LlmResponse { text, modelId, usage? }`; `InvokeResult` in `llm.ts` | None. It is data. | Not persisted raw. Parsed fields land on `proposalFields`; `notes` prose lands on `assistantProposals.notes`. | as above |
| **Inference interface** | provider abstraction, LLM client | The one interface application code calls. | `LlmProvider { providerKey, modelId, complete() }` | Nothing above it names a vendor. | — | **declared / unwired** |
| **Provider adapter** | driver, connector | A concrete `LlmProvider`. | `OpenAiCompatibleProvider` (llama.cpp / Ollama / vLLM shape), `MockLlmProvider` (CI only) | `fromEnv()` throws `LlmNotConfigured` when `LLM_BASE_URL` or `LLM_MODEL` is unset. Fail closed. | — | **declared / unwired** |
| **Legacy model door** | — | The pre-existing chat-completions client. | `invokeLLM()` in `server/_core/llm.ts` | Defaults to `https://forge.manus.im/v1/chat/completions` when `BUILT_IN_FORGE_API_URL` is empty; key from `BUILT_IN_FORGE_API_KEY`. **Fails open on host**: only the key is asserted. | — | **implemented** (one call site, pinned at 1 by `workerBoundary.test.ts`) |
| **Provider selection** | model routing, model/provider selection | Choosing which provider serves a task, refusing on licence or offline constraints. | `route()`, `routeOrThrow()`, `refusalFor()`, `verifierFor()` in `server/_core/modelGateway.ts`; `ModelTask` = reason, code, fast_chat, verify, transcribe, speak, embed, extract | Licence class checked before anything else; `unstated` is refused. Same-model verification refused (`SameModelVerification`). | `ModelAttribution` type exists; no table stores it. | **declared / unwired** ("no AI provider is configured yet") |
| **Model configuration** | — | Where the model lives. | `llmConfig()`, `llmConfigured()` in `server/_core/ai/llm/config.ts`: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, read at call time | Environment only. No default. | — | **declared / unwired** |
| **Speech transcription** | STT, ASR | Audio to text. | `transcribeAudio()` in `server/_core/voiceTranscription.ts` (vendor endpoint via `ENV.forgeApiUrl`); `SttConfidence.minForSpan()` in `validator.ts` is the seam a local transcriber plugs into | — | — | **declared / unwired** ("no device path"); `SttConfidence` seam **unwired** |
| **Image generation** | — | Not an AI-runtime concern. | `server/_core/imageGeneration.ts` | — | — | **declared / unwired** ("unused capability") |

### 2.2 Prompts, context and provenance

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Prompt version** | prompt template, system prompt | A versioned instruction file with a content hash. | `PromptVersion = "secretary-extract.v1"`, `loadPrompt()`, `promptHash()`, `CURRENT_EXTRACT_PROMPT` in `server/_core/ai/prompts/index.ts`; file `secretary-extract.v1.md` | Static instructions only; dynamic data is appended separately by `runExtraction()`. | Hash is carried in `RunProvenance`. **No column stores it.** | **declared / unwired** |
| **Inline system prompt** | — | The live prompt, built as a string per call. | `buildSystemPrompt(form, targetRef)` in `server/_core/assistantExtraction.ts` | Mixes form slots (dynamic) with rules (static). | Not versioned, not hashed, not stored. | **implemented** |
| **Prompt construction** | prompt engineering, prompt assembly | Assembling system + context + fenced user data for one request. | `runExtraction()` (door 2); `assistant.draft` mutation body (door 1) | Untrusted text is fenced (`fence()`, `TRANSCRIPT_FENCE`, `DOCUMENT_FENCE`) and labelled as data. | — | door 1 **implemented**; door 2 **declared / unwired** |
| **Run provenance** | trace metadata | What answered, under which prompt, on what input. | `RunProvenance { providerKey, modelId, promptVersion, promptHash, inputHash }`; `inputHash(transcript, renderedContext)` | Reproducibility, not trust. No confidence score by design. | Carried on `SecretaryProposal.run`. **`assistantProposals` has no columns for any of these five fields.** | **partial** — type exists, storage missing |
| **Model Context** | context window, prompt context | Temporary input to one inference request. | The `messages` array of one `LlmRequest` / `InvokeParams` | Transient. **Never authoritative storage.** | None, by rule. | concept **implemented** by construction |
| **Context pack** | grounding context, retrieval context (operational) | The projected operational facts a model may cite by id. | `ContextPack`, `ContextItem { id, kind, label, value }`, `ContextItemKind`, `buildContextPack()`, `renderContextPack()`, `contextRefs()` in `server/_core/ai/context/contextPack.ts` | Pure module with **no imports**; `contextPerimeter.test.ts` proves it cannot reach the restricted vault or medical tables. `EligibilityAnswer` is yes/no/unknown with nowhere to put a reason. | Reconstructable from `inputHash`; not stored. | **declared / unwired** |
| **Admitted context block** | context block, grounding chunk | A unit of model-readable text that a named resolver proved the caller may read. | `AdmittedContextBlock` (unique-symbol branded), `admitSource()`, `ContextResolver`, `TenantProof`, `project()` in `server/_core/contextAdmission.ts` | No generic `admit()` exists; kind and tenant come from the resolver. `legacy_single_tenant` proof is refusable. | Not persisted. | **implemented** (used by `assistantAsk.ask`) |
| **Context assembly** | prompt assembly, context stuffing | Assembling admitted blocks for one tenant, refusing a mixed-tenant context. | `assembleContext()`, `BlockKind`, `renderContext()`, `CrossTenantContext`, `detectForbiddenEcho()` in `server/_core/contextAssembly.ts` | `BlockKind` maps to `InstructionAuthority`; `retrieved_document` and `external_message` are `external_content` and may never instruct. | — | **partial** — not in `DECLARED_UNWIRED` because `contextAdmission.ts` imports its `BlockKind` type, but `assembleContext()` has no production caller |
| **Conversation State** | chat history, session memory | Persisted user/assistant interaction state for one capture. | `DialogueState { phase, round, askingKey, utterance, correctedKeys, unresolvedKeys }` in `server/_core/ai/dialogue/machine.ts`; `assistantQuestions` rows; `assistantProposals.readBack / readBackAcknowledged` | State is server-owned; the model does not set it. | `DialogueState` is not persisted. Questions and read-back are. | **partial** |
| **LeaseOS Records** | source of truth, system of record | Authoritative operational records. | Every domain table; for AI: `assistantProposals`, `proposalFields`, `assistantCommitReceipts`, `tripStops`, etc. | Written only through `roleProcedure` domain procedures and typed commit adapters. | Durable. | **implemented** |
| **Audit History** | audit log, audit trail | Immutable evidence of actions and results. | `authorizationDecisions`, `assistantCommitReceipts`, `agentActions`, `assistantQueries`, `domainEventOutbox`, `automationPolicies` (append-only with supersession) | Append-only by convention; `agentActions` records refusals as rows. | Durable. | **implemented** |

### 2.3 Structured output, validation and clarification

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Output schema** | structured output, JSON mode, constrained decoding | The JSON Schema a model must satisfy. | door 1: `buildOutputSchema(form)` → `response_format json_schema`; door 2: `buildFormJsonSchema(form)` derived `FORMS → zod → JSON Schema`, `strict: true` | Derived from `FORMS` only; a model cannot describe a field the form lacks. | — | door 1 **implemented**; door 2 **declared / unwired** |
| **Extraction envelope** | tool-call arguments, structured response | The whole parsed model response for one form. | door 2: `ExtractionEnvelope { fields, notes, outOfScope, injectionSuspected }`, `parseExtractionEnvelope()`; door 1: `parseExtraction()` → `ParsedExtraction { values, notes, overreach }` | Undeclared keys are dropped, never stored. | — | as above |
| **Extracted field** | slot, entity | One field with its evidence. | door 2: `ExtractedField { value, status: stated|inferred|missing|ambiguous, evidenceQuote, evidenceRef, alternatives }`; door 1: `RawSlot { value, sourceUtterance, speakerHedged, confidence }` | Wire shape only; both map onto `ProposedField`. | Via `proposal/bridge.ts` → `proposalFields`. | as above |
| **Verdict** | validation result, guardrail outcome | The deterministic judgement on one field. | `Verdict = BLOCKED | UNKNOWN | NOT_EVALUATED | REVIEW | PASS` (`normalizers.ts`); `FieldVerdict`, `ValidationResult`, `validateExtraction()`, `worst()` in `validator.ts` | No model runs here. A missing term is `NOT_EVALUATED` and never conjoins to `PASS`. | `verdicts` on `SecretaryProposal`; **no table column**. | **declared / unwired** |
| **Evidence quote check** | hallucination detection, grounding check | A `stated` field's quote must be a verbatim substring of the transcript. | `quoteIsInTranscript()`; reason code `quote_not_in_transcript`; `silentGuessKeys` | Whitespace collapse only; no fuzzy match. | — | **declared / unwired** |
| **Overreach check** | output guardrail | Prose asserting safety/legal/diagnostic conclusions is flagged. | `detectOverreach()` in `aiProposal.ts`; `assistantProposals.overreachFlags` | Flagged and surfaced, not silently dropped. | `overreachFlags` column. | **implemented** |
| **Injection scan** | prompt-injection detection | Independent tripwire over untrusted text, combined pessimistically with the model's own flag. | `scanForInjection()`, `combineInjectionSignals()`, `InjectionScan` in `server/_core/ai/injection/guard.ts`; `instructionLikeSpans()` in `contextAssembly.ts` | A tripwire, not a filter. The structural defence is the absent commit/outbound tool category. | On `SecretaryProposal.injection`; **no column**. | **declared / unwired** |
| **Gap** | missing slot | A required, imprecise or low-confidence field on a live proposal. | `Gap { kind: missing_required | precision_unresolved | low_confidence }`, `detectGaps()`, `minimumQuestions()` (max 3) in `aiProposal.ts` | Derived from persisted fields on every rehydrate (`rehydrateProposal()`). | Derived, not stored. | **implemented** |
| **Clarification question** | follow-up, disambiguation | A question a person must answer before a field can be relied on. | live: `assistantQuestions` (reason enum: missing_required, low_confidence, precision_unresolved, sensitive_human_only, ambiguous_classification; status pending/answered/skipped/superseded), `persistQuestions()` in `server/questionQueueService.ts`; unwired: `questionFor()`, `readBack()` in `validate/questions.ts`, `needsClarification` ordering by `stakesOf()` | Templates are written by people and chosen by code; the model does not phrase questions on door 2. | `assistantQuestions` rows. | table **implemented**; `persistQuestions()` has **no production caller**; door-2 templates **unwired** |
| **Dialogue phase** | agent loop state | Where one narration is in LISTEN → … → PROPOSE. | `DialoguePhase`, `advance()`, `isTerminal()`, `MAX_CLARIFY_ROUNDS = 3` | Pure state machine; no clock, model or DB. | Not persisted. | **declared / unwired** |
| **Read-back** | confirmation prompt | The sentence said back before commit. | `generateReadBack()`, `acknowledgeReadBack()`; procedures `assistant.readBack`, `assistant.acknowledge` | Any field change invalidates it (`refresh()`). | `assistantProposals.readBack`, `readBackAcknowledged`. | **implemented** |

### 2.4 Agent job, tools and execution

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Agent run** | agent job, task, episode | Durable work that outlives a conversation; possibly many inference/tool/evaluation steps. | `agentRuns` (`runRef`, `goal`, `status`, `stepsUsed`, `maxSteps`, `awaitingEvent`, `blockedReason`); `agent.start` | Status is set only by `TRANSITIONS` in `server/agentRouter.ts`; the model never writes it. | Durable. | **implemented**, **no executor** ("deliberately absent: any capability that executes") |
| **Agent step** | plan step | One planned capability in a run. | `agentSteps` (`stepNumber`, `capability`, `status: planned/running/completed/blocked/skipped/failed`) | A plan may only name registered capabilities (`REGISTRY.has`). | Durable. | **implemented**, never advanced past `planned` by any code |
| **Action request** | tool call request | An agent asking to do one thing. | `ActionRequest` in `server/_core/actionGateway.ts`; `agent.requestAction` | `origin` is forced to `authorized_user`; `actor.type` is forced to `agent`; `compliance` is `null` (unknown, which blocks). | `agentActions` row for every decision, refusals included. | **implemented** |
| **Gateway decision** | policy check, authorization decision (agent-level) | allow / deny / require_approval / compliance_block / stale. | `decide()`, `Decision`, `NEVER_AUTONOMOUS`, `MAY_INSTRUCT`, `approvalCovers()` | Strictest first; unregistered capability is denied; unknown compliance is a block. | `agentActions.decision`, `decisionReasons`. | **implemented** |
| **Capability** | tool (gateway view), action type | A risk-classified thing an agent may request. | `CapabilityDefinition { key, riskLevel, requiredPermissions, requiresOnline, idempotent }`; `CAPABILITIES` in `agentRouter.ts` (six entries: jobs.read, fleet.readUnit, billing.prepareInvoice, messaging.sendReminder, billing.issueInvoice, compliance.override) | Names **permissions**, not procedures. | — | **implemented** as data; none executes |
| **Tool** | function, tool definition (model view) | A model-facing key bound to exactly one existing procedure. | `ToolDefinition { key, category, procedure: ProcedureName, formKey?, requiresIdempotencyKey }`; `SECRETARY_TOOLS`; `FORBIDDEN_CATEGORIES`; `PROPOSE_TOOLS_NOT_POSSIBLE_YET` in `server/_core/ai/tools/registry.ts` | `procedure` is typed `ProcedureName`, so an invented name does not compile; `agentTools.test.ts` resolves each through `permissionForProcedure()`. Categories: read, propose, human_step only. | — | **declared / unwired** |
| **Tool registry** | function registry, tool catalogue | Server-owned list of tools. | `SECRETARY_TOOLS`, `resolveTool(allowlist, key)`, `ToolNotAllowed` | Unknown and not-allowed keys refuse identically. `NEVER_AUTONOMOUS` re-checked at resolve. | — | **declared / unwired** |
| **Task allowlist** | tool allowlist, tool scope | The tools and step budget for one task. | `TaskAllowlist { taskKey, toolKeys, stepBudget }`; `LOAD_UNLOAD_NARRATION` (8), `BILL_SCAN` (6) | Per task, server constant. | — | **declared / unwired** |
| **Tool invocation** | tool call, function call | One call of a tool as the driver. | `ToolInvocation { toolKey, input, clientCaptureId }`, `planToolCall()`, `invokeTool({ ctx, state, invocation, createCaller })` in `server/_core/ai/tools/caller.ts` | `createCaller` is a required dependency; no `appRouter` import; pinned `formKey` overwrites caller input; `FORBIDDEN` from `roleProcedure` propagates. | `ToolResult` is returned, **not persisted**. | **declared / unwired** |
| **Tool result** | function result, observation | What the procedure returned. | `ToolResult { toolKey, procedure, formKey, idempotencyKey, output, stepsSpent }` | — | **Not persisted.** `agentActions.outcome` (requested/accepted/executed/verified/failed) is the intended home and is never set past `requested`. | **partial** |
| **Driver-scoped caller** | impersonation, on-behalf-of | The agent acts only as the person it works for. | `createCaller(ctx)` with the driver's `TrpcContext`; `agentActions.delegatedByUserId` | No service account exists. | — | **declared / unwired** (caller); **implemented** (delegation column) |
| **Worker boundary** | async job, background execution | Model calls run in the worker behind the outbox, never in a request handler. | `runSecretaryExtractionJob()`, `SECRETARY_EXTRACTION_EVENT = "secretary.narration.captured"`; `startProductionWorker()` in `productionWorker.ts`; `startDrainWorker()` in `drainWorker.ts` | `workerBoundary.test.ts` pins the one pre-existing violation (`assistant.draft`) at exactly one and asserts the worker does not yet dispatch the event. | `domainEventOutbox` (claim lease, `attemptCount`, dead-letter). | job body **declared / unwired**; worker **implemented** for one other event type |
| **Idempotency key** | dedupe key, request id | Makes a replay safe. | `idempotencyKeyFor({ clientCaptureId, toolKey })` (tools); `idempotencyKey(request)` (gateway) = `runId:requestId:capability:targetId`; `assistantCommitReceipts.proposalId` unique | Derived server-side from client capture id; never a fresh id per retry. | `agentActions.idempotencyKey`; commit receipt. | **implemented** (gateway, commit); **unwired** (tools) |
| **Retry policy** | backoff, retry budget | Which failures retry, how often. | `shouldRetry(kind)` and `FailureKind` in `actionGateway.ts`; `DEFAULT_WORKER_CONFIG.maxAttempts = 5` and `backoffMs()` in `drainWorker.ts`; `fetchWithBackoff` (4 retries) in `llm.ts`; `OpenAiCompatibleProvider` deliberately has none | Decided by code, not the model. | `domainEventOutbox.attemptCount`, `retryAvailableAt`, `deadLetteredAt`. | **implemented** (outbox, legacy door); **declared** (gateway policy, unwired) |
| **No-progress stop** | loop detection | Same capability/target/input/output three times stops the run. | `detectNoProgress()` in `actionGateway.ts` | — | — | **declared / unwired** (nothing calls it) |
| **Correlation id** | trace id, job id | Ties events of one operation together. | `domainEventOutbox.correlationId`, `causationId`; `agentRuns.runRef`; `SecretaryExtractionEvent.eventId` + `clientCaptureId` | Server-assigned. | Durable. | **implemented** (outbox); **unwired** (secretary event) |

### 2.5 Authorization, policy and human approval

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Procedure authorization** | RBAC check, permission gate | The per-procedure permission check with an audit row. | `roleProcedure(name: ProcedureName)` → `permissionForProcedure()` → `authorize()` → `recordAuthorizationDecision()` | Unmapped procedure is a wiring-time throw. Sensitive permissions fail closed if the audit write fails. | `authorizationDecisions` (outcome enum: allowed, denied_no_role, denied_permission, denied_scope, denied_unauthenticated). | **implemented** |
| **Acting scope** | tenant context | Which organization the caller acts for, server-derived. | `resolveActingScope()`, `ActingScope.derivedFrom`, `SINGLE_TENANT_ID = "default"`, `AmbiguousOrganization` | Never read from input. | — | **implemented** |
| **Automation mode** | autonomy level, human-in-the-loop setting | AUTO / HYBRID / MANUAL: how a record reaches confirmed. | `AutomationMode`, `resolveAutomation()`, `resolveFromStore()`, `SCOPE_ORDER` (tenant→role→task→customer), `evaluateOperationalOverride()` (only toward MANUAL), `committedProvenance()` in `server/_core/automationPolicy.ts`; `automationPolicyRouter.ts` | Entitled-but-unconfigured is MANUAL. Override may narrow, never widen. | `automationPolicies` (append-only), `capabilityEntitlements`, `PolicySnapshot` shape. | **implemented** |
| **Safety ceiling** | automation ceiling, hard cap | Per-capability maximum mode nobody may exceed. | `SafetyCeiling`, `ceilingFor()`; `SAFETY_CEILINGS = {}` in `automationPolicyStore.ts` (P8.4: list is an owner decision, not yet made) | Clamps and records `clamped: true`. | `automationPolicies.safetyCeilingApplied`. | mechanism **implemented**; list **empty by decision** |
| **Proposal ceiling** | — | The most automatic mode a Secretary proposal may reach. | `SecretaryProposal.ceiling: "HYBRID"` in `proposal/bridge.ts` | The resolver may narrow to MANUAL, never widen. | — | **declared / unwired** |
| **Never-automatic floor** | hard-coded human requirement | Actions no policy may automate. | `NEVER_AUTOMATIC` (`secretaryCoordination.ts`: assign_person, approve_leave, schedule_payment, change_payroll, resolve_compliance); `NEVER_AUTONOMOUS` (`actionGateway.ts`: compliance.override, hos.ignoreViolation, inspection.bypassFailure, maintenance.clearOutOfService, audit.delete, safety.clearViolation) | `validatePolicy()` rejects a policy that names one. `floorDisagreements()` keeps the two lists consistent. | — | **implemented** (both reached) |
| **Risk level** | action tier | L0 read → L4 restricted. | `RiskLevel = read | prepare | low_risk_action | approval_required | restricted`; `PROPOSAL_RISK` maps proposal actions onto it | `restricted` always requires approval; `approval_required` requires a payload-bound approval; `low_risk_action` requires the company's `autoExecute` list (currently `[]` in `agentRouter.ts`). | — | **implemented** |
| **Human approval** | HITL, approval gate | A person decides, bound to the exact payload hash. | `agentApprovals` (`payloadHash`, `decision: pending/approved/rejected`), `agent.decideApproval`; for proposals: `assistant.answer` / `setStatus` / `readBack` / `acknowledge` / `commit` | Requester may not approve a `NEVER_AUTONOMOUS` capability. Approval of a changed payload does not cover it. | Durable. | **implemented** |
| **Instruction authority** | trust level, provenance of instruction | Who may originate an action. | `InstructionAuthority` (system, leaseos_policy, company_policy, authorized_user, workflow_data, external_content); `MAY_INSTRUCT` | `external_content` and `workflow_data` may never instruct. | `agentActions.origin`. | **implemented** |
| **Committed provenance** | — | The provenance every committed record carries, whichever mode produced it. | `REQUIRED_PROVENANCE_FIELDS`, `CommittedProvenance` | Same shape in AUTO, HYBRID and MANUAL. | On the committed row. | **implemented** |

### 2.6 Records, retrieval and knowledge

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Retrieval Context** | RAG context, retrieved documents | Records selected for one AI request, after authorization. | `assistantAsk.ask`: `retrieve()` (tenant-scoped `MATCH … AGAINST … IN NATURAL LANGUAGE MODE` on `knowledgePassages.body`, `quotable()` filter) → `admitSource()` per candidate → `lexicalScore()` → top `MAX_PASSAGES = 8` | Scoped in the query, then admitted per passage with the caller's real permissions (`permissionsFor(roles)`). The model is not on this path. | `assistantQueries` (question, verdict, counts, cited refs). | **implemented** (extractive, no model) |
| **Knowledge passage** | chunk, document chunk | Quotable text with revision, jurisdiction and reproduction basis. | `knowledgePassages`; `assistant.addPassage`, `supersedePassage`, `passageList` | `reproductionBasis` must be `own_document` or `licensed_source`; `unstated` rows are never quoted. Licensed sources pass `checkAssistantPassageUse()`. | Durable. | **implemented** |
| **Knowledge corpus** | document store | Registered sources, quarantined documents, versions, chunks. | `knowledgeSources`, `knowledgeDocuments` (state QUARANTINED → … → PUBLISHED), `knowledgeVersions`, `knowledgeChunks`; `server/_core/knowledge/repository.ts` (registerSource, quarantineDocument, releaseFromQuarantine, writeChunks) | `knowledgeWritePaths.test.ts` asserts `repository.ts` is the only corpus writer. | Durable. | tables **implemented**; repository **declared / unwired** (no caller) |
| **Source licence gate** | ingestion policy | Whether a source may be linked, indexed, quoted, used commercially or trained on. | `checkSourceGate()`, `checkAssistantPassageUse()`, `authorizeCommercialUse()`, `AB_511` in `sourceGate.ts`; columns `ragIngestionAuthorized`, `modelTrainingAuthorized`, `commercialReuseAuthorized` | Unassessed permits nothing. | `knowledgeSources`. | **implemented** |
| **Admission** | access control on retrieval | Licence and authority check before chunking and again before answering. | `admit(authority, intent)` with `Intent = index | chunk | answer | quote | train`, `planAnswer()`, `checkClaim()`, `FORBIDDEN_AI_OUTCOMES`, `AUTHORITY_LEVELS`, `BINDING_LEVELS` in `knowledge/admission.ts` | Level F (`unverified`, which includes AI inference) may never support a dispatch or compliance decision. | — | **implemented** (reached via `sourceGate`/`repository` chain) |
| **Evidence grounding** | citation verification, faithfulness check | Each claim stands on retrieved passages or is reported unsupported. | `verifyClaim()`, `verifyAnswer()`, `ClaimState` (supported, unsupported, conflicting, superseded, out_of_scope), `MIN_SUPPORT_SCORE = 0.35` in `evidenceGrounding.ts` | Unsupported is a real outcome, not softened. | `assistantQueries.verdict`. | **implemented** |
| **Request perimeter** | topic guardrail, scope filter | Refusing off-domain requests before a model is spent. | `classifyRequest()` → `RequestVerdict`, `RefusalCode`, `PERIMETER_DOMAINS` in `knowledge/perimeter.ts`; `OUT_OF_PERIMETER` regex in `runExtraction.ts`; model flag `outOfScope` | Deterministic first; model flag second. | — | `perimeter.ts` **declared / unwired** ("two-gate design only half wired"); `runExtraction` **unwired** |
| **Learning intake** | continual learning, self-improvement | Where discovered knowledge may go. | `routeLearning()`, `promote()`, `LearningOrigin`, `LearningDestination`, `AUTONOMOUS_ORIGINS` in `perimeter.ts`; promotion ledger (`hosRuleLimitHistory`, `promotionLedger.ts`, `rulePromotion.ts`, `scopeGuard.ts`, `citationGuard.ts`) | Discovery may be autonomous; promotion into authoritative rules may not. **This is knowledge promotion, not model training.** | Durable ledger. | **partial** |
| **Retrieval measurement** | RAG eval, recall@k | Labelled probes scored against the live retriever. | `retrievalProbes`, `retrievalMeasurements` (`corpusHash`, `retrieverKey = "mysql-natural-language"`, `retrieverVersion = "lexical-v3"`, `k`, grade); `scoreProbe()`, `gradeRetrieval()`, `vocabularyGaps()`, `MIN_MEANINGFUL_PROBES = 20`; procedures `addProbe`, `addProbeFromAsk`, `measureRetrieval` | A measurement is tied to corpus hash, retriever version and depth; a mismatch is reported, not reused. | Durable. | **implemented** |
| **Embedding index** | vector store, semantic search | Optional retrieval mechanism. | None. `ModelTask "embed"` is declared in `modelGateway.ts`; `knowledgeSources.ragIngestionAuthorized` gates ingestion; `retrievalQuality.ts:217` notes the vocabulary-gap metric exists so nobody "buys embeddings for a problem a synonym list solves". | — | — | **deferred** (see §7) |

### 2.7 Evaluation and feedback

| Canonical term | Industry synonym | Definition | Implementation | Authority boundary | Persistence | Status |
|---|---|---|---|---|---|---|
| **Golden set** | eval dataset, regression suite | Narrations with the correct form beside them, scored per field. | `loadGoldenSet()`, 12 fixtures in `server/_core/ai/__fixtures__/narrations/`, `GoldenCase`, `GoldenExpectation`; `scoreCase()` → `CaseScore { fieldsCorrect, fieldsChecked, unexpectedSilentGuesses, mismatches }`; `goldenSet.test.ts` (CI, mock provider); `pnpm eval:secretary` (`runEval.ts`, real provider, never CI) | Silent-guess floor fails the run on its own. | Files in the repo. | **declared / unwired** as engine; **runs in CI** as test |
| **AI Evaluation Feedback** | RLHF signal, human feedback (misnomer) | Product signals about AI quality: corrections, rejections, accepted proposals, clarification frequency, tool refusals. | `proposalFields.status` (`corrected`, `rejected`) + `correctedFrom`; `assistantProposals.overreachFlags`; `assistantQuestions` counts; `agentActions.decision = deny`; `assistantQueries.verdict`; `retrievalProbes.origin = real_question` | These feed evaluations and prompt work. They are **not** used for reinforcement learning and must not be called RLHF. | Durable, spread across the tables named. | **partial** — signals exist, nothing aggregates them |
| **Model attribution** | — | Which provider/model answered, for audit and for choosing a different verifier. | `ModelAttribution`, `attribute()` in `modelGateway.ts`; `LlmResponse.modelId`; `RunProvenance.modelId` | — | **Not stored** on any row. | **declared / unwired** |

---

## 3. Agentic workflow, stage by stage

| Concept | LeaseOS implementation | Status |
|---|---|---|
| Goal / request | `agentRuns.goal` via `agent.start`; `SecretaryExtractionEvent.transcript` (door 2); `assistant.draft` input `transcript` (door 1) | existing (agent, door 1); unwired (door 2) |
| Context acquisition | `admitSource()` + `retrieve()` in `assistantAskRouter.ts` (knowledge); `buildContextPack()` (operational, pure; the caller does the reading) | existing (knowledge); unwired (context pack; nothing assembles one from records) |
| Planning | `agent.start` stores a caller-supplied `plan[]` of capabilities into `agentSteps`; `DialoguePhase` sequence in `machine.ts` is fixed, not planned | existing (stored plan, never executed); no model-generated planning exists |
| Tool registry | `SECRETARY_TOOLS` / `resolveTool()` (`ai/tools/registry.ts`); `CAPABILITIES` / `buildRegistry()` (`agentRouter.ts`, `actionGateway.ts`) | unwired (tools); existing (capabilities) — two registries, see §5 |
| Authorization | `roleProcedure` → `authorizationDecisions`; `decide()` → `agentActions`; `resolveActingScope()` | existing |
| Tool execution | `invokeTool()` over `createCaller(ctx)` (`ai/tools/caller.ts`) | unwired — no composition root supplies `createCaller`; `agentRouter.ts` executes nothing by design |
| Worker boundary | `runSecretaryExtractionJob()`; `productionWorker.ts` handler list | unwired — `workerBoundary.test.ts` asserts the worker does not dispatch `secretary.narration.captured` |
| Observation | `ToolResult.output` (unwired); `Observation { finding, source, urgency }` in `secretaryCoordination.ts` (briefing lines from engines, reached via `messageBoard.ts`) | partial |
| Evaluation | `validateExtraction()` → `ValidationResult` (unwired); `verifyClaim()` (existing, retrieval path); `checkCommit()` refusals (existing, proposal path) | partial |
| Continue / clarify / stop | `advance()` in `machine.ts` (unwired); `TRANSITIONS` in `agentRouter.ts` (existing); `detectNoProgress()` (unwired); `MAX_CLARIFY_ROUNDS` (unwired); `minimumQuestions()` (existing) | partial |
| Audit receipt | `assistantCommitReceipts` (one per proposal, unique `proposalId`, `fieldManifestHash`, `authorizationDecisionId`); `domainEventOutbox`; `agentActions` | existing |
| Human approval | `agentApprovals` + `agent.decideApproval`; `assistant.readBack` → `acknowledge` → `commit`; `automationPolicy` HYBRID | existing |

---

## 4. Orchestration — where the coordination already lives

Orchestration is coordination, not a model. Each responsibility below already has a home:

| Responsibility | Canonical home | Notes |
|---|---|---|
| Determine task state | `agentRuns.status` + `TRANSITIONS` (`agentRouter.ts`); per narration, `DialogueState.phase` | Two state vocabularies at two granularities; not a duplication (a run may contain many narrations). |
| Determine what can happen next | `TRANSITIONS`; `afterValidation()` in `machine.ts` | |
| Select permitted tools | `TaskAllowlist` + `resolveTool()` | unwired |
| Enforce budgets | `spendStep()` / `stepBudget`; `agentRuns.maxSteps` (never read); `MAX_CLARIFY_ROUNDS` | see §11 |
| Invoke workers | `startProductionWorker()` + `withHandlers()`; outbox claim in `workflowRuntime.ts` | the Secretary handler is the missing registration |
| Collect tool results | `ToolResult` (unwired); `agentActions.outcome` (never advanced) | **gap**: no persisted tool result |
| Handle retries | `drainWorker.ts` (outbox); `shouldRetry()` (gateway policy, unwired); `llm.ts` (legacy door) | |
| Determine completion | `isComplete(outcome) === "verified"` (gateway); `isTerminal(state)` (dialogue); `commitState = "committed"` (proposal) | |
| Request clarification | `assistantQuestions` + `persistQuestions()`; `needsClarification` + `questionFor()` | `persistQuestions()` has no caller |
| Escalate to humans | `require_approval` → `agentApprovals`; `DRAFT_FOR_OFFICE` phase; `escalation.ts` (only `DEFAULT_CRITICAL_POLICY` is reached, via `enforcementOutbox.ts`; `escalationOutcome()` has no production caller); Exception Centre category `ai` (derived) | |

**Verdict: there is no architectural hole that an `orchestrator.ts` would fill.** The hole is a
*wiring* hole with a known shape: a production-worker handler that (1) claims
`secretary.narration.captured`, (2) builds a `ContextPack` from records, (3) calls
`runSecretaryExtractionJob()` with a configured `LlmProvider`, (4) persists the proposal through
the existing `createAssistantProposal` path, and (5) advances an `agentRuns`/`agentActions` row.
That is a handler registered in `productionWorker.ts`, the same shape as the enforcement handler,
not a new engine. It is SPINE-blocked and is **not** done here.

The canonical boundary name, if one is needed in conversation, is the existing **agent runtime**
(`server/agentRouter.ts` + `server/_core/actionGateway.ts`). Do not introduce "orchestrator".

---

## 5. Tool / function calling — intended mapping, not implemented

The architecture to preserve, with what exists at each hop:

```
Model                          →  emits a tool key and arguments (no path does this today)
AI tool key                    →  ToolDefinition.key            registry.ts        [unwired]
server-owned tool registry     →  SECRETARY_TOOLS, resolveTool  registry.ts        [unwired]
existing ProcedureName         →  ToolDefinition.procedure      typed by compiler  [unwired]
driver-scoped createCaller     →  invokeTool({ createCaller })  caller.ts          [unwired; injected]
existing tRPC authorization    →  roleProcedure                 trpc.ts            [live]
existing domain procedure      →  tripStops.list, assistant.draft, agent.requestAction …  [live]
```

Things the model must never supply, and where that is enforced today:

| Must never supply | Enforcement |
|---|---|
| arbitrary procedure names | `ToolDefinition.procedure: ProcedureName` (compile-time); `invokeTool` takes a tool key |
| SQL | no tool category exposes a query; `actionGateway.ts` header states the rule |
| tenant / org identifiers | `resolveActingScope()` refuses input tenants; `agentRouter.ts` forces `tenantId` from acting scope |
| permission names | `CapabilityDefinition.requiredPermissions` is server data; `roleProcedure` derives permission from procedure |
| unrestricted form keys | `planToolCall()` overwrites `formKey` with the pinned constant |
| authorization context | `TrpcContext` is handed in by the request or job; `caller.ts` builds none |

The tool-call record the request describes, mapped onto existing storage:

| Field | Existing home | Status |
|---|---|---|
| tool key | `ToolResult.toolKey`; `agentActions.capability` (capability key, not tool key) | partial — two key spaces (§10 item 7) |
| version | **none** for tools. `FORMS[*].version` and `PromptVersion` exist; `ToolDefinition` has no version field | **missing** |
| validated arguments | zod `.input()` on the target `roleProcedure` | existing |
| caller context | `TrpcContext`; `agentActions.actorId` + `delegatedByUserId` | existing |
| authorization decision | `authorizationDecisions` row; `agentActions.decision` | existing |
| execution state | `agentActions.outcome` (never advanced past `requested`); `agentSteps.status` | partial |
| result | `ToolResult.output` — **not persisted** | **missing** |
| timestamps | `agentActions.requestedAt`; `agentSteps.startedAt/completedAt` (never set) | partial |
| correlation / job id | `agentRuns.runRef`; `domainEventOutbox.correlationId` | existing |
| audit receipt | `assistantCommitReceipts` (commits only); `domainEventOutbox.eventId` | existing for commits; none for reads |

Do not implement the production path while the moratorium prohibits AI wiring.

---

## 6. Context Window versus durable memory

| Term | Definition | Where it lives | Rule |
|---|---|---|---|
| **Model Context** | temporary input supplied to one inference request | `LlmRequest.messages` / `InvokeParams.messages` | Never authoritative. Discarded after the call. |
| **LeaseOS Records** | authoritative operational records | domain tables via `roleProcedure` and typed commit adapters | Anything for compliance, billing, safety, dispatch, HOS, disposal tracking, maintenance or employee records lives here. |
| **Retrieval Context** | records selected for one AI request | `AdmittedContextBlock` (knowledge); `ContextPack` items (operational) | Authorized before it is model-readable. Projected fields, never rows. |
| **Conversation State** | persisted interaction state, where appropriate | `assistantQuestions`, `assistantProposals.readBack`, `DialogueState` (unpersisted) | Server-owned; the model never sets phase or status. |
| **Audit History** | immutable evidence of actions and results | `authorizationDecisions`, `assistantCommitReceipts`, `agentActions`, `assistantQueries`, `domainEventOutbox` | Append-only. |

The existing code already draws this line: `contextPack.ts` calls the pack "the small slice of the
company a model is allowed to see", and `contextAdmission.ts` says nothing becomes model-readable
"because somebody constructed an object that looks right". No module treats model context as
storage.

---

## 7. Retrieval / RAG and embeddings

**What exists.** A working, measured, extractive retrieval layer over company documents:
`assistantAsk.ask` retrieves tenant-scoped passages by MySQL full-text match, admits each one with
the caller's real permissions, grades the answer with `verifyClaim()`, records the ask in
`assistantQueries`, and reports retrieval quality from `retrievalMeasurements` only when the
measurement matches the current corpus hash, retriever version and depth. **No model is on the
path.** The target order the request asks for — authenticated context → scope → authorized
retrieval → evidence selection → model context → inference — is implemented up to "evidence
selection"; the last two hops do not exist.

**Sources covered today.** `knowledgePassages` only (company policies, safety procedures,
regulatory references loaded as passages). Driver records, training records, equipment, jobs,
trips, disposal facilities, forms, historical jobs, client instructions, maps and the document
vault are **not** retrieval sources; they are ordinary scoped procedures (`tripStops.list`,
`loads.list`, `units.list`, `closeout.state`, …), and the tool registry (§5) is the intended way a
model would reach them. That is the correct default: for structured records, a scoped query is
safer than a semantic index.

**Authorization before retrieval — status.** Implemented for passages (tenant in the query,
`admitSource()` per candidate, `quotable()` filter, licence gate on load). The unwired
`ContextPack` path has the stronger property that the pack module cannot import a table at all.

**Embeddings — the ten questions, answered from the survey.**

| Question | Answer today |
|---|---|
| What data needs semantic search? | Nothing proven. `vocabularyGaps()` is the metric that would prove it: probes whose question shares no stem with the passage that answers them. No measurement showing that gap is recorded in the repo. |
| Why is SQL / full-text insufficient? | Not shown to be. `RETRIEVER_VERSION = "lexical-v3"` is measured by recall@k against labelled probes; `MIN_MEANINGFUL_PROBES = 20` before a grade is trusted. |
| Tenant isolation | Would have to replicate `retrieve()`'s in-query `tenantId` scope and `admitSource()` per hit. No design exists. |
| What may be embedded | Gated by `knowledgeSources.ragIngestionAuthorized` and `admit(authority, "index")`; restricted-vault and medical records are outside the perimeter (`contextPerimeter.test.ts`). |
| Deletion / update propagation | `knowledgePassages.supersededAt` and `knowledgeChunks.authorizedByAssessmentId` exist so a revocation can find its rows; an index would need the same key. |
| Sensitive operational content | Same perimeter as above. |
| Offline use | `ModelProvider.runsOffline` and `Deployment.offline` exist in `modelGateway.ts`; nothing embeds offline. |
| Provider / model | `ModelTask "embed"` is declared; no provider is registered. |
| Local generation | Possible through the same OpenAI-compatible door; not built. |
| Version-triggered re-indexing | `retrievalMeasurements.retrieverVersion` + `corpusHash` is the pattern to copy. |

**Verdict: deferred.** Do not add a vector database. The condition that would justify one is a
recorded `measureRetrieval` run with meaningful sample size whose `vocabularyGaps` cannot be closed
by `domainTokens.ts` synonyms.

---

## 8. Prompt / instruction contracts

**Current state: two prompt sources.**

| | Door 1 (live) | Door 2 (unwired) |
|---|---|---|
| Location | `buildSystemPrompt()` in `assistantExtraction.ts` | `prompts/secretary-extract.v1.md` + `prompts/index.ts` |
| Versioned | no | yes (`PromptVersion`) |
| Hashed | no | yes (`promptHash()`) |
| Static/dynamic separation | mixed (slots interpolated into rules) | static file; context pack and fenced transcript appended by `runExtraction()` |
| Recorded on the proposal | no | in `RunProvenance` type only; **no column** |

Mapping the requested contract fields onto what exists:

| Contract field | Exists as | Gap |
|---|---|---|
| prompt key / version | `PromptVersion` literal union | one prompt only |
| purpose | file header prose | not structured |
| allowed context classes | `ContextItemKind` (door 2); `BlockKind` (assembly) | not declared per prompt |
| expected output schema | `buildFormJsonSchema(form)` | bound to the form, not to the prompt |
| tool allowlist | `TaskAllowlist` | bound to the task, not to the prompt |
| automation ceiling | `SecretaryProposal.ceiling = "HYBRID"` | constant, not per prompt |
| failure behaviour | `ExtractionUnparseable` thrown; caller re-asks | not declared |
| clarification behaviour | `MAX_CLARIFY_ROUNDS`, `questionFor()` | not declared per prompt |
| safety constraints | prose in the prompt; `detectOverreach()`; `FORBIDDEN_CATEGORIES` | enforced in code, not declared in the prompt record |

**Recommendation (deferred, SPINE-blocked):** when door 2 is wired, a `PromptContract` type in
`prompts/index.ts` that binds `PromptVersion` to a form key, a `TaskAllowlist` and a ceiling is the
smallest change. Do not refactor `buildSystemPrompt()` now.

---

## 9. Structured output enforcement — where the rule holds

Rule: LLM output → parse → schema validation → domain validation → authorization → proposal →
approval/automation policy → commit. Never LLM text → database write.

| Path | parse | schema | domain validation | authorization | proposal | approval | commit | Verdict |
|---|---|---|---|---|---|---|---|---|
| **door 1** `fieldRoute.assistant.draft` | `parseModelJson()` | provider-side `response_format json_schema`; `parseExtraction()` drops undeclared keys | `looksHedged()` → precision; `detectOverreach()` on notes; `detectGaps()` | `roleProcedure("assistant.draft")` | `createAssistantProposal` → `commitState drafting/awaiting_answers` | `answer` → `readBack` → `acknowledge` (human) | `assistant.commit` → `executeAssistantCommit()` (second authorization for the target write, lock, write once, receipt) | **follows the rule** |
| **door 2** `runExtraction()` | `parseModelJson()` | `strict: true` json_schema; `parseExtractionEnvelope()` | `validateExtraction()` (quote check, normalizers, cross-checks) | inherits the driver's `roleProcedure` when a tool is called | `toProposal()` → `commitState "drafting"`, `ceiling "HYBRID"`; `advanceBlockedBecause()` | `assistantCommit` path unchanged; no commit tool exists | — | **follows the rule**; unwired |
| retrieval `assistantAsk.ask` | no model | — | `verifyClaim()` | `roleProcedure("assistant.ask")` + `admitSource()` | — | — | no write | n/a |
| agent runtime `agent.requestAction` | no model | zod input | `decide()` | `roleProcedure` + gateway | `agentActions` | `agentApprovals` | nothing executes | n/a |

**Violations found: none of the "LLM text → database write" kind.** Two adjacent facts to record:

1. `assistantProposals.notes` persists model-generated prose (observations). It is not acted on,
   it is overreach-checked, and it is shown to a person. This is a model output, not hidden
   reasoning, and it is the correct place for it.
2. `assistant.draft` calls the model inside a request handler. That is a worker-boundary violation,
   not a structured-output violation, and it is pinned at exactly one by `workerBoundary.test.ts`.

---

## 10. Inference provider boundary

Two doors, documented plainly:

| | `server/_core/llm.ts` (door 1) | `server/_core/ai/llm/` (door 2) |
|---|---|---|
| Default host | **yes** — `https://forge.manus.im/v1/chat/completions` when `BUILT_IN_FORGE_API_URL` is empty | **none** — `LlmNotConfigured` thrown |
| Key | `BUILT_IN_FORGE_API_KEY` (error text says `OPENAI_API_KEY`) | `LLM_API_KEY`, optional |
| Fail mode when unconfigured | fails open on host (only the key is asserted) | fails closed |
| Retries | 4, with backoff and `retry-after` | none (the outbox retries the job) |
| Timeout | none | 60 s (`DEFAULT_TIMEOUT_MS`) |
| Output constraint | `response_format` passthrough | `json_schema` with `strict: true` always |
| Hidden-reasoning params | accepts `thinking` and `reasoning` passthrough objects; **no caller passes them** | none |
| Callers | `fieldRoute.assistant.draft` only (`routers.ts:691`); `voiceTranscription.ts` and `imageGeneration.ts` use the same `ENV.forge*` host for other endpoints | none (unwired) |
| Domain engine knows the vendor? | `llm.ts` does; `assistantExtraction.ts` does not (it imports only the `OutputSchema` type) | no module names a vendor |

Long-term layering, mapped onto existing names:

```
AI application logic        runExtraction(), runSecretaryExtractionJob()
        ↓
Inference interface         LlmProvider                    (ai/llm/provider.ts)
        ↓
Configured provider adapter OpenAiCompatibleProvider.fromEnv(), MockLlmProvider; selection by modelGateway.route()
        ↓
Provider / model            LLM_BASE_URL + LLM_MODEL
```

**Do not refactor `llm.ts` during the BoundaryConfirmation checkpoint.** The one live caller is
pinned; retiring it is the "carve-out" ruling the moratorium document asks the owner for.

---

## 11. Budgets

| Budget | Implementation | Server-controlled? | Enforced? |
|---|---|---|---|
| Maximum steps / tool calls | `TaskAllowlist.stepBudget` (8, 6) + `spendStep()` → `StepBudgetExhausted` | yes (constants) | in code, unwired |
| | `agentRuns.maxSteps` (default 40), `stepsUsed` | yes (column default) | **no** — nothing reads or increments either column |
| | `agent.start` plan length ≤ 40 (zod) | yes | yes |
| Clarification rounds | `MAX_CLARIFY_ROUNDS = 3` | yes | in code, unwired |
| Timeout / deadline | `OpenAiCompatibleProvider.timeoutMs` (60 s); outbox claim lease (`CLAIM_LEASE_SECONDS` in `workflowRuntime.ts`) | yes | provider unwired; lease live |
| Retry limits | `DEFAULT_WORKER_CONFIG.maxAttempts = 5` → dead-letter; `llm.ts` 4 retries; `shouldRetry()` policy | yes | outbox live; gateway policy unwired |
| Model-call limits per run | **none** | — | **missing** |
| Token / cost budget | **none**. `LlmResponse.usage` and `InvokeResult.usage` capture tokens; nothing sums, stores or caps them | — | **missing** |
| No-progress stop | `detectNoProgress()` (3 identical steps) | yes | unwired |

Nothing lets the model widen a budget: budgets are constants or columns with defaults, and no
procedure input sets `stepBudget`, `maxSteps` or a token cap. A request may narrow (a plan of 3
steps under a cap of 40); it cannot widen.

---

## 12. Clarification and agent outcomes

The requested outcome set, mapped onto existing vocabularies. No new status enum should be added;
these are the equivalents.

| Requested outcome | Dialogue (`DialoguePhase`) | Extraction (`ExtractionOutcome` / `Verdict`) | Proposal (`CommitState` / `FieldStatus`) | Agent run (`agentRuns.status`) | Gateway (`Decision`) | Retrieval (`assistantQueries.verdict`) |
|---|---|---|---|---|---|---|
| COMPLETE | `PROPOSE` | `extracted` with all `PASS` | `committed` | `completed` | `allow` + outcome `verified` | `verified` |
| PROPOSED_ACTION | `READBACK` | `extracted` | `drafting`, `awaiting_readback` | `waiting_for_approval` | `require_approval` | — |
| NEEDS_CLARIFICATION | `CLARIFY`, `HOLDING`, `DRAFT_FOR_OFFICE` | field `REVIEW`, `UNKNOWN`; `needsClarification[]` | `awaiting_answers`; `assistantQuestions.status = pending` | `waiting_for_input` | — | `partially_supported` |
| REFUSED | `REFUSED` | `refused` (`out_of_perimeter`); field `BLOCKED` | `rejected` | `blocked` | `deny`, `compliance_block` | — |
| NOT_EVALUATED | — | `NOT_EVALUATED` | — | — | `compliance_block` on `unknown` | `insufficient_evidence` |
| FAILED | — | `ExtractionUnparseable`, `LlmTransportError` | — | `failed`; outbox `dead_letter` | `stale` | `conflicting` |

The cases the request singles out are already the hard cases in code: missing ticket data
(`ticket_not_open`, `ticket_prefix_missing`), uncertain quantity (`volume_unit_missing`,
`ambiguous_reading`), equipment capacity (`capacity_unknown` → `NOT_EVALUATED`, never PASS),
legal land (`legalLocation.ts` over `dls.ts`), dangerous-goods classification
(`evaluateDangerousGoodsAssist()` → `blocked | needs_review | ready_for_human_confirmation`, never a
classification from free text), billing fields (`precisionSensitive: true` forces a question).

---

## 13. Training, fine-tuning, RAG, prompt, tools — kept apart

| Term | LeaseOS position | Existing hooks |
|---|---|---|
| **Training** (a foundation model) | Not done inside LeaseOS. | `knowledgeSources.modelTrainingAuthorized` and `admit(…, "train")` exist so a licence can *forbid* it; nothing trains. |
| **Fine-tuning** | Future optimization only; never the first answer to company-specific knowledge. | None. `proposalFields.correctedFrom` is described in `bridge.ts` as "the free training set the plan wants later" — that is a *dataset*, not a training path. |
| **RAG / authorized retrieval** | Preferred first approach for changing company knowledge. | `assistantAsk.ask`, `knowledgePassages`, `admitSource()`. |
| **Prompt / configuration** | Stable behaviour and output rules. | `PromptVersion`, `FORMS`, `TaskAllowlist`, `automationPolicies`. |
| **Tools** | Interaction with operational systems. | `SECRETARY_TOOLS` → `ProcedureName`. |
| **Learning intake / promotion** | *Knowledge* promotion into authoritative rules, by review. | `routeLearning()`, `promote()`, promotion ledger. **Not model training**, despite the word "learning". |

When someone says "train the AI on the company data", the LeaseOS term is **authorized retrieval**
(or, for figures that must bind, **rule promotion** through the ledger).

---

## 14. Evaluation and telemetry seams

| Metric asked for | Seam that exists | Status |
|---|---|---|
| field extraction accuracy | `CaseScore.fieldsCorrect / fieldsChecked` | golden set only |
| clarification rate | `assistantQuestions` rows per proposal; `ValidationResult.needsClarification.length` | queryable, not aggregated |
| rejected / corrected proposal rate | `proposalFields.status`, `assistantProposals.commitState = rejected` | queryable, not aggregated |
| tool refusal rate | `ToolNotAllowed` (unwired); `agentActions.decision = deny` | partial |
| malformed output rate | `ExtractionUnparseable` (unwired); door 1 `parseModelJson() === null` (not counted) | **no counter** |
| hallucinated tool attempts | unknown tool key → `ToolNotAllowed` (unwired; not recorded) | **no record** |
| authorization refusals | `authorizationDecisions.outcome` | implemented |
| model latency | **none** | missing |
| provider errors | `LlmTransportError` (unwired); `llm.ts` `console.warn` only | missing |
| token usage / cost | `LlmResponse.usage` captured, not stored | missing |
| job completion rate | `agentRuns.status`; `domainEventOutbox` processed vs dead-lettered (`assessQueueHealth()`) | partial |
| human override rate | `proposalFields.correctedFrom`; `agentApprovals.decision = rejected`; `evaluateOperationalOverride()` | queryable |
| retrieval recall | `retrievalMeasurements` | implemented |
| silent guesses | `silentGuessKeys`, pinned at zero | golden set only |

A telemetry seam exists for retrieval and authorization; there is **no seam for inference
telemetry** (latency, tokens, provider errors, model id). The natural home is a run-provenance
column set on `assistantProposals` (§15), not a new table.

---

## 15. Identifiers and contracts

| Concept | Identifier / contract today | Gap |
|---|---|---|
| Inference request | none. `RunProvenance.inputHash` + `promptHash` + `modelId` identify it by content. | no id, no row |
| Agent job | `agentRuns.runRef` (`AR-…`) | — |
| Tool execution | `agentActions.actionRef` (`ACT-…`) for gateway requests; `ToolResult` (no id) for registry calls | two shapes, unjoined |
| Domain transaction | `authorizationDecisions.id`; `assistantCommitReceipts.authorizationDecisionId`, `targetType`, `targetRecordId` | — |
| Receipt | `assistantCommitReceipts.proposalId` (unique); `domainEventOutbox.eventId` (unique), `correlationId`, `causationId` | no receipt for read-only tool calls |
| Capture (device) | `clientCaptureId` → `proposalId = PROP-<clientCaptureId>`; `idempotencyKeyFor()` | unwired |
| Proposal | `assistantProposals.proposalId` | `RunProvenance` fields have no columns |
| Clarification | `assistantQuestions.questionRef` | — |
| Approval | `agentApprovals.approvalRef` bound to `payloadHash` | — |
| Ask | `assistantQueries.queryRef` (`ASK-…`) | — |

These must not be conflated. In particular an **inference request** is not an **agent run** (one
run may make many), and a **tool execution** is not a **domain transaction** (a read tool commits
nothing).

---

## 16. Hidden reasoning / Chain-of-Thought — findings

**No module persists model deliberation.** No table, column or type is named `chainOfThought`,
`thoughts`, `internalReasoning`, `scratchpad` or any variant. Three adjacent items, reported rather
than expanded:

1. `InvokeParams.thinking` and `InvokeParams.reasoning` in `server/_core/llm.ts` are passthrough
   objects for vendor "thinking" modes. **No caller passes them.** They should stay unused; if a
   provider returns reasoning content, door 1 discards everything except `choices[].message.content`.
2. `agent.requestAction` accepts `reasoningSummary` (≤ 600 chars) and `evidenceRefs` and places them
   on `ActionRequest`. `reasoningSummary` is **not persisted** (`agentActions` has no such column)
   and is caller-supplied text, not model output. `evidenceRefs` is the auditable substitute and
   is also not persisted. Recommendation: when this is next touched, persist `evidenceRefs` and
   leave `reasoningSummary` unpersisted or drop it.
3. `assistantProposals.notes` persists model prose ("observations only, never a conclusion"),
   overreach-checked. It is an observable output, not hidden reasoning.

The audit model the request asks for maps as: user request (`transcript` / `goal`) → normalized
task (`formKey` + `TaskAllowlist.taskKey`) → context references (`ContextItem.id`, `evidenceRef`,
`citedPassageRefsJson`) → proposed plan/action (`agentSteps`, `ActionRequest`) → policy decision
(`agentActions.decision`, `authorizationDecisions`) → tool request (`ToolInvocation`) → tool result
(`ToolResult`, unpersisted) → proposed record change (`assistantProposals` + `proposalFields`) →
approval (`agentApprovals`, `readBackAcknowledged`, `proposalFields.status`) → committed action
(`executeAssistantCommit()`) → receipt (`assistantCommitReceipts`, `domainEventOutbox`). Every
element is an observable artifact.

---

## 17. Naming mismatches

| Industry term | Repository name | Note |
|---|---|---|
| tool / function | `ToolDefinition` (model-facing) **and** `CapabilityDefinition` (gateway-facing) | two key spaces; see §18 item 1 |
| orchestrator | agent runtime: `agentRouter.ts` + `actionGateway.ts` | do not add the word |
| observation | `ToolResult.output`; also `Observation` in `secretaryCoordination.ts` (an engine finding in a briefing) | same word, two meanings |
| proposal | `Proposal` in `aiProposal.ts` (typed form proposal) **and** `Proposal` in `secretaryCoordination.ts` (briefing suggestion) | identical type name in two modules; `SecretaryProposal` in `bridge.ts` is a third wrapper |
| clarification | `Gap` (live), `assistantQuestions.reason` (live), `FieldVerdict.reasonCodes` (unwired) | three reason vocabularies |
| guardrail | `Verdict`, `detectOverreach`, `scanForInjection`, `FORBIDDEN_CATEGORIES`, `NEVER_AUTONOMOUS` | no single "guardrail" concept, correctly |
| confidence | `ProposedField.confidence` (low/medium/high, set by validator or model); `documentExtraction.OcrField.confidence` (0–100); `SttConfidence` (0..1) | door 2 refuses to store the model's own number |
| memory | none. `merchantMemory` is vendor normalisation, not AI memory | do not introduce "memory" |
| context window | `LlmRequest.messages` | see §6 |
| RLHF | none | use **AI Evaluation Feedback** |
| grounding | `evidenceGrounding.ts` (claims vs passages); `evidenceQuote`/`evidenceRef` (fields vs transcript/pack) | two grounding mechanisms at two layers, deliberate |
| planning | `agentSteps` (caller-supplied plan) | no model-generated planning exists |

---

## 18. Duplicate or parallel architecture found

1. **Two registries: `SECRETARY_TOOLS` (tool key → `ProcedureName`) and `CAPABILITIES` (capability
   key → permissions + risk).** Both exist; neither refers to the other. The canonical split should
   be: a **tool** is the model-facing key bound to a procedure; a **capability** is the risk-classed
   action the gateway decides. They should be joined by key (a tool declares which capability it
   exercises), not merged. `registry.ts` already consults `NEVER_AUTONOMOUS` from the gateway, so
   the dependency direction is set. **No action now.**
2. **Two extraction contracts** (`RawSlot` in `assistantExtraction.ts`; `ExtractedField` in
   `ai/extraction/contract.ts`). Acknowledged in code; bridged by `proposal/bridge.ts` to one stored
   shape. Retire door 1's contract when door 1 is retired, not before.
3. **Two prompt sources** (§8).
4. **Two LLM doors** (§10).
5. **Two never-automatic lists** (`NEVER_AUTOMATIC`, `NEVER_AUTONOMOUS`), kept consistent by
   `floorDisagreements()` and its test. Not a defect.
6. **Three clarification vocabularies** (`Gap.kind`, `assistantQuestions.reason`,
   `FieldVerdict.reasonCodes`). The stored one is `assistantQuestions.reason`; door 2's reason
   codes are finer and would map onto it.
7. **Two perimeter checks** (`classifyRequest()` and `OUT_OF_PERIMETER`), plus the model's
   `outOfScope` flag. Acknowledged in `runExtraction.ts`.
8. **Two retry loops** (`llm.ts`, `drainWorker.ts`). Acknowledged in
   `openAiCompatibleProvider.ts`; door 2 has none for that reason.
9. **`docs/register/SPINE_WIRING_PLAN.md` is cited** by `SECRETARY_SPINE_MORATORIUM.md` and
   `engineReachability.test.ts`, and at the time of this survey **did not exist in this
   repository or in any of its branches, tags or objects.** Its canonical copy is in the sibling
   repository `dylanmark218-dot/leaseos`, authored at `df51d65a` on 2026-09-21, after this
   repository's import snapshot; the citations here were written against that copy. It has
   since been restored here byte for byte with a provenance record and a structural guard
   (`docs/register/SPINE_WIRING_PLAN_PROVENANCE.md`, `server/spineWiringPlan.test.ts`, PR #13).
   Nothing in this document reconstructs its contents.
10. **Dangling OCR chain.** `extractToProposal()` (`documentExtraction.ts`) and `persistQuestions()`
    (`questionQueueService.ts`) have no production caller; `documentExtraction` counts as reached
    only because `normalizeVendor()` and the `DocumentType` type are imported elsewhere.

---

## 19. Genuine missing seams

| Seam | Why it matters | Smallest shape |
|---|---|---|
| Run-provenance columns on `assistantProposals` | `RunProvenance` says "recorded on every proposal"; the schema has nowhere to put `providerKey`, `modelId`, `promptVersion`, `promptHash`, `inputHash`. Without them, reproduction and model attribution are impossible. | five nullable columns; a migration, when door 2 is wired |
| Persisted tool result | `ToolResult` is returned and lost; `agentActions.outcome` never moves past `requested`. | advance `outcome` and store an output hash; no new table |
| Tool version | `ToolDefinition` has no `version`; a changed tool contract is invisible to audit. | a `version` field on `ToolDefinition` |
| Inference telemetry | no latency, token, error or model-id record anywhere. | same provenance columns plus `usage` |
| Budget enforcement on runs | `agentRuns.maxSteps` / `stepsUsed` are never read. | increment in `requestAction`; refuse at cap |
| Composition root for `createCaller` | `invokeTool` requires it; nothing supplies it. | the worker handler (§4), SPINE-blocked |
| `SttConfidence` supplier | typed seam; no transcriber implements it. | device work, off-spine |
| Capacity column for the over-capacity rule | recorded in the moratorium document §6; a domain decision. | owner decision, not code |

---

## 20. Recommendations to postpone

- Any wiring of door 2, the Secretary worker handler, or `createCaller` supply (SPINE).
- Retiring `invokeLLM` from `assistant.draft` (needs the owner's carve-out ruling).
- Prompt-contract type (§8) — with door 2 wiring.
- Provenance columns and inference telemetry (§19) — with door 2 wiring; a migration during the
  BoundaryConfirmation checkpoint would widen its scope.
- Joining tool and capability registries (§18 item 1).
- Embeddings / vector store — until a `measureRetrieval` run proves a vocabulary gap.
- Fine-tuning — indefinitely; not the first answer to company knowledge.
- Any "AI memory", conversation store or reasoning store — intentionally unsupported.

## 21. Effect on the SPINE order

None. The earliest incomplete item remains **per-boundary confirmation on `tripStops`**: a pure
resolver from `proposalFields.source × status` to `BoundaryConfirmation` per `BoundaryKey`, reached
from `assistantCommitReceipts.targetRecordId`. Nothing in this survey moves ahead of it, and no
finding here requires an engine before it. The one thing this survey adds to the SPINE conversation
is item 9 of §18: the plan document the moratorium cites was absent from this repository, and a
moratorium whose primary text is missing is enforced by quotation. The recovered plan's ordering
(per-boundary confirmation → the four duplications → `offlineCapability` → the rest of the spine)
is the order this document assumed.
