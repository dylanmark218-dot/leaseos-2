# LeaseOS — Assistant: typed proposals + agent workspace

**Status:** engine built and tested. **292 tests across 14 engines**, all green.
**Integrates:** the uploaded `AIChatBox-redesign.tsx`, verified against the real call site.

---

## 1. What "more direct, like Base44 / Manus" was read as

**Agent workspace, not chat.** The pattern those tools established is that the agent shows its
plan while it works, its steps are inspectable, its output is a typed artifact you act on in place,
and you can steer mid-task.

That maps onto LeaseOS's existing chain almost exactly — propose → show evidence → confirm →
commit. The assistant saying *"I filled 5 fields, 2 need you"* **is** an agent task with visible
steps and a reviewable artifact.

So the Assistant view is not a message list. It's:

```
Plan (what it's doing)  →  Utterance (what you actually said)
      →  Artifact (typed proposal, field by field)  →  Gate (why it can't save yet)
```

If that reading is wrong, the correction is cheap — the engine underneath is independent of how
it's presented.

---

## 2. The engine is the point

The other pass said it plainly and was right:

> The next part I would build is more important than adding prettier chat bubbles.

`server/_core/aiProposal.ts` — 31 tests. This is the AI Secretary engine that has been marked
missing since the first audit.

**A sentence does not become a record. It becomes a typed proposal.**

| Rule | How it's enforced |
|---|---|
| "Around ten" stays approximate | Voice values default to `precision: "approximate"`; a test asserts `10:00` + approximate, never `10:00:00` exact |
| Precision-sensitive fields must be resolved | `precisionSensitive` on times and quantities raises a `precision_unresolved` gap that blocks commit |
| Extraction is schema-constrained | Values for undeclared fields are dropped, not stored as stray attributes |
| Fewest questions possible | `minimumQuestions()` orders required → precision → low-confidence, dedupes, caps at 3 |
| Read-back before commit | `checkCommit()` refuses without a generated **and** acknowledged read-back |
| Any edit invalidates the read-back | `refresh()` clears it — you can't confirm one version and save another |
| Corrections keep the original | `correctedFrom` retains the prior value; source becomes `human_corrected` |
| Rejected fields never commit | Filtered out in `commitProposal()` |
| The assistant records, never diagnoses | `defect_report` has an `observation` field and **no** `diagnosis` or `cause` field — there is nowhere to put one |

`detectOverreach()` flags the assistant asserting things it has no standing to assert — "is safe to
dispatch", "you may legally depart", "the problem is". Recording and proposing pass; concluding
does not.

---

## 3. Read-back speaks approximations as approximations

```
Unload stop on TRIP-2026-004821: arrived about 10:00, wait 8 min,
delay reason Scale delay, unloading started 10:15,
unloading complete 10:40, quantity 8000. Is that right?
```

"About 10:00" is spoken as *about*. That is the entire point of saying it out loud — a read-back
that flattens hedges is worse than none, because it launders an approximation into apparent
certainty.

---

## 4. On the uploaded work

**Kept:** the API is genuinely backward-compatible — `messages` + `onSendMessage` required,
everything new optional, named export matching the existing `ComponentShowcase` import. I dropped
it into the trunk and typechecked: **clean against the real call site**, only the tracked
pre-existing error remains. That's the check the other pass couldn't run without `node_modules`.

**Agreed with:** *LeaseOS Assistant* over *AI Secretary*. Drafts-only trust language in the header.
Review count as an operational state rather than something buried in chat.

**Went further on:** the review queue shows everything awaiting a person **from every source** —
voice, GPS, photo — not just this conversation. A driver has one queue, not three.

---

## 5. Not done

- The engine has no persistence yet — `formDefinitions`, `proposals`, `proposedFields` tables.
- `llm.ts` is not wired to it. Its `outputSchema` support is exactly the mechanism for
  schema-constrained extraction and remains unused.
- Voice capture sheet still unbuilt; `voiceTranscription.ts` still unused.
- The agent workspace is desktop and phone. In-cab tablet still deserves its own pass.

---

## 6. Status

| Engine | Tests |
|---|---|
| geofence · tracking · billing · fieldTicket · disposalReconciliation · taxonomy | 94 |
| routingCompiler · routeEvaluation · dataIngestion | 62 |
| dispatchMatching · dispatchReadiness · dispatchAward · dispatchLifecycle | 105 |
| **aiProposal** | **31** |
| **Total** | **292** |

71 tables · 14 migrations. Typecheck: 1 pre-existing error (Phase 0 item 3).
Full suite: 13 failures, all `server/fieldroute.test.ts`, all needing `DATABASE_URL`.
