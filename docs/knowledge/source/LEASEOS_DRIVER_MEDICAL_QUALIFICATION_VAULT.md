# LeaseOS / FieldRoute — Driver Medical & Qualification Vault Architecture

**Spec ID:** LEASEOS_DRIVER_MEDICAL_QUALIFICATION_VAULT
**Version:** 1.0
**Owner decisions captured:** 2026-09-17
**Companion to:** `LEASEOS_RESTRICTED_RECORDS_VAULT` v1.0
**Slots into:** Master Programming Manifest V8 §5 (Operator identity and qualification system)
**Policy interfaces:** Book 12 (Audit/Records), Book 13 (Occupational Health / fit-for-duty), Book 14 (Occupational Health & Industrial Hygiene), Book 16 (HR — `accommodation_cases`, `functional_work_restrictions`), Book 17 (Privacy/Security/IAM), Book 26 (Journey Management), Book 27 (Camp — medication storage), Book 30 (Insurance), Book 39 (WCB/RTW), Book 48 (Fatigue), Book 50 (Respirator fit, confined space)

---

## 0. Why this is a separate spec

`LEASEOS_RESTRICTED_RECORDS_VAULT` assumes **the company owns the record and administration can break-glass into it**. That is correct for incidents, investigations, and claims.

It is **wrong** for a driver's own medical documents, and building both in one subsystem risks somebody inheriting the wrong default. Here the custody model inverts:

| | Company Restricted Vault | Driver Medical Vault |
|---|---|---|
| Custodian | Company | **Driver** |
| Default company read | Admin, behind break-glass | **None — not even by break-glass** |
| Created by | Company processes | **Driver upload, or required submission** |
| Company obligation to hold | Yes | **Only the administratively required subset** |
| Subject to company legal hold | Yes | **Only the disclosed subset** |
| Opt-in | No | **Yes, outside the required subset** |

**Shared, reused unchanged from the companion spec:** the Book 17 sensitivity tier enum, the purpose-bound grant and audit-event tables, the `disclosureCrossings` model, retention/legal-hold rules, offline restricted-payload handling, and category-neutral tracking numbers.

**Deliberately not shared:** administrative break-glass. There is no admin path into driver-custodied medical content. Section 6 defines the single narrow exception, and it is driver-authored and driver-scoped.

---

## 1. The problem this design exists to solve

Dylan's framing — drivers upload anything pertaining to compliance, safety, fit for duty, or ability to undergo certain tasks — is genuinely useful. But a naive implementation creates three problems that are worse than not having the feature.

**1. Voluntary disclosure can create constructive knowledge.**
If a driver uploads a prescription for a sedating medication into a company-readable store, the company now holds that information. Whether anyone opened it or not. If that driver is later assigned a night run and there is a collision, the company's position is materially worse than if it had never held the document. Holding unread safety-relevant information is not a neutral act.

**2. It manufactures discoverable records.**
Medical documents the company was never required to hold become company records — subject to legal hold, subject to production in litigation, subject to insurer requests, and subject to a breach-notification obligation if the store is compromised. The driver who uploaded a specialist letter to keep it handy did not intend to hand it to a plaintiff's lawyer.

**3. It probably exceeds PIPA reasonableness.**
Alberta PIPA limits collection to what is reasonable for the stated purpose (Book 17 PRV-GOV-001, PRV-MIN-001). "The employee volunteered it" is not by itself a purpose. Collecting a full prescription list because a driver offered it is difficult to defend as reasonably required for employment management.

**The design answer: driver-custodied by default, company-readable only by explicit, scoped, purpose-bound disclosure.** The feature's actual value — a driver having their medical card, abstract, and certificates on their phone offline at a roadside inspection — is delivered entirely by driver custody. It does not require the company to read anything.

> **Flag for counsel.** The constructive-knowledge and discoverability points above are design risks, not legal conclusions. Before this subsystem is enabled in production, legal review should confirm the custody boundary, the required-vs-optional split, and whether a driver-custodied store hosted on company infrastructure is a company record in the relevant jurisdictions. Do not ship on this spec's reasoning alone.

---

## 2. Three-layer separation

Everything in this subsystem resolves to exactly one of three layers. Layer assignment is stored, server-side, and never inferred at read time.

