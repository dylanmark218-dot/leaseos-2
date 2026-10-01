# Sign & Attest SA1 — the owner's instruction, and its limits

**Recorded 2026-10-01**, on branch `claude/leaseos-sign-attest-design-5993ar`, against `main` `c3f088b`
(release `v23.30`, migration head `0209`). This is the authority for the Sign & Attest code on this
branch. Read it before extending that code.

## What the owner said

The owner's checkpoint request (2026-09-23) ended:

> "After Claude returns that survey/design, the first implementation I would approve is the document
> revision + signable field + signing-event foundation, followed by the actual finger/stylus signature pad.
> That keeps the pretty drawing component from getting built on top of a weak audit model."

The design and plan were delivered (`docs/sign-attest/SIGN_ATTEST_DESIGN.md`,
`docs/sign-attest/SIGN_ATTEST_IMPLEMENTATION_PLAN.md`, commit `de481c2`), naming the SPINE moratorium as
owner decision **D-01** and SA1 as the first checkpoint. The owner's next instruction was **"Continue"**.
It is read, as the owner's own words above make explicit, as approval of SA1 — the foundation — and of
nothing after it.

## The moratorium, and why SA1 is built anyway

`docs/register/SPINE_WIRING_PLAN.md`: *"The moratorium stands: no new engines until this path is wired."*
Sign & Attest is a new engine. This ruling does **not** lift the moratorium; it is a narrow carve-out for
SA1 only, in the discipline of the two precedents — Document Control (`docs/document-control/
D00_MORATORIUM_DECISION_BRIEF.md`, 2026-09-24: "the spine's own paperwork has no record layer") and Live
Assist LA-1a (`docs/live-assist/LA1A_OWNER_RULING.md`, 2026-09-25: one bounded checkpoint, every module
reached from a mounted router). SA1 has the Document Control justification and not the Live Assist one:
it is **on the spine**. The on-spine `fieldTicket` close (`closeoutRouter.recordSignature`) is the first
and only producer in SA1, and what it fixes is the spine's own defect — a `drawn` signature that stored no
drawing and bound nothing (design §1.3).

## What SA1 authorizes, exhaustively

- Migrations `0214`–`0216`: `attestDocumentRevisions`, `attestFields`, `attestSigners`,
  `attestSigningSessions`, `attestMarks`, `attestArtifacts`, `attestEvents`; the append-only and
  finalized-immutable triggers; `fieldTicketSignatures.attestSessionRef`; two `evidenceRelationships`
  entity types.
- `shared/attest.ts` and the pure engines `attestBinding`, `attestState`, `attestPayload`.
- `attestService` (open, place fields, assign signer, submit, decline, finalize, void, supersede, view,
  list, verify, export receipt), `attestProof`, `attestProducers` (the field-ticket producer).
- `server/attestRouter.ts` (fourteen `roleProcedure`s) and four `externalProcedure`s in the portal.
- Eleven `attest.*` permissions and two `portal.attest.*` permissions.
- Tests, the inventory, the count pins, the register, the regenerated current-state document.

## What SA1 does NOT authorize

- the signature pad, stroke capture or any client UI (SA2);
- the offline session envelope and `attest.submitSession` for devices (SA2);
- templates, field layouts, PDF rendering of marks, overlay onto imported PDFs (SA3);
- saved signatures or initials and their adoption (SA4);
- academy, consent, approval or any producer other than the field-ticket close (SA4);
- any invoicing blocker, portfolio event, outbox consumer or notification (SA3/SA4);
- OCR or model-backed field discovery (post-moratorium);
- any widening of who may sign for whom. `attest.sign` is self-scoped; `attest.witness` places a named,
  account-less signer's mark and says "witnessed" on the row, the receipt and every event.

Each of those needs its own owner ruling. A change to the Sign & Attest files that reaches past the list
above should be refused in review.

## What was confirmed, and what remains the owner's

- `0214`–`0216` were the first numbers no branch held at the 2026-10-01 scan
  (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`); re-scan at the PR.
- D-02 (PDF renderer), D-04 (consent text; `CONSENT_TEXT_V1` is a LeaseOS sentence, tenant override
  later), D-05 (named witnessed signers: built, visible), D-07 (two-person supersede: built) are applied
  as the design recommended. D-03 (fractions) is applied. D-06 (saved marks) is deferred.
