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

**Gate.** Recorded below from the run on this branch.

**Deliberately not in SA1.** See `SA1_OWNER_RULING.md`. In addition: the receipt is held on the artifact
row (canonical JSON, hashed) rather than in object storage, because storage is unconfigured in the gate
and the receipt is self-verifying by hash; the register row for a signed artifact waits for the PDF
artifact (SA3) and a Document Control definition for it; `evidenceAccessEvents` are not written for
receipt exports because a receipt has no evidence record yet — the export is an `artifact_exported` event
on the chain instead.
