# AI Secretary — the model layer

The extraction contract, the deterministic validator, the dialogue loop, the agent tools and the
injection guard, for one form: the load/unload event. HYBRID only.

Both checkpoints in one branch, because the survey found that checkpoint 1 was **not merged**:
there was no `server/ai/` in either repository. Checkpoint 2's prerequisite said to stop and report
if so. What follows is that report, then what was built on top of it.

---

## 1. Survey — what was already there

| Asked for | What the repository actually has |
|---|---|
| The AI proposal engine | `server/_core/aiProposal.ts` (700 lines). `Proposal`, `ProposedField`, `FORMS`, `buildProposal`, `commitProposal`, `detectOverreach`. |
| The Secretary wiring | `server/_core/secretaryCoordination.ts` (the never-automatic floor), `server/_core/actionGateway.ts` (capability registry, risk ladder, instruction-authority ranking), `server/_core/assistantCommitService.ts` (transactional typed commit). |
| What it calls for "AI" | `server/_core/llm.ts` → chat completions; `server/_core/assistantExtraction.ts` → form-to-JSON-Schema plus an inline system prompt; `server/_core/modelGateway.ts` → task-to-provider routing with a licence gate. |
| The proposal + provenance shapes | `assistantProposals` and `proposalFields` in `drizzle/schema.ts`. Provenance is `source` (7 values) × `precision` (exact/approximate) × `status` (proposed/confirmed/rejected/corrected), plus `sourceUtterance` and `correctedFrom`. |
| The load/unload schema | `FORMS.unload_stop` in `aiProposal.ts`, version 1, eight slots. |
| zod version | **4.1.12** — `z.toJSONSchema()` is available and is what the derivation uses. |

### Nine things that contradict the plan as written

**1. Checkpoint 1 was not merged.** No `server/ai/` anywhere. Both checkpoints are in this branch.

**2. `server/_core/llm.ts` is not model-agnostic.** Its base URL defaults to a hard-coded vendor
host and its key comes from `BUILT_IN_FORGE_API_KEY`. The plan's "no keys or model names
hard-coded" is already violated there. It was **left untouched** — surfaces are built on it — and
`server/ai/llm/` is a second, narrower door with no default endpoint at all.

**3. There are no zod validators for this form to generate a JSON Schema from.** The plan said to
generate from "the existing zod validators". The form's shape lives in `FORMS.unload_stop` as a
`FormDefinition`; the tRPC layer validates the *commit* payload, not the form. Writing a zod object
for the form would have created exactly the hand-maintained parallel description the instruction
forbids. The derivation therefore runs **the other way** and keeps the single source:

    FORMS.unload_stop  →  zod schema  →  JSON Schema for the model

**4. The extraction contract already existed in a different shape.**
`assistantExtraction.ts` asks for `{ value, sourceUtterance, speakerHedged, confidence }`.
`ExtractedField` is `{ value, status, evidenceQuote, evidenceRef, alternatives }`. It is a **wire**
shape, not a second stored one: `server/ai/proposal/bridge.ts` maps every field of it onto
`ProposedField`, so there is still one persisted shape and one provenance chain.

**5. There is no `load_stop` form.** Only `unload_stop`. That is the one form.

**6. `unload_stop` has no ticket-number field.** `disposal_ticket` calls it `facilityTicketNumber`.
The ticket normalizer keys on a set of both names rather than one hard-coded key.

**7. `units` has no tank capacity column.** `capacityLitres` in the schema belongs to
`bulkFuelTanks` — a fuel depot, not a vacuum tank. So the over-capacity check reports
`NOT_EVALUATED` whenever a capacity is not supplied in the context pack, and never a pass against a
ceiling nobody configured. **This is a real data gap**, not a coding choice: to make the BLOCKED
rule bite in production, `units` needs a capacity column.

