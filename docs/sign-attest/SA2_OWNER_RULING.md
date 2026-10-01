# Sign & Attest SA2 — the owner's instruction, and its limits

**Recorded 2026-10-01**, on branch `claude/leaseos-sign-attest-design-5993ar`, against `main` `240b2dd`
(PR #108; SA1 merged at `e1d8fd5`, PR #104; migration head `0219`). Read `SA1_OWNER_RULING.md` first: it is the authority
for the foundation this checkpoint builds on, and its rule that each later checkpoint needs its own
ruling is why this file exists.

## What the owner said

The owner's checkpoint request (2026-09-23) named the order of implementation:

> "the first implementation I would approve is the document revision + signable field + signing-event
> foundation, **followed by the actual finger/stylus signature pad**. That keeps the pretty drawing
> component from getting built on top of a weak audit model."

SA1 — the foundation — was built, gated, reviewed and merged by the owner into `main` (#104). The
owner's next instruction was again **"Continue"**. It is read as approval of the second item in the
owner's own sentence: the pad, and with it the pieces without which a pad on a tablet is a drawing
nobody can file — the offline signing session and its synchronization (design §6, plan Checkpoint SA2).

## The moratorium, and why SA2 is built anyway

The SPINE moratorium stands (`docs/register/SPINE_WIRING_PLAN.md`). SA2 adds **no new engine and no
migration**: it completes the on-spine producer SA1 wired (`closeoutRouter.recordSignature`, the field
ticket close), whose `drawn` method still records no drawing because nothing could draw one. The
`preDepartureCache` engine gains an item kind and stays declared-unwired, as `engineReachability` pins.

## What SA2 authorizes, exhaustively

- `shared/attestStrokes.ts`: normalisation of a stroke document (coalescing points closer than
  0.5 px), the deterministic SVG renderer (one renderer for the pad's preview, the sealed render and
  the server's recomputation), PDF path operators for SA3, and the device-facing refusal handling.
- `client/src/attest/strokeCapture.ts` and `client/src/attest/SignaturePad.tsx`: pointer-event capture
  (`pointerType` → `inputKind`, coalesced events, pressure when the hardware reports it, DPR,
  orientation, clear and undo), drawing into an SVG so the preview is the evidence.
- `client/src/attest/AttestSigningScreen.tsx`: the signing screen a field worker uses — the fields
  assigned to one signer, a pad per drawn field, typed, checkbox, approval and comment marks, the
  consent sentence, decline with a reason.
- `client/src/runtime`: `LocalSignableRevision` and `LocalAttestSession` on the `LocalStore`, the
  offline signing flow (a drawn mark is two `signature` captures — strokes and render — in the encrypted
  vault; the session is signed by the device key at completion), and the sync engine's second step that
  sends a session envelope once its marks are synchronized.
- `attest.submitSession`: the device envelope — exact-wire verification, a fresh nonce, the envelope
  signature at send time and the session signature at completion time (not subject to the ten-minute
  rule), server-side recomputation of the render from the sealed stroke bytes, the §6.3 order, per-mark
  verdicts, refusal codes a device acts on. One `roleProcedure` under the universal `attest.sign_own`;
  a witnessed session additionally requires the caller to hold `attest.witness`.
- `preDepartureCache`: `CacheItemKind = "signable_document"`, necessity `required_on_site`.
- Tests, the inventory, the count pins, the implementation record.

## What SA2 does NOT authorize

- templates, field layouts, PDF rendering of marks into a finalized artifact, overlay onto imported
  PDFs (SA3; `toPdfPathOps` is provided for it and used by nothing yet);
- saved signatures or initials and their adoption (SA4);
- any producer other than the field-ticket close (SA4);
- the field-placement editor over a page image and the staff review screen (deferred; `attest.view`
  and `attest.list` serve them; the plan's SA2 row named them and this ruling leaves them out so the
  checkpoint stays the pad);
- an offline **decline**: a decline is sent through `attest.decline` when the device is online; the
  envelope carries completed sessions only;
- wiring `preDepartureCache` to a router (HS1);
- any widening of who may sign for whom. The offline envelope is accepted only from a device enrolled
  by the acting organization, bound to the calling user, for a signer row that names that user — or,
  for a witnessed signer, under the caller's own `attest.witness`.

## What was confirmed, and what remains the owner's

- No migration: `attestSigningSessions` already carries `deviceClockAt`, `clockSkewMs`,
  `capturedOffline` and `syncPackageId` from `0214`.
- D-03 (fractions) governs the pad: the stroke document records the field's box and the canvas size,
  so a mark re-renders at any scale.
- The plan's "two files on one capture" is implemented as **two captures** (strokes, render) because an
  evidence record holds one file and the seal pipeline is unchanged by that choice.
