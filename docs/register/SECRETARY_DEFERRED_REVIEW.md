# AI Secretary — deferred review findings

Recorded 2026-09-25, after #7 (the Secretary model layer) merged. These are review findings on
code now on `main`, each checked against the code rather than taken from the reviewer. None is
fixed here: the owner ruled that the main-recovery PR repairs only the three regressions that
turned `main` red, and that these become a later **Secretary adversarial-hardening checkpoint**.

Nothing below is reachable in production today — no router imports the model layer and the
extraction job is not dispatched (`workerBoundary.test.ts`). Each is a defect that goes live the
day the layer is wired, which is why the checkpoint belongs before wiring, not after.

## Confirmed

| # | Finding | Where | Why it matters |
|---|---|---|---|
| S1 | Injection suspicion never reaches the dialogue machine. `ValidationResult` carries no injection state and `advance()` receives no `InjectionScan`, so an injected narration whose fields validate cleanly reaches `READBACK` and then `PROPOSE`. | `ai/dialogue/machine.ts` `afterValidation` | The pipeline rule is that nothing advances while injection is suspected; the worker's `heldBecause` enforces it, the conversation does not. |
| S2 | `advance()` applies any event in any phase. `READBACK_CONFIRMED` from `LISTEN` goes straight to `PROPOSE`; `ANSWER` from `LISTEN` enters clarification without extraction or validation. | `ai/dialogue/machine.ts` `advance` | A caller (or a replayed/stale event) can skip every gate the machine exists to impose. |
| S3 | `assistant.passageList` needs `assistant.curate`, which the `driver` role does not hold. | `ai/tools/registry.ts` (read tool) | The tool is allowlisted for a driver-scoped caller and will always be refused. Fails closed. |
| S4 | `agent.requestAction` needs `agent.act`, which the `driver` role does not hold. | `ai/tools/registry.ts` (`human.requestAction`) | Same: always refused for the driver the layer runs as. Fails closed. |
| S5 | A value is not checked against its own quote. The normalizers take the model's value; the quote is checked only for presence in the transcript. "twelve thousand litres" quoted with `value: 9000` passes. | `ai/validate/validator.ts` | This is the silent-guess the validator exists to catch, moved from the quote to the value. |
| S6 | The model's `outOfScope` flag does not stop a proposal. `runExtraction` refuses only on the `OUT_OF_PERIMETER` pattern; when only the model says out of scope, the worker still calls `toProposal`. | `ai/extraction/runExtraction.ts`, `ai/worker/secretaryExtractionJob.ts` | Contradicts the documented no-proposal behaviour. The dialogue machine does refuse on it, so the two paths disagree. |
| S7 | The propose tools name `assistant.draft`, but the procedure is mounted at `fieldRoute.assistant.draft`. `planToolCall` walks `["assistant","draft"]`, which the real caller does not have. | `ai/tools/caller.ts`, `ai/tools/registry.ts` | `invokeTool` for any propose tool would throw at path resolution. The registry test checks the name against the permission map, not against the mounted router. |
| S8 | `human.requestAction`'s idempotency key is dropped. `planToolCall` adds `idempotencyKey` to every idempotent tool's input; `agent.requestAction`'s input schema does not declare it, so zod strips it and the router derives its own key. | `ai/tools/caller.ts`, `server/agentRouter.ts` | Harmless today, but the key the tool layer reports is not the one the server uses. |

## A design change, not a bug

**Quote matching became case-sensitive** in `60f8d90` (Copilot, under the review-thread
instruction). `collapse()` no longer lowercases, so a quote differing from the transcript only in
capitals is `BLOCKED` as fabricated. The previous behaviour folded case deliberately (speech-to-text
casing is arbitrary). Whether a case-only difference is a fabrication is an owner decision; the
golden set passes either way.

## Refuted

**"An inferred field skips the safety checks."** The `inferred` branch ends in `break`, not
`return`; control falls through to the format and cross-checks with every other field.

## Also live on `main` from #7, for the same checkpoint

- `assistant.draft` now accepts an optional `idempotencyKey` (`60f8d90`). It is a live-path change
  made under the SPINE moratorium. As written it is check-then-insert (a concurrent duplicate is
  caught only by the `proposalId` unique index, as an error rather than a replay), a key held by
  another user answers `FORBIDDEN` (which tells the caller the key exists), and a replay with the
  same key but different input returns the original proposal unchanged.
- The four `dispatchRole*.db.test.ts` suites also share one explicit-id window for units and
  operators (`1_400_000_000 + random(40_000_000)`), which `testIdBands` does not see — it guards
  user-id `seq` bands only. Low probability, same failure shape.

## Repaired by the main-recovery PR (not deferred)

The three regressions that turned `main` red after #7 — duplicated test user-id bands, the
`workerBoundary` false positive on hashing, and the idempotency key exceeding the 40-character
`assistant.draft` limit — are fixed in `claude/ai-secretary-main-regression-fix`.