**8. The automation-policy resolver already exists.** The plan said proposals should land pending
"until the automation-policy resolver exists". `server/_core/automationPolicy.ts` (P8.2, 2026-09-18)
resolves modes with a dominance rule. Proposals carry `ceiling: "HYBRID"`, which that resolver may
narrow to MANUAL and may never widen.

**9. There is no Exception Centre in the code.** `injectionSuspected` and the blocked verdicts are
stored **on the proposal**; anything deriving an exception item reads that state. Exceptions stay
derived, never stored, per the checkpoint.

### One more, and it is the important one

**`docs/register/SPINE_WIRING_PLAN.md` declares a moratorium** — *"no new engines until this path is
wired"* — and places 55 declared-unwired engines against the one-driver-one-job spine. This
checkpoint adds a new engine. That is a direct conflict and it is the owner's call, not this
branch's. Two things were done to keep the conflict small rather than to argue it away:

- **Nothing is wired into a live path.** `server/ai/workerBoundary.test.ts` proves no router
  imports the model layer, and its last test asserts that `productionWorker.ts` does **not** yet
  dispatch the extraction event. The gap is recorded rather than implied.
- **Nothing was reimplemented.** The verdicts reuse `actionGateway`'s vocabulary, the hedge
  detector is `assistantExtraction.looksHedged`, the LSD parser is `legalLocation` over `dls.ts`,
  the proposal is `aiProposal.buildProposal`.

If the moratorium is meant to bind this work too, the branch should sit unmerged until the spine is
wired. It is a branch, and it does not merge itself.

---

## 2. What was built

```
server/ai/
  llm/           provider.ts  config.ts  mockProvider.ts  openAiCompatibleProvider.ts
  prompts/       secretary-extract.v1.md  index.ts
  extraction/    contract.ts  formSchema.ts  runExtraction.ts
  validate/      normalizers.ts  validator.ts  questions.ts
  context/       contextPack.ts
  dialogue/      machine.ts
  tools/         registry.ts
  injection/     guard.ts
  proposal/      bridge.ts
  worker/        secretaryExtractionJob.ts
  eval/          goldenSet.ts  scoreCase.ts  runEval.ts
  __fixtures__/narrations/   12 cases
```

### The equation, and the rule under it

    autoEligible(field) =
        quoteIsInTranscript ∧ sttConfidence(quote) ≥ θ ∧ formatValid
      ∧ crossCheckAgrees ∧ policyAllows(AUTO)

A false term is `REVIEW`. A hard-rule breach is `BLOCKED`. **A missing term is never true** — it is
`NOT_EVALUATED`, and `NOT_EVALUATED` does not conjoin to `PASS`.

Two absences are kept apart, the same distinction `automationPolicy.ts` draws between an
unlicensed capability and an unconfigured one:

- **No transcriber at the call** — Phase 1 is a typed transcript. Typed words carry no
  transcription risk, so the STT term is *not applicable* and is left out of the conjunction. It is
  a check with no subject, not a check that failed to run.
- **A transcriber that reports nothing for a span** — there was audio and the confidence is
  missing. That is `NOT_EVALUATED`, and the field never reaches `PASS` on it.

Collapsing those would mean either a typed transcript can never pass anything, or a transcriber
that silently stops reporting probabilities looks like a keyboard.

### The hallucination tripwire

A `stated` field whose `evidenceQuote` is not a verbatim substring of the transcript is `BLOCKED`,
never `REVIEW` — a value the driver did not say is not something to confirm — and the field is
dropped from the proposal while the verdict survives, so a person can see what happened. The count
of those is the **silent-guess** metric, pinned at zero across the golden set.

The only relaxation is whitespace collapsing. No case folding beyond that, no punctuation
stripping, no similarity score: a nearly-right quote is the thing being guarded against.

### Two ordering decisions worth recording

