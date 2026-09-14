# LeaseOS — v20.20 Checkpoint: P4 Secure Field Runtime (server half)

| | Previous | New |
|---|---|---|
| Version | v20.19 | **v20.20** |
| Tables | 150 | **153** (+3, `syncPackages` extended) |
| Migrations | 33 | **34** |
| Procedures (role-authorized) | 161 | **167** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 120 | **125** |
| Sensitive permissions | 38 | **40** |
| Universal permissions | 2 | **5** |
| Tests | 1,105 | **1,130** |
| Test files | 49 | **50** |
| Parity | 150/150 column-level | **153/153 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched. **P4 was not deferred a fourth time.**

---

## Why this, and not the insurance document

The Insurance & Risk specification is strong and I have inventoried the schema
for it as its first instruction requires — findings below. But its headline
feature, Roadside Document Mode, is an encrypted offline package on a device
that proves its identity on reconnection. That *is* P4. Building insurance
first would have meant building its best feature on nothing. It is v20.21.

**Insurance inventory:** no `insurance*`, `policy*`, `coverage*`,
`certificate*`, `broker*` or `insurer*` table exists. Touchpoints to reuse:
`complianceDocuments` / `complianceArtifacts` (generic compliance documents,
to be linked rather than duplicated), `subcontractors.insuranceExpiresAt` and
a free-text `operators.insurance` field (both to be superseded by structured
coverage, never silently dropped), `evidenceRelationships` (one certificate,
many entities — the pattern the document asks for already exists), and
`contractorSettlementLines.lineType = 'insurance'` (already separate from
fuel and freight). Everything else in the document's family list is
greenfield.

---

## What the server now holds a reconnecting tablet to

The specification's rule: *no connectivity should prevent synchronization,
not prevent work.* The device keeps capturing. On reconnection the server
decides whether to believe it, and every decision fails closed.

**Is this a device the company issued, in good standing?** `fieldDevices` is
server-issued identity. Enrolled → activated by the owning user → active.
Suspended, revoked, unknown, not-yet-activated, or enrolled to another user:
**refused before a byte of the payload is examined**, and the refusal is a
row in `syncPackages` with a reason — the office can see a revoked tablet
tried. A failed keystore attestation is not enrolled at all; software
attestation enrols and is recorded.

**Is it signing with a key we know, still valid?** The server holds only the
fingerprint of the public half — a query over the new tables confirms no
column could hold key material. Rotation retires the old key and records the
new; a package signed with a just-retired key is accepted inside a 72-hour
grace window and refused after it. A key the device never held is refused. A
key reported compromised is refused regardless of when.

**Does what it sent match what it sealed?** Three-way: declared (what the
device hashed at capture) must equal computed (what arrived), and both must
equal the seal on record. The test that matters: device and transit agree
with each other *and both disagree with the seal* — the seal wins, the item
is rejected. One rejected item fails the package. Rejections are receipts
with a reason, not warnings.

**Did the server change a record the device also changed?** `syncConflicts`.
Same base version: fast-forward. Different fields: merge. Same field, same
change: no conflict. Same *material* field, different values: a row holding
both versions, `unresolved`, for a person. Resolution records a decision
beside both versions — `bothVersionsRetained: true` — and the test reads the
losing value back after resolution. A device claiming a base the server never
reached: "refusing to guess".

**May it delete a local copy yet?** `planStoragePressure` deletes only
records that are office-accepted, hash-verified, past device retention and
not on legal hold — largest first. If that is not enough it reports how short
it is and that unsynced records **will not be deleted; synchronize to free
space.** It never widens the criteria.

**What may the roadside package contain?** An allowlist — registration,
insurance proof, inspection, permits, current HOS, shipping and TDG documents,
ERP — and a never-list — payroll, billing, premiums, claims reserves. The
device renders only what the server lists; possession of the tablet is not a
permission. The insurance tranche builds its Roadside Document Mode on this.

---

## Permissions

Enrolling, rotating and pushing from *your own* device read `ctx.user.id`
and nothing the request could name, so they joined the universal list — now
five entries, each self-scoped in code, each tested. Revoking a device and
resolving a conflict are not: `device.manage` is safety, management and
controller; `sync.resolve_conflict` is office and management. Both sensitive.

---

## What is NOT here, stated plainly

The encrypted SQLite, the encrypted file vault, the keystore, the camera and
GPS bindings, the durable local queue — all of that lives on the device and
cannot be built or tested in this container. This tranche is **the contract
the device is held to**: what it must prove, what happens when it cannot, and
what it may never do. The device-side implementation (Capacitor or
equivalent) targets these six procedures and these three rules.

Also deferred: per-record-type server version lookup. `receivePackage`
detects conflicts against a version registry the test seeds; wiring each
record type's real version column is mechanical and follows as each type
gains one.

---

## Files

**New:** `0035_secure_field_runtime.sql` · `fieldDevice.ts` · `deviceRouter.ts`
(6 procedures) · `fieldDevice.test.ts` (24)

**Changed:** `recordsAuthorization.ts` (5 permissions, 2 sensitive, 3
universal, 6 mapped) · `routers.ts` · `schema.ts` · drift guards · `ci-gate.sh`
· inventory

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative rule loaded.

---

## Exact next tranche

**v20.21 — Insurance & Risk Centre.** Now with something to stand on. Policy →
coverage → covered entities (one policy, fifty units, zero copies, via
`evidenceRelationships`); the six coverage statuses that keep
`document_missing` from being mistaken for `coverage_expired`; the dispatch
insurance gate with that distinction enforced; customer COI requirement
profiles matched against company coverage as MATCH / GAP / UNKNOWN; the
renewal calendar; claims linked to incidents with the driver's statement
preserved; and Roadside Document Mode on the P4 allowlist.
