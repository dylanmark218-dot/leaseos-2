# LeaseOS — Assistant wiring (engine → database → API)

**Status:** **316 tests across 15 engines**, all green. 74 tables · 15 migrations, parity verified.

Closes the gap flagged last pass: the proposal engine had tests and a UI but nothing between them.

---

## 1. What was built

| Piece | File |
|---|---|
| Extraction bridge — form → JSON Schema → typed values | `server/_core/assistantExtraction.ts` (24 tests) |
| Persistence | `formDefinitions`, `assistantProposals`, `proposalFields` + migration 0014 |
| DB helpers | `createAssistantProposal`, `listPendingProposals`, `replaceProposalFields`, … |
| API | `fieldRoute.assistant` router — draft, get, pending, answer, setStatus, readBack, acknowledge, commit, reject |

`invokeLLM`'s `outputSchema` — present since the first audit and unused until now — is what constrains
extraction. The model is handed one form's slot list and **cannot return a field the form doesn't
have**; `additionalProperties: false` at both levels, and `parseExtraction` drops anything undeclared
anyway. Two independent guards, because this one matters.

---

## 2. Precision is decided from the driver's words, not the model's opinion

The schema asks the model for `speakerHedged` — *did they qualify this?* — not *was this
approximate?* Those are different questions, and only the first is the model's to answer.

`looksHedged()` then combines two signals **pessimistically**: if the model reports a hedge **or**
the utterance matches `about / around / roughly / or so / give or take`, the value is approximate.
A model that decides "around ten" was probably exact is precisely the failure the provenance chain
exists to prevent, so it doesn't get that vote alone.

Tested both ways: a hedge in the words survives the model missing it, and no hedge is invented
where none exists.

---

## 3. The commit path is the only path

`assistant.commit` runs `checkCommit()` and returns **the specific outstanding items** rather than a
generic failure:

```
{ committed: false, refusals: [
    "Quantity is required and has no value",
    "Arrived is still marked approximate — confirm whether it is exact",
    "Read-back has not been confirmed" ] }
```

There is no other route from a proposal to an operational record. `readBack → acknowledge → commit`
must all succeed, and any edit in between clears the acknowledgement.

Model overreach is **stored, not discarded** — `assistantProposals.overreachFlags`. A model that
concluded something is worth a person seeing, and a pattern of it is worth more.

---

## 4. A correction to my own earlier audit

I reported in the first audit that `AIChatBox.tsx` *"calls `trpc.ai.chat`, an endpoint that does not
exist"* and carried it as Phase 0 item 5 ever since.

That was wrong. The string was a **code sample inside a markdown template literal** in
`ComponentShowcase.tsx` — documentation shown to a developer, never a live call. It would never have
thrown. I overstated it and repeated the overstatement across several checkpoints.

It's now updated to reference the real `assistant.draft` endpoint, so the sample is accurate rather
than aspirational.

---

## 5. Still outstanding

- **Voice capture is unwired.** `voiceTranscription.ts` still unused; `assistant.draft` takes a
  transcript string, so hooking it up is small.
- **Client not connected.** The router exists; `leaseos-assistant-app.html` is still a prototype
  with local state.
- **Offline queue.** `capturedOffline` is stored but nothing queues drafts locally yet.
- **Phase 0 remains open**: Prettier (lines to 11,259 chars), the `TripOperationsWorkspace.tsx(77,846)`
  type error, and green CI without a database.

The last one is now the biggest constraint. 13 tests can't run, the award transaction can't be
tested, and neither can the assistant router. **A disposable MySQL in CI unblocks all three at once.**