- **Clarification excludes `NOT_EVALUATED`.** "No tank capacity is on file" and "you did not
  mention an optional field" both keep a field off `PASS` and neither is answerable by the driver.
  Queuing them is how somebody answers three questions to fix the one that mattered.
- **Stakes first, severity second.** Severity-first reads safer and is wrong here: a missing
  optional-looking field outranking the volume that bills a customer is the wrong question to spend
  the driver's one answer on.

### Injection

The transcript is fenced in long, unguessable delimiters that the content cannot close, and
labelled as data. The scan is an independent witness to the model's own `injectionSuspected` flag
and the two combine pessimistically — the model is the thing being attacked, so it cannot be the
only witness. A suspicion is stored on the proposal and **nothing advances while it is set**.

The scan is a tripwire, not a filter. The actual defence is architectural: the registry has no
commit tool, no delete, no payment, no permission or mode change, and no outbound email or web. The
dangerous combination is private data plus untrusted text plus a way to send something out; the
third leg is simply absent, so the worst an injection achieves is a proposal a human declines.

### Agent tools

Thin wrappers over a tRPC server-side caller built with the **driver's** context. No service
account, so there is no powerful identity to be tricked into borrowing. One tool, one procedure,
chosen in advance — nothing dispatches on a string. Per-task allowlists, a step budget, and an
idempotency key derived from the **device's own capture id** so an offline replay proposes once.

### The context perimeter

`contextPack.ts` imports nothing at all, which is the strongest form of the rule: a module with no
imports cannot reach the restricted vault or a medical record by any route, including one added
later through a helper. `contextPerimeter.test.ts` asserts that, asserts the module names no
restricted table, and asserts that `EligibilityAnswer` is three values with nowhere to put a reason.

---

## 3. Gate results

Run on this branch, without a database — MariaDB is not installable in this container, so gates 1,
2, 3 and the database-backed half of 6 **did not run here**. CI runs the full `scripts/ci-gate.sh`
against MariaDB 10.11.

| Gate | Result |
|---|---|
| 0. Reserved migration slots | pass — 0016/0017 unoccupied |
| 1–3. Clean DB, migrations, parity | **not run locally** (no MariaDB) |
| 4. Typecheck | pass — `tsc --noEmit` clean |
| 4b. Test-file typecheck ratchet | pass — 0 errors, ceiling 0 |
| 5. Bare `protectedProcedure` | pass — 0 |
| 6. Test suite | 3481 passed, 14 failed, 858 skipped. **All 14 failures are pre-existing**: `server/fieldroute.test.ts` needs a database and does not gate on `DATABASE_URL`. Verified by running that file on an untouched checkout, where the same 14 fail. |
| 7. Production build | pass |
| 7b/7c. Portal and inbound gates | pass — 36 external, 0 role in portal; 2 integration, 0 role/external in inbound |
| 8. Current-state document | pass, and **the generator was fixed** (below) |

### One fix outside the plan's scope, and why it was necessary

`scripts/current-state.sh` counted tests with `server/*.test.ts server/_core/*.test.ts` — one level
deep each — while vitest's include is `server/**/*.test.ts`. The first suite in a deeper directory
would have run in CI and been **absent from the document's count**, which is precisely the shape of
false claim gate 8 exists to catch. The counter now enumerates what the runner enumerates:
296 / 3989 → **307 / 4132**.

---

## 4. What is not done

- **Not wired.** No router or worker dispatches the extraction event; the capture surface that
  would emit it does not exist. Recorded as a test, not left to be noticed.
- **No audio.** Phase 1 is a typed transcript, as the checkpoint specified. `SttConfidence` is the
  seam whisper.cpp plugs into.
- **The golden set is synthetic.** Twelve cases written to the checkpoint's list. Real narrations
  from real shifts, with consent, are the next thing it needs — along with cab noise, two voices
  and lease nicknames.
- **`units` needs a tank capacity column** before the over-capacity BLOCKED rule can bite.
- **The moratorium question is open**, per section 1.