```
LAYER 1 — LICENCE & QUALIFICATION FACTS          tier: CONFIDENTIAL
  Administratively required. Not opt-in.
  Licence class, number, expiry, endorsements, CONDITION CODES,
  abstract record, certification expiries, medical certificate
  VALIDITY (fact and date — not contents).
  → Company-held. Feeds the dispatch gate directly.

LAYER 2 — FITNESS & TASK CLEARANCE               tier: CONFIDENTIAL
  Derived determinations authored by an authorized human.
  FIT / FIT_WITH_LIMITATIONS / ASSESSMENT_REQUIRED /
  TEMP_UNFIT / MEDICAL_REVIEW / UNKNOWN  (Book 13's enum — reuse it)
  Functional restrictions, task clearances, accommodation status.
  → Company-held. What dispatch and scheduling actually consume.

LAYER 3 — MEDICAL CONTENT                        tier: HIGHLY_RESTRICTED
  Prescriptions, diagnoses, specialist letters, treatment records,
  the medical examination form itself, driver's own uploads.
  → DRIVER-CUSTODIED. Opt-in. Company cannot read by default.
```

The boundary between Layer 2 and Layer 3 is the one that matters. Book 13, Book 16, Book 30, Book 39 and Book 48 all already say the same thing in their own words — dispatch and scheduling get the restriction, not the reason. The Emergency Health layer states it plainly: fit-for-work is status, not diagnosis. This spec enforces it as a storage boundary rather than a convention.

**A Layer 3 document never becomes a Layer 2 determination automatically.** An authorized human in an occupational-health or designated-custodian role reads the document under a disclosure and authors the determination. AI does not derive fitness from a medical document, ever — that would be AI certifying vehicle/worker safety, which architecture rule 13 prohibits outright.

---

## 3. Layer 1 — Licence conditions and the dispatch gate

This is where Dylan's glasses and automatic-transmission examples live, and it is worth being precise: **a licence condition code is not medical information.** It is a licence-validity fact printed on the licence and appearing on the driver abstract. It is verifiable from an authoritative source, it is operationally necessary, and it is not opt-in.

The *medical reason* a condition code exists is Layer 3. The code itself is Layer 1.

```
"Driver's licence carries a corrective-lenses condition"     → Layer 1
"Driver's optometry report and prescription"                 → Layer 3

"Driver's licence is restricted to automatic transmission"   → Layer 1
"Why the driver tested in an automatic"                      → not collected at all
```

### 3.1 Condition codes are loaded data — [VERIFY DATA]

Do not hard-code a condition-code table. Codes, their letters/numbers, and their meanings differ by issuing authority and change over time. Per architecture rule 10, each jurisdiction gets a source-versioned profile carrying authority, source reference, effective date, version, and `lastVerifiedAt`.

An unrecognised condition code must resolve to `UNKNOWN` and route to review. It must never resolve to "no restriction." An unparsed code on an abstract is exactly the case where `UNKNOWN != CLEAR` earns its keep.

### 3.2 Dispatch behaviour

Condition codes divide into two operational classes:

**Hard constraints — block the assignment.** These are equipment or scope mismatches the system can evaluate deterministically.

```json
{
  "decision": "BLOCKED",
  "code": "LICENCE_CONDITION_EQUIPMENT_MISMATCH",
  "subject": "OPERATOR_144 / UNIT_217",
  "reason": "Operator licence is restricted to automatic transmission; Unit 217 is manual.",
  "policy": "QUAL-COND-001@1.0",
  "authority": "AB_LICENCE_CONDITION_PROFILE@2026-01",
  "evidence": ["ABSTRACT-144-2026-03", "UNIT-217-CONFIG"],
  "effectiveAt": "2026-09-17T08:14:00-06:00"
}
```

That is the named blocker the manifest asks for — `BLOCKED — operator restricted to automatic transmission` rather than `Not ready`.

**Soft constraints — surface, do not block.** A corrective-lenses condition does not stop dispatch. It becomes a pre-trip checklist item and an inspection-readiness prompt. The driver confirms compliance; the system records the confirmation as a driver-stated fact with provenance, not as verification.

**Unknown constraints — review.** Unparsed code, stale abstract, or no loaded jurisdiction profile → `REVIEW`, never `PASS`.

### 3.3 Abstract as an authoritative source

The driver abstract is the authority for Layer 1 facts — class, endorsements, conditions, status, and violation history. Store it with full provenance: source, retrieval date, authority, and `verificationStatus`. A driver-stated licence class is `driver_stated`; an abstract-derived one is `authority_sourced`. These are not interchangeable, and the dispatch gate should be configurable on which it will accept.

Abstract freshness matters. An abstract pulled fourteen months ago does not establish current licence status. Stale abstracts route to `REVIEW` and surface in the Exception Centre.

### 3.4 Medical certificate — validity, not contents

Where a jurisdiction or client requires a commercial driver medical examination, the company holds the **fact and expiry** of a valid certificate (Layer 1). The examination form itself and its findings are Layer 3.

Whether the carrier is required to hold the certificate document, and at what frequency examinations are required by licence class and driver age, is **[VERIFY DATA]** — jurisdiction-specific, and it must be loaded from authority with provenance. Do not populate examination intervals from memory.

