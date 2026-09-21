# LeaseOS — v20.21 Checkpoint: Compliance Master Registry

| | Previous | New |
|---|---|---|
| Version | v20.20 | **v20.21** |
| Tables | 153 | **158** (+5, `complianceDocuments` extended) |
| Migrations | 34 | **35** |
| Procedures (role-authorized) | 167 | **176** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 125 | **133** |
| Sensitive permissions | 40 | **44** |
| Tests | 1,130 | **1,155** |
| Test files | 50 | **51** |
| Parity | 153/153 column-level | **158/158 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The document's closing rule, made the design

*Never hard-code "commercial driver needs X." The rule should say why X
applies, where, when, from which source, satisfied by which evidence.*

A requirement is now a rule row in `complianceRequirements`, mirroring
`taxRules` field for field: key, version, jurisdiction, an applicability
predicate, the document types that satisfy it, a renewal interval, a source
authority and URL, effective dates, and a verification status that defaults
to `unverified`.

**Every regulatory figure in the document is seeded as an unverified claim.**
Twelve-month abstracts, medical intervals by age band, three-year SFC and TDG
terms, the 24-hour inspection window, quarterly profile reviews, the 9–12
month new-carrier review — twenty-two rows, each naming the research summary
as its only source. Four applicability statements (the Alberta ELD position,
the SFC weight thresholds, IRP eligibility, inspection validity) are recorded
separately as unverified claims, not as rules. A test asserts every seed is
unverified, and that **a fully credentialed driver evaluated against the seeds
gets UNKNOWN** — the passport does not know what the law requires until a
person has checked.

Schema inventory came first, as the document instructs: `complianceDocuments`
already was a credential record — owner, type, expiry, verification, source —
and is extended rather than replaced. `operators` keeps its flat licence
fields; they are not dropped, and the structured credential supersedes them.

---

## The three rules, each held by a test

**An unverified requirement yields UNKNOWN, never met.** Perfect evidence
against an unverified rule is `requirement_unverified`. The passport verdict
is `unknown`, and unknown does not round up to review or ready — it is
outranked only by blocked.

**A missing document is not an expired credential.** Each requirement declares
`missingSeverity`. A proof-of-insurance nobody uploaded is `review` — "the
underlying credential may exist; office to obtain proof." A licence past its
expiry is `blocked` — "expired 3 day(s) ago." A licence nobody has seen is
`blocked` too, because it cannot be assumed. This is the insurance document's
six-status distinction, generalized to every family.

**Privacy is a projection.** A medical fitness credential is `privateDetail`
by construction. `compliance.private.read` is HR only. Dispatch calls
`medicalEligibility` and receives `{ eligible: yes | no | unknown, reviewDue }`
and nothing else — a test asserts the projection carries none of the fields
on the never-list. The credential row does not leave HR.

---

## What the registry does beyond evaluation

**Applicability is a predicate, not a Boolean.** `{ ageAtLeast: 45, ageAtMost:
65 }` selects the three-year medical band; a 30-year-old and a 70-year-old
get different rules from the same seed set. Jurisdiction, subject type, and
effective dates all gate. Superseded rules never apply.

**Loading a verified requirement is the act that lets a passport say READY.**
Controller-only, sensitive, and refused unless the source is verified and
names an authority — stored `unverified` otherwise, with a note saying why.
The previous version is superseded with an end date, never overwritten.

**Consent is the record; the abstract is evidence attached to it.** An
abstract request is permitted only under a signed, unwithdrawn, in-date
consent for that purpose. A background-check consent does not authorize an
abstract.

**Written programs are versioned.** Publishing v2 marks v1 superseded with a
forward pointer; the test reads v1 back afterward.

**The regulator's profile is reconciled, not filed.** Five inspections on the
Carrier Profile against three LeaseOS knows about is two unmatched external
events — returned as an exception to investigate, with the next quarterly
review computed.

**Trip inspection validity is computed.** Whether the previous driver's 05:42
inspection still covers the truck at noon is a number of hours, not a form.

**A job composes worst-wins.** Carrier, operator, unit, trailer. Unknown sits
above review. An absent passport is unknown.

---

## The end-to-end test, in one line each

Office records a licence → `needs_review`. Dispatch reads the passport →
**unknown** (seed unverified). Controller loads the requirement, verified,
from Alberta Transportation → passport **review** (evidence unverified).
Dispatch cannot verify; office does → **ready, 1 of 1**. Controller tries to
load a requirement as verified from "someone said" → stored unverified. HR
records a medical as private; dispatch sees `eligible: unknown` and no title.

---

## Insurance, folded in

`insurance` is a family here, with `ab.unit.insurance_proof` seeded at
`missingSeverity: review` — the exact distinction the insurance document
asked for. The policy → coverage → covered-entities model, COI requirement
matching and claims are still to build; their status ladder now exists once
rather than twice.

---

## Files

**New:** `0036_compliance_master_registry.sql` · `compliancePassport.ts` ·
`complianceRequirementSeeds.ts` · `complianceRouter.ts` (9 procedures) ·
`compliancePassport.test.ts` (24)

**Changed:** `recordsAuthorization.ts` (8 permissions, 4 sensitive, 9 mapped)
· `routers.ts` · `schema.ts` · drift guards · `ci-gate.sh` · inventory

---

## Genuine blockers

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9 — now with a fourth family.** No authoritative tax, HOS, retention,
funding **or compliance** rule loaded. Twenty-two compliance requirements
await verification against Alberta Transportation, Transport Canada, CRA and
WCB. The loading path exists and is controller-only. Every passport on the
seeds is UNKNOWN, correctly.

---

## Exact next tranche

**v20.22 — Insurance & Risk, on the registry.** Policies, coverages and
covered entities via `evidenceRelationships`; customer COI requirement
profiles matched to company coverage as MATCH / GAP / UNKNOWN; the renewal
calendar; claims linked to incidents with the driver's statement preserved and
insurance receivable kept separate from the repair expense; Roadside Document
Mode on the P4 allowlist. The passport family it feeds already exists.
