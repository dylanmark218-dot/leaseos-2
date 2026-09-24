# AIL-0: AI safety boundary characterization

**PRODUCTION BEHAVIOR CHANGE: NONE.** This checkpoint adds one test file and two documentation
changes. No production module, router, schema, migration, prompt, policy list or permission was
touched. Nothing is wired, no provider is activated, and no gap found here was fixed.

- Design and rulings: `docs/register/AI_GOVERNED_LEARNING_DESIGN.md` (§13 records R-1 … R-8).
- Suite: `server/aiSafetyBoundary.test.ts`. It sits outside `server/_core/`, so it is not an engine
  and the census pin (57) does not move.
- Base: `7a0b008` (the approved design commit on `claude/relaxed-carson-qfcopf`, which is `main`
  `6f52b57` plus that document).

## How to read the suite

The suite uses three labels, so that a green run never implies enforcement that does not exist:

| Label | Meaning | When it fails |
|---|---|---|
| `CURRENT GUARANTEE` | enforced today | a regression |
| `GAP x — CURRENT` | an accurate description of a shortfall. It passes because the description is right, not because anything is enforced. | when the gap is closed. The fixing checkpoint turns it into a `CURRENT GUARANTEE`. |
| `it.todo("DESIRED …")` | the guarantee the design wants and the code does not give | never. Reported as *todo*, never as a pass. |

Result: **62 passed, 8 todo.** Every todo is a desired guarantee that does not exist yet.

---

## 1. The ten invariants

| # | Invariant | Verdict | What proves it |
|---|---|---|---|
| 1 | `NEVER_AUTOMATIC` actions cannot enter automatic policy | **Holds** for the Secretary proposal layer | `validatePolicy()` rejects any policy naming a floor action, alone or mixed in with safe ones. `propose()` refuses to build under such a policy. Under a safe policy a floor action is never `automatic`. `floorDisagreements()` is empty. **Does not extend** to engine automation modes (Gap F). |
| 2 | `NEVER_AUTONOMOUS` cannot be autonomously requested or approved | **Holds** | All 6 keys × all 5 risk levels, under the widest context `decide()` accepts (every permission, online, compliance passing, on the auto-execute list, approval on file) → `deny`. The router fixes the actor as `agent`. The requester of a floor capability cannot approve it. A *person* may do the restricted thing, and only through `require_approval`. |
| 3 | Approval is bound to the exact payload and revision | **Payload: holds. Target and revision: do not hold on the production path** (Gap E) | `decide()` allows only the approved payload hash and re-asks for any other. `restricted` always asks. The server hashes the payload, never the caller. `decide()` returns `stale` on revision drift. `approvalCovers()` binds capability, target and payload, but has no production caller. |
| 4 | Retrieved documents, email and knowledge cannot grant execution authority | **Holds** | `external_content` and `workflow_data` → `deny` for every registered capability and every actor type, under the widest context. The router takes no `origin`. Document, outside-message and record blocks carrying instruction-shaped text have `mayInstruct = false`. A user's or regulator's statement of a rule routes to `discovery_queue` with review. Autonomous observations never reach a binding level. |
| 5 | Unknown or unregistered capabilities fail closed | **Holds** | Case and whitespace variants, a zero-width character, wildcards, concatenations, `__proto__` / `constructor` / `toString`, and invented self-escalation keys (`learning.promoteSkill`, `governance.amendConstitution`, `agent.grantCapability`) → `deny`. An empty registry allows nothing. Double registration throws. Unknown compliance → `compliance_block`. |
| 6 | Authority comes from server registration, not model text | **Holds** | For every capability under three contexts, `decide()` returns an identical decision whatever `reasoningSummary` or `evidenceRefs` say (4 adversarial summaries × 3 evidence sets). `ActionRequest` has no `riskLevel` field, and a compile-time `@ts-expect-error` pins that. The router input takes none of `riskLevel`, `requiredPermissions`, `heldPermissions`, `autoExecute`, `approvalForPayloadHash`, `compliance`, `actualRevision` or `tenantId`. The live auto-execute list is `[]`. Every capability names only real permissions. |
| 7 | Training admission is distinct from retrieval and use | **Holds within each function; the two functions disagree** (Gap G) | Over all 16 `AllowedUses` combinations, `train` is admitted iff `training` is. A training permission grants no other use, and the other uses grant no training. An unassessed licence permits nothing. `checkSourceGate` refuses `model_training` separately from `rag_ingestion`. The R-7 four-way data-use classes do not exist (todo). |
| 8 | Acting scope is not widened by AI-originated input | **Holds** for the agent runtime and context assembly | Every agent procedure derives tenant with `resolveActingScope(d, ctx.user.id)`, and none takes a `tenantId` input. Delegation comes from the session user. A context holding another organization's alias block throws `CrossTenantContext`. An unattributed block throws `UnattributedBlock`. |
| 9 | proposal → read-back → authorization → commit / provenance | **Holds** | A complete proposal refuses commit until the read-back is generated and then confirmed. Any field change after confirmation clears the read-back. Committed fields keep `source`, `precision`, `confidence` and `committedAt`, and a correction keeps `correctedFrom`. A rejected proposal never commits. The commit service authorizes the target write itself and writes a receipt. |
| 10 | Existing safety floors unchanged | **Holds**; pinned as ratchets per R-5 | Restrictive lists (`NEVER_AUTONOMOUS` 6, `NEVER_AUTOMATIC` 5, `FORBIDDEN_AI_OUTCOMES` 10) may grow and may not lose an entry. Permissive lists (`MAY_INSTRUCT` 4, `BINDING_LEVELS` 4, `AUTONOMOUS_ORIGINS` 2) may shrink and may not gain one. No registered capability or proposal action may become less risky or lose its required permission. A floor key in the registry must be `restricted`. |