---

## 4. Layer 2 — Fitness and task clearances

### 4.1 Reuse Book 13's enum, do not invent one

Book 13 already publishes `FIT / FIT_WITH_LIMITATIONS / ASSESSMENT_REQUIRED / TEMP_UNFIT / MEDICAL_REVIEW / UNKNOWN`, and Book 48's FIT-SCHED-001 already consumes it. This subsystem **stores and projects** that state. It does not define a second fitness scale.

### 4.2 Functional restrictions

Book 16 already lists `functional_work_restrictions` and `accommodation_cases` as domains. The Emergency Health layer already specifies the shape — restriction, effective date, expiry/review, authorized source, job impact. Bind to those; do not create a parallel restriction table.

Restrictions are operational statements: no night driving, no lifting above a configured amount, no confined-space entry, no sustained overhead work, requires scheduled breaks. They carry **no diagnosis, no medication, and no reason**.

### 4.3 Task clearances — "abilities to undergo certain tasks"

This is the layer Dylan's phrase maps onto, and Book 50 already covers a large part of it. Some tasks require a clearance that is partly medical in origin but entirely operational in expression:

- respirator use dependent on a facial seal (Book 50 FIT-GOV-001 — make/model/style/size-specific)
- SCBA and supplied-air work
- confined and restricted space entry (Book 50 CSE-*)
- work at heights
- heat-exposure work (Book 14)
- hearing-conservation-affected roles
- remote or isolated work (Book 26 journey management)

```ts
export const taskClearances = mysqlTable("taskClearances", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  operatorId: int("operatorId").notNull(),

  taskType: varchar("taskType", { length: 60 }).notNull(),
  // RESPIRATOR_SEAL, SCBA, CONFINED_SPACE, HEIGHTS,
  // HEAT_EXPOSURE, REMOTE_ISOLATED, ...

  status: mysqlEnum("status", [
    "CLEARED", "CLEARED_WITH_LIMITATIONS",
    "NOT_CLEARED", "ASSESSMENT_REQUIRED", "EXPIRED", "UNKNOWN",
  ]).default("UNKNOWN").notNull(),

  limitationsJson: text("limitationsJson"),   // operational only, no clinical detail

  clearedByRole: varchar("clearedByRole", { length: 40 }),
  clearedByUserId: int("clearedByUserId"),
  clearedAt: timestamp("clearedAt"),
  expiresAt: timestamp("expiresAt"),

  // provenance — Emergency Health layer levels
  verificationStatus: mysqlEnum("verificationStatus", [
    "worker_stated", "document_verified",
    "occupational_health_verified", "unknown",
  ]).default("unknown").notNull(),

  sourceDocumentRef: varchar("sourceDocumentRef", { length: 80 }),
  // pointer into Layer 3 — resolvable only by the custodian role, never by dispatch
});
```

The `sourceDocumentRef` is the single link between Layer 2 and Layer 3, and it is a **pointer, not a join**. Dispatch queries never resolve it. Only a custodian role with a disclosure can.

`UNKNOWN` and `EXPIRED` clearances block the task. `NOT_CLEARED` blocks with a named blocker. A missing clearance is not a cleared one.

---

## 5. Layer 3 — Driver-custodied medical vault

### 5.1 Two custody modes

```
MODE A — DRIVER-HELD  (default for all opt-in content)
  Encrypted at rest with driver-scoped key material.
  Company roles cannot read it. No break-glass path exists.
  Not indexed by company search, analytics, AI retrieval, or exports.
  Not subject to company legal hold.
  Purpose: the driver has their own documents, offline, in the field.

MODE B — DISCLOSED  (driver's explicit, per-document, per-purpose act)
  Driver shares one document with one named custodian role
  for one stated purpose, with an expiry.
  Creates an inbound disclosure record.
  From that point it is a company record for the disclosed scope:
  retained, held, and auditable accordingly.
```

The step from A to B is **the driver's**, never the company's. A company role cannot request-and-self-approve. It can *ask*; the driver grants or declines, and a decline is not a dispatch consequence (§5.4).

### 5.2 Required vs opt-in

Dylan's rule: if it is not an administrative requirement, it is opt-in.

```
REQUIRED (Layer 1 / Layer 2 artifacts)
  licence, abstract, endorsements, condition codes,
  certification currency, medical certificate validity + expiry,
  task clearance outcomes
  → driver must supply; non-supply has dispatch consequences

OPT-IN (Layer 3 content)
  prescriptions, diagnoses, specialist letters, treatment records,
  examination forms, personal medical history, assistive-device detail
  → driver may upload; non-upload has NO dispatch consequence
```

