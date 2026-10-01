# Sign & Attest — implementation record

One record for the implementation checkpoints of `docs/sign-attest/SIGN_ATTEST_DESIGN.md`. Each section
names the SHA it was built on, the migrations it added, what it reused, what it tested, and what it
deliberately left out. Counts are read from the gate output, not written by hand.

Starting point: `main` = `c3f088b` (release `v23.30`, migration head `0209`); branch
`claude/leaseos-sign-attest-design-5993ar`, design commit `de481c2` (written against `6f52b57`).

**Baseline moved between design and build.** 328 commits landed on `main` in the week between: Document
Control A–C (`documentDefinitions`, the origin-aware register, `numberBlocks`/`numberAllocations`,
`documentControlEvents`), the mobile scanner (#78), SPINE item 2 (one signed-scope statement per
field-ticket signature; `openShifts` wired), the tenant-isolation security PRs, Live Assist LA-1a. The
design's survey remains correct in substance; three things changed in detail: the migration slots
(`0182`–`0184` → `0214`–`0216`), Document Control's events table and numbering ledger are now on `main`
(the design's "branch only" notes are history), and `fieldTicketSignatures` carries SPINE item 2's
single scope statement. Nothing in the entity model needed to change.

---

## Checkpoint SA1 — the drawn signature exists, is bound to a hash, and cannot be edited (0214–0216)

**Built on** `main` `c3f088b`, merged into the branch at `9e6b90c`.

**What it adds.** Seven tables (design §3): a signing revision that names a document revision and fixes
its fingerprint; fields in page fractions; signers by account, portal identity or witnessed name; one
session per act of signing with the authentication that proved it; marks bound by a payload hash to the
revision hash whatever the method; receipt artifacts; and a hash-chained, sequence-locked, append-only
event trail. Three guards: events may not be updated or deleted; a finalized revision may change only
to `superseded` and learn its successor. A persistent generated `finalizedKey` with a unique index makes
two finalized revisions of one instance collide in the database.

**What it reused.** `evidenceSeal.sha256`; `deviceSignature.canonical` (now exported as
`canonicalAttestPayload`) for everything a device signs; `checkSignatureAttestation` and `fieldDevices`
for device proof; `resolveActingScope` and the NULL-org rule for tenancy; `roleProcedure` /
`externalProcedure` with new permissions in the existing union, SENSITIVE and UNIVERSAL lists; the
domain-event outbox (`buildOutboxRow` into `domainEventOutbox` in the same transaction); the evidence
vault's relationship enum for stroke and render files; `auditPackage.canonicalJson` for the receipt; the
closeout router's own transaction as the producer boundary.

**Producer.** `closeoutRouter.recordSignature` writes the R1 revision first, opens a signing revision on
its `snapshotHash`, assigns the consultant (a portal identity, or a witnessed name), runs the one session,
and stores `attestSessionRef` on the signature row — all in one transaction with the signature and the
ticket's state. The closeout methods map honestly: `portal_link` → an acknowledgement under the portal
identity; `paper_scan` → a paper-scan mark naming the vault record; `drawn`/`pin`/`device_auth` → an
acknowledgement **witnessed** by the authenticated driver, because SA1 has no pad and records no drawing
it does not have. A `drawn` mark in Sign & Attest requires a sealed stroke record; the first one arrives
with SA2.

**What it tested** (`server/attest.db.test.ts`, `server/_core/attest/*.test.ts`, additions to
`siteCloseout.test.ts`): tenant isolation and cross-organization refusal (NOT_FOUND on view, open,
finalize, void, list); signer impersonation by another driver and by the office (rejected-session rows
with `WRONG_SIGNER`, field still pending); revision mismatch; a drawn mark without strokes; the payload
hash recomputed from the rows; a second completion refused; idempotent resubmission by `sessionRef`;
seven initials, a signature and an approval across three roles with an optional comment left pending;
finalize naming the missing field; concurrent finalization yielding one artifact; the proof's seven
acknowledged lines; export authorization and the receipt's contents; chain and receipt verification;
database refusal of edits to the finalized row and of edits or deletes to events; void and supersede
rules including the two-person rule and "nothing changed"; device attestation in both directions with a
real P-256 key and a tampered signature; the portal identity signing its own field and refused on
another identity's; the closeout producer's pointer. Pure suites cover the state machine, the binding
rules per subject type, the event chain (edited, removed, relinked), receipt determinism, the client
canonicalizer equivalence, and finger/stylus/mouse stroke serialization.

**Gate** (`scripts/ci-gate.sh`, run locally against MariaDB 10.11 on the pinned Node 22.23.3, 2026-10-01,
commit `d7316f5` plus the test fix in the follow-up commit): 189 migrations apply from an empty database;
table parity 436/436; `tsc --noEmit` clean; test-file type errors 0 (pinned ceiling 0); procedure census
clean; 443 test files / 6708 tests — 441 files green on the first full run, the two red ones being this
checkpoint's own `attest.db.test.ts` (an assertion that assumed which of two concurrent finalizers won;
now asserted against the row) and `commercialOffice.db.test.ts` P7.8 "reproducible manifest hash", which
touches nothing SA1 changed, passed on the two earlier full runs and on its re-run, and is a
pre-existing reproducibility flake; both green on re-run. Counts in `LEASEOS_CURRENT_STATE.md` are
regenerated: 436 tables, 189 migrations, 717 role-authorized procedures, 40 portal procedures, 382
permissions (148 sensitive, 15 universal).