---

## 2. Guarantees that already exist

1. An agent can never perform any of the six `NEVER_AUTONOMOUS` capabilities, at any risk level,
   under any context, and cannot ask as anything but an agent.
2. Content (documents, email, retrieved passages, record data) can never originate an action, and
   the agent runtime cannot claim a higher origin.
3. An unregistered capability is denied. So is anything resembling one. No default-allow path
   exists.
4. The model's words (`reasoningSummary`, `evidenceRefs`) cannot change a gateway decision.
5. An approval covers exactly one payload hash, and the server computes that hash.
6. Unknown compliance blocks. Unconfigured automation is `MANUAL`. An unassessed licence permits
   nothing.
7. Training is a separate permission from indexing, answering and quoting, in both the admission
   gate and the ingestion gate.
8. Tenant comes from the session. Model context cannot mix organizations or carry an
   unattributed block.
9. Nothing commits without a confirmed read-back of the exact current fields, and every committed
   field carries its provenance.
10. The safety floors cannot be silently weakened. Any removal fails the suite.

## 3. Expected guarantees that do NOT yet exist

| Gap | Current state (verified) | Desired | Fixing checkpoint |
|---|---|---|---|
| **A** | `FORBIDDEN_AI_OUTCOMES` is referenced by **no production module except the one that declares it**. The one live prose check, `detectOverreach()`, catches **3 of 10** outcomes in plain phrasings (`authorize_dispatch`, `certify_driver`, `declare_bridge_safe`). It misses `invent_hos_hours`, `declare_permit_unnecessary`, `clear_mechanical_defect`, `modify_payroll`, `finalize_invoice`, `alter_audit_record` and `issue_government_certificate`. The uncaught set is pinned as a ratchet: it may shrink, not grow. | every entry has a runtime consumer | AIL-3 |
| **B** | Capability `compliance.override` requires exactly `["billing.write"]`. That permission is held by **office, management and controller**. Agents are refused the capability regardless (Invariant 2), and the only production caller of `decide()` (`agent.requestAction`) always sets the actor to `agent`. So today the permission is never consulted. It would matter the moment a human path runs through the gateway. | a compliance override requires a compliance authority permission | AIL-2 or AIL-3. It changes a registered capability, so it takes its own ruling under R-5 (narrowing only). |
| **C** | `assistantProposals` and `proposalFields` have **no `tenantId` column**. `facilityAliases` has **none**. `agentRuns.tenantId` and `knowledgePassages.tenantId` are **nullable**. `LearningIntake` has **no tenant field** (pinned by a compile-time `@ts-expect-error`). | non-null tenant from acting scope on every AI proposal, alias and learning record (R-2) | **AIL-1** |
| **D** | `checkClaim()` is called only in `knowledge/admission.ts`. `classifyRequest()` and `routeLearning()` are called only in `knowledge/perimeter.ts`. The census declares `knowledge/perimeter` unwired. | the perimeter runs before every model call, and claims are checked before they reach a person | at wiring (AIL-9), under its own ruling |
| **E** *(new)* | The production agent path binds approval to **payload only**. `decide()` compares payload hashes. The router looks the approval up by **run + capability, not target**. The payload hash does not include the target. `approvalCovers()`, which does check the target, has **no production caller**. The router always passes `actualRevision = null`, so `stale` can never fire through the API. Consequence today: an approved payload can yield an `allow` *decision* for a different record in the same run. Nothing executes, so nothing is performed. | approval covers one capability, one target record, one target revision and one payload | AIL-2 (tool → capability binding touches this path). It is the R-8 zero-tolerance class "changed payload accepted under old approval", widened to target, and should be fixed before any executor exists. |
| **F** *(owner decision, not a defect)* | `NEVER_AUTOMATIC` governs Secretary proposals only. Engine automation modes (`automationPolicy.ts`) have **no ceilings**: `SAFETY_CEILINGS = {}` by owner decision P8.4. A tenant policy therefore resolves `hos` and `mechanic release` to `AUTO`. | P8.4 ceilings clamp the owner-classified capabilities | P8.4. The R-5 ruling allows the ceilings to be added as narrowing, but the list itself is P8.4's decision. |
| **G** *(new)* | Two functions answer "may we train on this source". `checkSourceGate("model_training")` also requires commercial reuse for a commercial product. `allowedUsesFrom()`, which feeds `admit()`, maps `training` from `model_training_authorized` alone. Verified: for a commercial source with training authorized and commercial reuse not, the gate refuses (`COMMERCIAL_USE_UNAUTHORIZED`) and `allowedUsesFrom().training` is `true`. Nothing trains today. | one answer, plus the R-7 four-way data-use classification | with R-7's data-use classes (AIL-4 / AIL-6) |