The distinction must be visible in the UI at upload time, per document, in plain language. A driver should never be unclear about whether they are satisfying a requirement or volunteering something.

### 5.3 Revocation

A driver may delete Mode A content at any time, and deletion is real — not a soft flag.

Mode B is different and the UI must say so **before** the driver shares, not after: a disclosed document may have become a company record subject to retention and legal hold. Revoking stops future use and removes the driver's grant; it does not retroactively unmake a record that an accommodation, WCB claim, or investigation was built on. Presenting revocation as unconditional would be a lie the driver discovers at the worst possible moment.

```
Revoke Mode A        → content deleted, audit trace of the deletion retained
Revoke Mode B        → grant ended, future reads blocked,
                       disclosed copy governed by retention + legal hold
Mode B under hold    → driver informed that the copy is preserved, and why
```

### 5.4 Non-coercion

- Declining to upload optional content is **never** a dispatch blocker, a scheduling input, a performance data point, or a disciplinary matter.
- The system must not display "driver has not uploaded medical documents" to dispatch, supervisors, or management. That framing turns opt-in into pressure.
- Requests from a company role for a driver disclosure are logged — including declines — so a pattern of pressure is visible on review. Book 24 integrity controls and Book 39's non-retaliation principle apply.
- Nothing here gates a worker's right to report an injury or refuse unsafe work.

---

## 6. Emergency profile — the one narrow exception

Remote oilfield work, driver unresponsive, responders inbound. This is the single case where health information needs an emergency-access path, and the Emergency Health & Worker Welfare Layer already sketches the consent model for it.

Design constraints that keep this from becoming a back door:

1. **Separate minimal record**, not the medical vault. It contains only what a responder needs: allergies, critical conditions, emergency medications, blood type if verified, next of kin, and the driver's own notes.
2. **Driver-authored and driver-opted-in**, explicitly marked for release to emergency responders. A driver who declines has no emergency profile, and that is permitted.
3. **Never a path to Layer 3.** Emergency access resolves the emergency profile and nothing else. It cannot traverse to the vault.
4. **Break-glass, logged, alerting.** Access writes a `restrictedAccessEvents` row, notifies the driver after the fact, and notifies a designated safety role in real time.
5. **Available offline** and via the operator digital passport QR — but per architecture rule 12, the QR is a pointer and authorization is server-side, with a defined degraded-mode behaviour for the genuinely-no-signal case. That degraded mode needs its own design decision (§13.6).
6. **Provenance is prominent.** The Emergency Health layer makes the right call: `Blood type: UNKNOWN` is safer than an unverified remembered value. Verification level displays next to every field, because incorrect information here can cause unsafe treatment.
7. **Freshness prompts**, not forced re-entry — review nudges before remote or high-risk work, per the same layer.

---

## 7. Drug/alcohol program interaction

A driver's prescription may legitimately explain a positive test result. It **must not** reach the employer to do so.

```
DRIVER  ──prescription──▶  MEDICAL REVIEW OFFICER  ──result only──▶  EMPLOYER
                                                    (NEGATIVE / POSITIVE /
                                                     SAFETY-SENSITIVE REVIEW)
```

The employer receives a result. The MRO receives the clinical explanation. This subsystem provides the driver a channel to send a document to a designated external medical reviewer without it becoming a company record — a Mode B disclosure whose recipient is external and whose custodian is not a company role.

Whether the company's program uses an MRO, and what its rules are, is **[VERIFY DATA]** — it depends on the program, the client's requirements, and the jurisdiction. Do not assume a US DOT-style structure applies to an Alberta program.

Companion-spec invariants carry over unchanged: `D&A TEST RESULT != FITNESS DETERMINATION`, and a test result creates no incident.

---

## 8. Insurance interactions

Dylan asked what this ties into. The honest answer is: Layer 1 and Layer 2 feed insurance materially. Layer 3 does not feed it at all.

**What legitimately flows to insurers and brokers**

- Driver schedule data for fleet policies and renewal — class, endorsements, experience, abstract-derived violation and suspension history. Book 30 INS-DATA-001 is blunt that an insurance application is not a place to guess company data; pulling this from the authoritative abstract record rather than an HR spreadsheet is a real improvement.
- Fitness **status** where a policy or contract genuinely requires it — `FIT_WITH_LIMITATIONS`, never the reason.
- Claim-relevant Layer 1 facts after an incident: was the licence valid, were endorsements current, was the driver operating within licence conditions.
- WCB modified-work and RTW functional abilities (Book 39 WCB-MOD-001) — functional, not clinical.

**What never flows automatically**

