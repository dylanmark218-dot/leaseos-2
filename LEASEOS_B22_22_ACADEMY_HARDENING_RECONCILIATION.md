# LeaseOS B22.22 — Training Academy hardening + v7/v8 reconciliation

Status: **UNRELEASED** · 2026-09-11

## Purpose

This checkpoint closes the blocking defects identified in the 0087 Academy review and performs the §34 reconciliation that 0087 omitted. It does not claim the full repository gate has run in this sandbox.

## Regulated certificate hardening

### Server-owned certificate terms

`trainingAcademyRegulatory.ts` is now the canonical versioned issuance-rule layer. `TDG_ROAD` uses `REG-TDG-ROAD-V1`: road mode, 36 calendar months validity, and retention through 24 calendar months after expiry. A regulated/employer certificate cannot accept an absolute expiry from the caller. Company certificates may use a carrier-configured interval; that is a different boundary.

### Required TDG certificate content + two-party signature lifecycle

In addition to the two review blockers, the hardening pass checked the current Part 6 certificate contents. TDG issuance now snapshots the employee name, employer name, employer place-of-business address and the aspects of dangerous-goods work for which the employee is trained; those facts are included in the signed/hash-bound certificate payload. Missing required content blocks issuance.

A TDG employer certificate is created as `pending_signature`. The employer representative signature is captured at issuance and hashed against the certificate payload. The employee signs through the self-scoped `academy.certificateSignOwn` procedure. The certificate becomes `active` only after both required signatures and the required reasonable-grounds attestation are present. The learner UI exposes a clear `Sign & activate` action for pending certificates.

### Reasonable-grounds attestation

TDG issuance requires an explicit, non-defaulted attestation. The attestation is persisted on the certificate and included in the immutable payload/provenance chain. A green assessment button is not treated as the employer's judgment.

### Retention + statement of experience

Certificates now record `retentionUntil`. Migration `0087_training_academy_hardening.sql` installs a database `BEFORE DELETE` trigger that refuses deletion before that date. `academyStatementsOfExperience` records the employee, qualification, experience period, duties, optional DG scope, preparer, employer attestation, source certificate and payload hash; a statement can be attached to later issuance.

### Source tier

Academy source records now distinguish `authority`, `industry_association`, `vendor`, and `unknown`. Vendor and unknown tiers cannot satisfy the certificate source gate for employer/company certificate issuance. A reviewed source is therefore necessary but not sufficient.

### Foreign TDG road recognition

A dedicated recognition decision implements the US road-driver pathway and requires the 49 CFR 172.700–172.704 training statement, US issuing/vehicle-licence jurisdiction, current validity, and a **verified LeaseOS compliance document belonging to that user**. The recognized result is stored as an external credential; LeaseOS does not re-issue it as a LeaseOS TDG certificate.

## Reconciliation matrix

| v7/v8 capability | 0086/0087 equivalent | B22.22 canonical decision | Result |
|---|---|---|---|
| `complianceSecretary.ts` / `evaluateDangerousGoodsAssist()` | Academy TDG/ERG learning only | Operational AI Secretary and Academy are complementary | **PORTED** and exposed through `compliance.dangerousGoodsAssist` |
| NSC10 general WLL helper | Securement course only | Training does not replace calculation | **PORTED** as `compliance.securementAssist`; commodity-specific rule remains fail-closed |
| Alberta waste routing | TDG lesson only | Operational routing belongs in Secretary decision engine | **PORTED** with hazardous-waste / recyclable / in-province oilfield-waste branches |
| `driverTraining.ts` licence/Q/S/provincial gate | Generic Academy requirements | Driver-specific credential hierarchy is complementary to Academy requirements | **PORTED** and exposed through `compliance.driverQualification` |
| `complianceKnowledgeItems` | Academy source/course records | Source-backed field knowledge is a separate operational store | **PORTED** as a schema table and catalog sync target |
| `regulatedTrainingCatalog.ts` | `trainingAcademyCatalog.ts` | Duplicate training catalog would violate one-source-of-truth | **RETIRED**; Academy catalog is canonical. `driverTraining.ts` no longer imports it. |

The old engines were not copied blindly into the migration chain. Their operational logic was ported into the real 0086→0088 lineage, while the duplicate regulated course catalog was deliberately retired.

## Restored operational surfaces

The Compliance router now exposes source-backed knowledge lookup, the dangerous-goods AI Secretary, the general securement/WLL helper, and the Class 1/2/3 + Q/S + provincial-restriction qualification evaluator. These procedures use existing compliance/dispatch authorization rather than creating a second permission universe.

## Test expansion

`trainingAcademyHardening.test.ts` pins every named blocker in `certificateDecision()` and `directSupervisionDecision()`, plus TDG 36-month expiry, two-years-after-expiry retention, caller-expiry rejection, two-signature finalization, source-tier rules, month-end arithmetic and foreign-road recognition. The restored v8 Secretary and driver-qualification tests are also back on the current lineage.

## Still not a release claim

The full `pnpm test`, `pnpm build`, `scripts/ci-gate.sh`, all-migrations-on-disposable-MySQL, and DB-backed Academy end-to-end gate still require the normal repository dependency tree and database. The carrier must also formally decide which people are authorized to act as its employer representative for regulated certificate issuance; the software currently limits issuance to the existing Academy certificate-issuer permission but does not invent the carrier's governance policy.