**Deliberately not in SA1.** See `SA1_OWNER_RULING.md`. In addition: the receipt is held on the artifact
row (canonical JSON, hashed) rather than in object storage, because storage is unconfigured in the gate
and the receipt is self-verifying by hash; the register row for a signed artifact waits for the PDF
artifact (SA3) and a Document Control definition for it; `evidenceAccessEvents` are not written for
receipt exports because a receipt has no evidence record yet — the export is an `artifact_exported` event
on the chain instead.

---

## Checkpoint SA2 — the finger / stylus pad, and the session signed where there is no signal (no migration)

**Built on** `main` `240b2dd` (SA1 merged as #104 at `e1d8fd5`; #108 after it). Owner ruling:
`docs/sign-attest/SA2_OWNER_RULING.md`.

**What it adds.** One stroke engine shared by the pad, the device and the server
(`shared/attestStrokes.ts`): normalisation (samples closer than 0.5 px coalesce; coordinates never
rounded), a deterministic SVG renderer (Catmull-Rom → cubic Béziers, width from pressure when a pen
reported it, fixed number formatting, no raster) and PDF path operators for SA3. The pad
(`client/src/attest/SignaturePad.tsx` over `strokeCapture.ts`): Pointer Events with coalesced samples,
`pointerType` recorded as the input kind, pressure only from a pen, a captured pointer clamped into the
canvas, one kind of pointer per document, undo, clear; it draws into an SVG so the preview a signer sees
is the bytes the office keeps. The signing screen (`AttestSigningScreen.tsx`): one signer's pending
fields, a pad per drawn field, typed name, checkbox, approval, comment, the server's date; the consent
sentence beside the revision's fingerprint; Sign only when every required field is marked; decline with
a reason. The device runtime: `LocalSignableRevision` and `LocalAttestSession` on the `LocalStore`
(memory adapter and the test stores), `AttestSigning` (a drawn mark is two `signature` captures in the
encrypted vault — the stroke document and its render, both hashed — and the device key signs the
session at completion over exactly the object the server hashes), and the sync engine's second step: a
session is sent only after its mark files are on the server, as an envelope signed again at send time
with a fresh nonce, and the answer is a code the device acts on (a replay settles; a wrong clock holds
the queue with the instruction; everything else is retained as failed with the office's reason). The
server: `attest.submitSession` (`server/_core/attest/attestOffline.ts`) — exact-wire shape, device
admission (enrolled by the active organization, bound to the caller, active, keyed), envelope freshness
by the device's clock with the skew recorded, envelope signature, nonce, the inner signature with
whatever key the device held at completion and no ten-minute rule, then the sealed stroke bytes
re-parsed, re-assessed and re-rendered against the declared hashes, then SA1's service. Events written
from an offline session carry `clockSource = device`; the session row carries `deviceClockAt`,
`clockSkewMs`, `capturedOffline`. `preDepartureCache` lists a `signable_document` as needed on site.

**What it reused.** SA1's service unchanged in its rules (`submitSessionInTx` gained three recorded
facts and `recordRejectedSession` was lifted out of it); `sessionPayloadBytes` now canonicalises the
shared `sessionSigningObject`, so the device and the server build one object; `signatureFreshness`,
`verifyP256PackageSignature`, `deviceKeyEvents` for a key rotated between capture and sync,
`deviceSyncNonces` for the nonce; the evidence upload → seal → signed-package pipeline for the mark
files exactly as for a photograph (`clientCaptureRef` idempotency included); the universal
`attest.sign_own` for the envelope, with `attest.witness` checked in the handler for a witnessed
session; `handleSyncRefusal`'s shape for the device-facing handling.

**What it tested.** `server/attestOffline.db.test.ts`, through the router with the memory runtime: a
driver signs a field ticket offline (strokes, a typed name, the server's date), the marks sync first and
the session after in one pass, the rows name the device, the method, the skew and the device's time, the
mark names its sealed strokes and render, events say `device`, the office's view and `attest.verify`
agree, finalize and the receipt carry it; a duplicate sync answers `already_recorded` with no second row,
and the very same bytes replayed answer the same; two devices signing one field — first completes it,
second is a `FIELD_ALREADY_COMPLETED` row with both marks kept; voided while offline; the device revoked
between its marks' arrival and its session's (`DEVICE_NOT_ACTIVE`, no session row, the device stops);
a connection dropped before the envelope (back to queued), then a clock two days wrong
(`CLOCK_SKEW_TOO_LARGE`, held as queued with "stop and prompt", no row), then the fixed clock sending
the same session; a consultant's drawing witnessed on the driver's tablet; a mechanic refused
`AUTH_METHOD_INSUFFICIENT` as a row; a device that edits its session after signing it
(`SIGNATURE_INVALID`); a vault whose stored strokes are not the sealed ones (`MARK_HASH_MISMATCH`, field
still pending). `server/_core/attest/attestStrokes.test.ts`: normalisation, render determinism across key
order and across finger/pen, pressure runs, the dot, number formatting, PDF operators with y flipped, the
bytes check in every refusing shape, the pad's state (pen with pressure, finger without, unknown pointer,
mixing refused, clamping, undo, clear, byte-stable round trip), and a handling for every refusal code.
`client/src/attest/SignaturePad.dom.test.tsx`: synthetic pointer events for a pen, a finger and a mouse;
the words a signer reads; undo, clear and a cancelled stroke; the signing screen's gating of Sign on
required marks and consent, the marks it hands over, the decline that needs a reason, the non-signer
refused. `preDepartureCache.test.ts` gained the on-site item. Pins moved by one: 759 operational
procedures, 833 cross-layer paths, 402 in the inventory.

**Gate** (`scripts/ci-gate.sh`, run locally against MariaDB 10.11 on the pinned Node 22.23.3, 2026-10-01,
commit `dbd1810`): 194 migrations apply from an empty database (none new); table parity 451/451;
`tsc --noEmit` clean on both configs; procedure census clean; 464 test files / 6965 tests — 461 files
green, three red: `a11yCoverage` (the two new components had jsdom suites but were not yet run through
the axe rules — five surfaces added to `client/src/a11y/a11y.dom.test.tsx` in the follow-up commit, 177
cases green), `registerClaims` (the register said `preDepartureCache.test.ts` had 11 cases; it has 12 —
the register row now says so), and `documentValidityCanonical`'s census, which asserts that
`_core/openShifts.ts` does not import `./documentValidity` and fails identically on `main` at
`e1d8fd5` before any SA2 change (the import arrived with #59's merge of `main`); SA2 touches neither
file. Counts in `LEASEOS_CURRENT_STATE.md` are regenerated: 779 role-authorized procedures, 464 test
files.

**Deliberately not in SA2.** See `SA2_OWNER_RULING.md`. In addition: envelope-level refusals (device,
clock, key, nonce) are answered with codes and not written as session rows, because the handling asks
the device to fix itself and send the same session again, and a rejected row under that `sessionRef`
would refuse the retry — they remain visible in the authorization trail the gate writes; the server
re-reads stroke bytes only on the offline path, where the bytes arrived through the vault pipeline
(SA1's online `attest.sign` still checks the seal hash alone); a replaced drawn mark's vault files are
deleted and its capture rows stay as drafts that were never queued; the pad records no keyboard input
(a signer who cannot draw uses the typed-name or acknowledgement field the screen offers).