- Anything in Layer 3. An insurer request for medical records is a legal/consent process routed through counsel and the driver, not a query this system answers. `DRIVER UPLOADED MEDICAL != INSURER ENTITLED TO IT`.
- Accident-benefit medical is a driver-to-insurer channel. The company is not a conduit for it.

**A useful new signal**

Operating contrary to a licence condition is a coverage exposure worth surfacing before it becomes a claim problem. If a driver restricted to automatic transmission is dispatched to a manual unit, that is a blocker (§3.2) *and* a risk-register entry. Note the companion invariant, though: `DRIVER OPERATES CONTRARY TO LICENCE CONDITION != AUTOMATICALLY UNCOVERED` — coverage is the insurer's determination, not ours. We surface the fact and let the insurer decide, consistent with Book 30 INS-AI-002.

**Renewal and abstract cadence**

Where an insurer requires periodic abstracts, the abstract-freshness state (§3.3) doubles as an insurance-compliance signal. An expired-abstract exception is both a dispatch review item and a renewal-readiness item.

---

## 9. Provenance and verification

Reuse the Emergency Health layer's levels rather than inventing a scale:

```
worker_stated                    driver said it
document_verified                a document was reviewed
occupational_health_verified     an authorized health role confirmed it
authority_sourced                came from the issuing authority / abstract
unknown                          not established
```

Applied strictly:

- A driver-typed licence class is `worker_stated` until an abstract confirms it.
- An OCR-extracted expiry date is a **candidate**, never a verified date, until reviewed — Manifest §27 already says this, and a medical or licence expiry is exactly the wrong place to relax it.
- `unknown` never renders as satisfied. A blank blood-type field displays `UNKNOWN`, not blank.
- Every Layer 2 determination records who authored it, in what role, from what source, and when it expires or requires review.

---

## 10. Offline behaviour

The companion spec's rules apply, with two changes that follow from driver custody.

| | Company restricted content | Driver Mode A content |
|---|---|---|
| Offline capture | permitted | permitted |
| Offline **read** on driver device | **blocked** | **permitted — this is the point** |
| Local encryption | required | required |
| Evicted after sync | yes | **no — driver's own copy persists** |
| Listed in cache manifest | no | driver's own device only |

A driver being able to open their medical card and abstract at a roadside inspection with no signal is most of this feature's value. That works precisely because the content is theirs.

Mode B disclosed copies follow the company rules: not readable on the driver's device as company records, conflicts routed to human resolution, never auto-merged.

The emergency profile caches offline on the **driver's own device and on a designated crew/journey-management device** where the driver has opted into that, per Book 26. Degraded-mode authorization for the no-signal case is an open decision (§13.6).

---

## 11. Schema additions

Layer 1 extends the existing operator profile (Manifest §5, `[V7 PRESENT]`) rather than replacing it. Do not create a second operator record.