Gaps A–D are the four the design survey found. E and G were found while writing this suite. F is
the known P8.4 decision, recorded here because Invariant 1 would otherwise read as covering it.

Where testing an absence would have been dishonest, the suite does not claim more than it checks.
Gap D is a scan of production call sites plus the census entry, the same technique the census
itself uses. It does not claim that nothing *could* call these functions.

---

## 4. Verification

| Check | Result |
|---|---|
| `server/aiSafetyBoundary.test.ts` | 62 passed, 8 todo |
| Secretary / gateway / knowledge / context / proposal / automation / tenant suites (`actionGateway`, `secretaryCoordination`, `knowledgeAdmission`, `knowledgePerimeter`, `knowledgeSourceGate`, `knowledgeWritePaths`, `contextAssembly`, `contextAdmission`, `agentBoundary`, `agentRuntimeApi`, `_core/aiProposal`, `_core/automationPolicy`, `tenantIsolation`) | all pass |
| SPINE plan guard (`spineWiringPlan.test.ts`) | pass |
| Engine census (`engineReachability.test.ts`) | pass. Pin unchanged at 57. |
| `pnpm check` (production typecheck) | clean |
| Test-file typecheck (`tsconfig.tests.json`, gate pin 0) | 0 errors |
| Full `scripts/ci-gate.sh` against MariaDB 10.11 (the CI image) | see §5 |

## 5. Full repository gate

Run as `DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos bash scripts/ci-gate.sh` against a
disposable `mariadb:10.11` container, the same image CI uses.

| Gate | Result |
|---|---|
| 0 Reserved migration slots | pass |
| 1 Clean database | pass |
| 2 Migrations | pass |
| 3 Table parity | pass (410 / 410) |
| 4 Typecheck, and the test-file ratchet | pass, 0 test-file errors (ceiling 0) |
| 5 Bare `protectedProcedure` | pass (0) |
| 6 Test suite (database-backed) | **1 failure, pre-existing and unrelated**: 334 of 335 files passed; 4832 passed, 1 failed, 3 skipped, 8 todo. The database-backed agent suites ran: `agentBoundary` 14/14 and `agentRuntimeApi` 13 run, 3 skipped by the suite itself. No `.db.test.ts` suite skipped. |
| 7 Production build | pass (run by hand, because the script stops at gate 6) |
| 7b / 7c Portal and inbound gates | pass (36 external / 0 role; 2 integration / 0 role) |
| 8 Current-state document | regenerated by `scripts/current-state.sh`. Only the test-count row changes (319 / 4347 → 320 / 4409). Committed with this checkpoint, so the check is current. |

**The pre-existing failure.** `server/calendarFixtures.test.ts`, "every file with a near-future
fixture and a real clock read is reviewed, or has more than three weeks left", reports
`server/capitalAssets.test.ts: 2026-10-15, 2026-10-20, 2026-10-31 (21 day(s) until the first) —
unreviewed`. This is a clock tripwire: the real date (2026-09-24) has come within three weeks of
that file's fixtures. It fails identically with `server/aiSafetyBoundary.test.ts` removed. It is
unrelated to AI safety and was **not** fixed here. The remedy the guard names (make those fixtures
clock-relative, or record the file in `REVIEWED`) belongs in its own change.