```ts
// Layer 1 — licence conditions, from the abstract
export const operatorLicenceConditions = mysqlTable("operatorLicenceConditions", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  operatorId: int("operatorId").notNull(),

  jurisdiction: varchar("jurisdiction", { length: 40 }).notNull(),
  conditionCode: varchar("conditionCode", { length: 20 }).notNull(),

  // resolved via a source-versioned jurisdiction profile — [VERIFY DATA]
  conditionProfileId: int("conditionProfileId"),
  resolvedMeaning: varchar("resolvedMeaning", { length: 200 }),

  constraintClass: mysqlEnum("constraintClass", [
    "HARD_EQUIPMENT",     // e.g. automatic transmission only  → BLOCK
    "HARD_SCOPE",         // operating-scope restriction       → BLOCK
    "SOFT_PREREQUISITE",  // e.g. corrective lenses            → PROMPT
    "INFORMATIONAL",
    "UNKNOWN",            // unparsed code                     → REVIEW
  ]).default("UNKNOWN").notNull(),

  sourceType: mysqlEnum("sourceType", [
    "ABSTRACT", "LICENCE_SCAN", "DRIVER_STATED", "IMPORTED",
  ]).notNull(),
  verificationStatus: varchar("verificationStatus", { length: 40 }).notNull(),
  sourceRetrievedAt: timestamp("sourceRetrievedAt"),
  effectiveFrom: timestamp("effectiveFrom"),
  removedAt: timestamp("removedAt"),          // append-only; never hard-delete
});

// Layer 3 — driver-custodied vault
export const driverVaultDocuments = mysqlTable("driverVaultDocuments", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  operatorId: int("operatorId").notNull(),

  custodyMode: mysqlEnum("custodyMode", [
    "DRIVER_HELD",       // Mode A — company cannot read
    "DISCLOSED",         // Mode B — scoped company/external access
  ]).default("DRIVER_HELD").notNull(),

  documentCategory: varchar("documentCategory", { length: 60 }).notNull(),
  submissionBasis: mysqlEnum("submissionBasis", [
    "ADMINISTRATIVELY_REQUIRED", "OPT_IN",
  ]).notNull(),

  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull(),  // DV- neutral

  storageRef: varchar("storageRef", { length: 200 }).notNull(),
  encryptionScope: mysqlEnum("encryptionScope", [
    "DRIVER_SCOPED", "ORG_SCOPED",
  ]).notNull(),

  uploadedAt: timestamp("uploadedAt").defaultNow().notNull(),
  driverDeletedAt: timestamp("driverDeletedAt"),
});

// Inbound disclosure — driver → company/external. Driver is the actor.
export const driverDisclosures = mysqlTable("driverDisclosures", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  operatorId: int("operatorId").notNull(),
  documentId: int("documentId").notNull(),

  recipientScope: mysqlEnum("recipientScope", [
    "OCCUPATIONAL_HEALTH", "RECORDS_CUSTODIAN",
    "EXTERNAL_MEDICAL_REVIEWER", "EXTERNAL_MEDICAL_PROVIDER",
    "WCB", "LEGAL_COUNSEL",
  ]).notNull(),
  recipientIdentifier: varchar("recipientIdentifier", { length: 200 }),

  statedPurpose: text("statedPurpose").notNull(),
  requestedByUserId: int("requestedByUserId"),   // null = driver-initiated
  driverGrantedAt: timestamp("driverGrantedAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  revokedAt: timestamp("revokedAt"),

  becameCompanyRecord: boolean("becameCompanyRecord").default(false).notNull(),
  driverInformedOfRetentionAt: timestamp("driverInformedOfRetentionAt"),
});

// Requests for disclosure — including declines. Pressure must be visible.
export const driverDisclosureRequests = mysqlTable("driverDisclosureRequests", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  operatorId: int("operatorId").notNull(),

  requestedByUserId: int("requestedByUserId").notNull(),
  requestedByRole: varchar("requestedByRole", { length: 40 }).notNull(),
  statedPurpose: text("statedPurpose").notNull(),
  requestedAt: timestamp("requestedAt").defaultNow().notNull(),

  outcome: mysqlEnum("outcome", [
    "PENDING", "GRANTED", "DECLINED", "EXPIRED", "WITHDRAWN",
  ]).default("PENDING").notNull(),
  respondedAt: timestamp("respondedAt"),
});
```

Emergency profile tables bind to the Emergency Health & Worker Welfare Layer rather than being redefined here.

**Tracking numbers.** Per the companion spec §12, Layer 3 documents take a single category-neutral prefix (`DV`). `RX-2026-0044` in an exception list or a filename discloses that a prescription exists. Layer 1 and Layer 2 artifacts may use descriptive prefixes, because a licence condition is not a secret.

---

## 12. Permissions, procedures, and the dispatch gate

### 12.1 Permissions

```
operator.read_qualification        Layer 1 — dispatch, office
operator.read_fitness_status       Layer 2 — dispatch, scheduling (status only)
operator.author_fitness            Layer 2 — occupational health / designated role
operator.author_task_clearance     Layer 2

driver.vault_self                  driver's own Mode A content — driver only
driver.vault_disclosed_read        Mode B, scoped, requires an active disclosure
driver.disclosure_request          may ask a driver for a disclosure (logged)

emergency.profile_read             emergency profile under break-glass
emergency.profile_break_glass      triggers alert + driver notification
```

**No permission grants Mode A access.** Not `admin`, not `records_custodian`, not a break-glass grant. If a role can reach Mode A content, the boundary does not exist. This should be asserted by a test that enumerates every permission and confirms none resolves Mode A.

### 12.2 Procedures

Every procedure uses the role/scope authorization gate. None uses bare `protectedProcedure` — same requirement as the companion spec, same reason.

```
operatorQualifications.get              Layer 1 projection
operatorConditions.evaluate             pure fn → PASS / REVIEW / BLOCKED / UNKNOWN
fitness.getStatus                       Layer 2 allowlisted DTO — status + restrictions
fitness.authorDetermination             operator.author_fitness
taskClearance.evaluate                  pure fn, per task type

driverVault.listOwn                     driver.vault_self, self-scoped only
driverVault.upload                      driver.vault_self
driverVault.deleteOwn                   driver.vault_self, Mode A only
driverVault.discloseDocument            driver acts; creates driverDisclosures row
driverVault.readDisclosed               requires active, unexpired disclosure
driverVault.requestDisclosure           driver.disclosure_request; logs regardless of outcome

emergencyProfile.get                    break-glass + alert + driver notification
```

`fitness.getStatus` returns an **allowlisted DTO** — the same pattern as the B20.3 roadside-inspection DTO. Not a full record with fields omitted in the UI. The field must not exist in the payload.

### 12.3 Dispatch gate additions

Extending Manifest §7's server-side gate with named blockers:

```
LICENCE_EXPIRED
LICENCE_CLASS_INSUFFICIENT
ENDORSEMENT_MISSING
LICENCE_CONDITION_EQUIPMENT_MISMATCH      ← automatic-only vs manual unit
LICENCE_CONDITION_SCOPE_RESTRICTION
LICENCE_CONDITION_UNRESOLVED              ← unparsed code → REVIEW
ABSTRACT_STALE                            ← REVIEW, not PASS
MEDICAL_CERTIFICATE_EXPIRED
MEDICAL_CERTIFICATE_STATUS_UNKNOWN        ← REVIEW
FITNESS_TEMP_UNFIT
FITNESS_ASSESSMENT_REQUIRED
FITNESS_STATUS_UNKNOWN                    ← REVIEW
TASK_CLEARANCE_NOT_CLEARED
TASK_CLEARANCE_EXPIRED
TASK_CLEARANCE_UNKNOWN                    ← REVIEW
```

The gate reads Layer 1 and Layer 2 only. It has no code path to Layer 3 — enforced by permission namespace and asserted by test, not by reviewer discipline.

---

## 13. Exception Centre entries

- Abstract stale beyond configured freshness
- Licence, endorsement, medical certificate, or task clearance expiring or expired
- Unresolved condition code (no loaded jurisdiction profile)
- Fitness determination past its review date
- Task clearance expired for a driver scheduled on that task
- Respirator fit test model mismatch against issued equipment (Book 50 FIT-MODEL-001)
- Emergency profile not reviewed within the configured window, before remote work
- Emergency profile break-glass used — surfaced to safety in real time
- Mode B disclosure expiring, with content still in active use
- Disclosure request declined — informational to privacy/legal only, **never to dispatch or the driver's supervisor**
- Repeated disclosure requests to the same driver by the same requester

---

## 14. Critical invariants

```
LICENCE CONDITION CODE        != MEDICAL INFORMATION
MEDICAL REASON FOR A CODE     != OPERATIONALLY NEEDED

DRIVER UPLOADED DOCUMENT      != COMPANY RECORD
DRIVER UPLOADED MEDICAL       != COMPANY MAY READ IT
DRIVER UPLOADED MEDICAL       != INSURER ENTITLED TO IT
ADMIN BREAK-GLASS             != DRIVER VAULT ACCESS
COMPANY HOSTS THE STORAGE     != COMPANY CUSTODIES THE CONTENT

MEDICAL DOCUMENT              != FITNESS DETERMINATION
FITNESS DETERMINATION         != DIAGNOSIS DISCLOSABLE
FUNCTIONAL RESTRICTION        != DIAGNOSIS AVAILABLE TO DISPATCH
AI READS DOCUMENT             != AI MAY DETERMINE FITNESS

OPT-IN DECLINED               != DISPATCH CONSEQUENCE
OPT-IN DECLINED               != VISIBLE TO SUPERVISOR
DISCLOSURE REQUESTED          != DISCLOSURE OWED
DISCLOSURE GRANTED            != PERMANENT ACCESS
DISCLOSURE REVOKED            != DISCLOSED COPY UNMADE

MEDICAL CERTIFICATE VALID     != DRIVER FIT TODAY
FIT FOR DUTY                  != CLEARED FOR EVERY TASK
TASK CLEARANCE MISSING        != TASK CLEARANCE GRANTED
CLEARED FOR RESPIRATOR A      != CLEARED FOR RESPIRATOR B

ABSTRACT ON FILE              != ABSTRACT CURRENT
CONDITION CODE UNPARSED       != NO RESTRICTION
OCR EXTRACTED EXPIRY          != VERIFIED EXPIRY
DRIVER STATED CLASS           != AUTHORITY SOURCED CLASS

EMERGENCY PROFILE ACCESS      != MEDICAL VAULT ACCESS
EMERGENCY ACCESS GRANTED      != DRIVER UNINFORMED
BLOOD TYPE REMEMBERED         != BLOOD TYPE VERIFIED

OPERATES CONTRARY TO CONDITION != AUTOMATICALLY UNCOVERED
UNKNOWN                        != CLEARED
UNKNOWN                        != FIT
```

---

## 15. Tests

**Custody boundary — the load-bearing tests**
1. Enumerate every permission in the system; none resolves Mode A content for a non-owner
2. Admin with a valid companion-spec break-glass grant → `DENIED` on Mode A
3. Driver A → `DENIED` on driver B's vault, every procedure
4. Mode A content absent from company search, analytics, exports, backups-as-company-records, and AI retrieval — assert on serialized output
5. `fitness.getStatus` payload contains no clinical field — assert on the serialized DTO, not the UI

**Disclosure**
6. Read without an active disclosure → `DENIED`
7. Expired or revoked disclosure → `DENIED` immediately, server clock
8. Disclosure scoped to one document → `DENIED` on a sibling document
9. Company role cannot create a disclosure on a driver's behalf
10. Declined request is logged and is invisible to dispatch and supervisor roles
11. Mode B revocation ends access but preserves a copy under legal hold, and the driver-informed timestamp is set

**Licence conditions and dispatch**
12. Automatic-only condition + manual unit → `BLOCKED` with `LICENCE_CONDITION_EQUIPMENT_MISMATCH` and the named reason
13. Automatic-only condition + automatic unit → `PASS`
14. Corrective-lenses condition → `PASS` with a pre-trip prompt, never a block
15. Unparsed condition code → `REVIEW`, never `PASS`
16. No loaded jurisdiction condition profile → `UNKNOWN`, never `PASS`
17. Stale abstract → `REVIEW`
18. Driver-stated class without abstract corroboration → configurable, defaults to `REVIEW`
19. Condition removal appends a row; prior condition history is retrievable

**Fitness and task clearance**
20. `TEMP_UNFIT` blocks; `FIT_WITH_LIMITATIONS` passes with restrictions surfaced
21. `UNKNOWN` fitness → `REVIEW`, never `PASS`
22. Missing task clearance → blocked for that task, not for all work
23. Respirator clearance for model A → not cleared for model B (Book 50 FIT-MODEL-001)
24. Expired clearance on a scheduled task raises an exception before the shift, not at it
25. AI cannot author a fitness determination — procedure denies non-human actors

**Opt-in integrity**
26. A driver with zero optional uploads is fully dispatch-eligible
27. Upload status does not appear in any dispatch, scheduling, or management projection
28. Required-vs-optional is stored per document and rendered at upload time

**Emergency profile**
29. Emergency break-glass returns the emergency profile only and cannot traverse to Layer 3
30. Break-glass writes an audit event, notifies the driver, and alerts safety
31. Unverified blood type renders `UNKNOWN`, never blank or assumed

**Offline**
32. Driver's own Mode A content readable offline on their own device
33. Mode A content on another driver's or a shared device → not present
34. Disclosed company copies not readable on the driver device as company records

---

## 16. Open decisions for the owner

1. **Who is the custodian role for Mode B disclosures?** An internal occupational-health role, an external provider, or the `records_custodian` from the companion spec? This should not default to operational admin.
2. **Is Mode A encryption driver-key-scoped or org-key-scoped-with-policy-block?** True driver-scoped keys make company access cryptographically impossible — strongest guarantee, but a lost key means lost content with no recovery. Policy-blocked org keys are recoverable but rely on the access control holding.
3. **Does the company hold the medical examination certificate document, or only its validity and expiry?** — **[VERIFY DATA]**, jurisdiction-dependent, and it changes whether the certificate is Layer 1 or Layer 3.
4. **Abstract cadence and who pulls it** — annual, on hire, on incident, insurer-driven? And is a driver-supplied abstract acceptable, or authority-pulled only?
5. **May a driver decline a Mode B request with no reason, with no record of the reason?** Recommended yes.
6. **Emergency profile offline degraded mode** — if the QR scanner has no signal, does a cached emergency profile render? Blocking it risks a responder getting nothing in exactly the scenario the feature exists for; allowing it weakens the pointer-not-container rule. This needs an explicit decision, not a default.
7. **Does the driver keep vault access after offboarding?** Their own content arguably should follow them; company infrastructure hosting it after employment ends is awkward. Export-on-offboarding is the likely answer.
8. **Second approver for Mode B reads of medical content** — mirror the companion spec's `HIGHLY_RESTRICTED` pattern?

---

## 17. Out of scope

- This spec does not define fitness determination criteria — Book 13 owns that.
- It does not define accommodation process or duty-to-accommodate — Book 16 owns that.
- It does not define respirator, confined-space, or heights programs — Book 50 and Book 14 own those.
- It does not define WCB modified work or RTW — Book 39 owns that.
- It does not determine coverage. It surfaces licence-condition facts; the insurer determines coverage (Book 30 INS-AI-002).
- It supplies no licence condition code table, no medical examination interval, no retention period, and no abstract cadence. Every such value is **[VERIFY DATA]** and must be loaded from authority with provenance.
- It is not a legal opinion on custody, discoverability, or PIPA compliance. §1 flags those for counsel.
