# LeaseOS / FieldRoute — Restricted Records, Incident Fan-Out & Confidential Vault Architecture

**Spec ID:** LEASEOS_RESTRICTED_RECORDS_VAULT
**Version:** 1.0
**Owner decisions captured:** 2026-09-17
**Slots into:** Master Programming Manifest V8 as a new subsystem section
**Policy interfaces:** Book 12 (Audit/Records), Book 13 (Occupational Health), Book 16 (HR), Book 17 (Privacy/Security/IAM), Book 24 (Ethics/Whistleblower), Book 30 (Insurance/Claims/Loss), Book 39 (WCB/Injury/RTW), Book 49 (Incident Command)

---

## Purpose

One root incident may lawfully produce several parallel records with **different audiences, different deadlines and different access rules**. Today those chains are described across Books 30, 39 and 49 but there is no implemented mechanism that:

1. fans a single incident out to its derived matters without duplicating the underlying facts;
2. keeps internal-only material (near misses, drug/alcohol results, internal investigations) in a server-enforced restricted sector that administration alone can reach;
3. records *that* a restricted record was opened, by whom, and for what stated purpose;
4. lets administration decline a proposed internal investigation — because how a company handles a matter in-house is its own decision — while still leaving an honest trace that the decision was made deliberately.

This spec defines that mechanism.

---

## Status legend

Consistent with Manifest V8.

- **[V7 PRESENT]** — represented in the `leaseos-fieldroute-v7.zip` trunk.
- **[B20 BRANCH]** — reported by the later B20.x authorization checkpoint chain, **not present in the v7 trunk**. Divergent branch; see prerequisite below.
- **[BUILD]** — requires production implementation.
- **[VERIFY DATA]** — code may exist, but the real-world rule/value must come from a current authoritative source and retain provenance.

---

## 0. Branch prerequisite — read before implementing

This subsystem **cannot be built on the v7 trunk alone.** It depends entirely on a server-enforced authorization engine, and the two baselines in project knowledge disagree:

| | V8 authoritative baseline (`v7.zip`) | Later B20.x checkpoint chain |
|---|---|---|
| Tables | 52 | 105 |
| Migrations | 12 | 20 |
| Tests | 131 across 8 engines | 606 across 29 files |
| Domain authorization engine | absent | present (B20.2), decisions audited |
| Retention / legal holds | absent | migration 0015 |
| Privacy / monitoring / device permissions | absent | migration 0014 |
| Role assignments | absent | migration 0020 |

Per Manifest V8 §0 and architecture rule 34, these are **divergent branches and must not be overlaid.** Do not recreate the B20 authorization engine from these notes and present it as the original.

**Required sequence:**

1. Obtain the branch/ZIP containing the B20.x authorization engine, migrations 0014/0015/0020, and the records API work.
2. Reconcile it against the v7 trunk by schema/entity/endpoint responsibility, preserving the B12 routing engines on the v7 side.
3. Fix the known B20 defect first — migration 0020 uses `UNIQUE(userId, role, scopeRef, revokedAt)`, which does **not** enforce one active grant in MariaDB/MySQL because unique indexes permit multiple `NULL` rows. An active grant has `revokedAt = NULL`, so duplicate active grants can coexist. Vault access control sitting on top of a role table that can hold two conflicting active grants is not a security boundary.
4. Complete B20.3 — the B20.2 checkpoint is explicit that the authorization engine currently protects **zero** production procedures and ~200 operational procedures remain `protectedProcedure`-only.

**Until steps 1–4 are done, this subsystem stays in design.** Building a "private vault" behind an authorization layer that is not yet enforced at the API boundary produces a vault that is hidden in the UI and open at the backend — the exact failure Book 17 names as `UI HIDES RECORD != BACKEND ACCESS PREVENTED`.

---

## 1. Non-negotiable rules for this subsystem

1. **The incident is the root record. Derived matters reference it; they never copy its facts.**
2. **Sensitivity is a property of the record, not of the screen it appears on.**
3. **Administration role alone is not access.** Access to a restricted record requires an authenticated role *plus* a purpose-bound grant.
4. **Every restricted-record read is an audited event**, not just every write.
5. **The system proposes an internal investigation. It never compels one.**
6. **A declined investigation is recorded as a decision, not as content.**
7. **Disclosure is directional.** Restricted records may reference outward-facing records. Outward-facing records and exports never auto-populate from restricted records.
8. **Retention is per record type, and legal hold overrides retention.**
9. **Human-readable tracking numbers for restricted records must not encode their category.**
10. **A worker's right to report is never gated by this subsystem.**

---

## 2. Existing material — extend, do not duplicate

Substantial parts of this design already exist as policy. Implementation must bind to it rather than inventing a parallel model.

| Existing | Where | How this spec uses it |
|---|---|---|
| Information classification `PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED / HIGHLY_RESTRICTED`, with drug/alcohol testing, medical restrictions and legal investigations already named `HIGHLY_RESTRICTED` | Book 17 PRV-CLS-001 | Canonical sensitivity enum. Do not create a new scale. |
| Break-glass use already listed as a logged security event | Book 17 SEC-LOG-001 | This spec implements it. |
| Sensitive-record access logging with `purpose` | Book 17 SEC-LOG-002 | Canonical shape for the access event. |
| Purpose binding — every sensitive field carries `purpose`, `authority`, `authorized_roles[]`, `retention_rule`, `permitted_disclosures[]` | Book 17 PRV-PUR-001 | Applied at record-type level in §9. |
| One event may create incident + insurance claim + WCB claim + client claim + third-party claim + regulatory report + police report + internal investigation + litigation | Book 30 INS-SEP-001 | This is the fan-out model in §4. Confirmed as the chosen design. |
| Independent per-obligation deadlines; one event shows WCB `DUE` while insurer `COMPLETE` | Book 30 LOSS-NOT-003 | Canonical obligation model in §4.3. |
| Dedicated WCB lifecycle — reportability review, employer report, worker report right, healthcare reporting, modified work, RTW, appeal | Book 39 WCB-* | WCB claim detail table binds to these policies; does not re-implement them. |
| Supervisor sees functional restriction, not diagnosis | Book 39 WCB-PRIV-001, Book 30 WCB-PRIV-001 | Enforced as a projection boundary in §8. |
| Legal hold survives incident closure; `INCIDENT CLOSED != LEGAL HOLD RELEASED` | Book 49 invariants | Enforced in §9. |
| Non-retaliation / integrity controls | Book 24, Book 39 WCB-WRK-001 | Enforced in §11. |
| Structured decision object with `code`, `reason`, `policy`, `authority`, `evidence` | Book 12 | Canonical denial shape for vault access refusals. |
| Category-scoped evidence permissions (`evidence.read_maintenance`, `read_safety_summary`, `read_job_operational`, `read_commercial`, `read_personnel`, `read_legal`) proposed to replace broad `evidence.read_all` | B20 checkpoint notes | Adopted. The vault is the forcing function for this migration — see §14. |

**Explicit non-duplication warning.** Book 39 already exists as the dedicated WCB book and Book 30 already owns claims. Do not create a second WCB model inside the vault subsystem. The vault owns *confidentiality and access*; Books 30/39 own *claim lifecycle*.

---

## 3. Sensitivity tiers and the Restricted sector

### 3.1 Tier assignment

Every record touched by this subsystem resolves to one tier from Book 17 PRV-CLS-001. Tier is stored, never inferred at read time.

```
OPERATIONAL          → INTERNAL / CONFIDENTIAL
  incident root facts, vehicle damage, cargo condition, GPS, photos

OUTWARD-FACING       → CONFIDENTIAL
  insurance claim, WCB claim, client notice, regulatory report, police file ref

RESTRICTED           → RESTRICTED
  near-miss report, internal investigation, disciplinary linkage

MEDICAL-ADJACENT     → HIGHLY_RESTRICTED
  drug/alcohol test result, medical restriction detail, diagnosis,
  treatment record, functional-abilities source document
```

`RESTRICTED` and `HIGHLY_RESTRICTED` records live in the **Restricted sector**. `HIGHLY_RESTRICTED` carries additional controls (§8).

### 3.2 What the Restricted sector is

It is **not** a folder, a flag on a shared table, or a hidden route. It is:

- a separate storage boundary with its own permission namespace;
- default-deny at the API layer, independent of the requesting user's operational role;
- readable only through a purpose-bound grant (§6);
- excluded from every general query path — search, list endpoints, AI retrieval, analytics, exports, and dashboard aggregation — unless the caller holds an active grant for that specific record.

The last point matters more than it looks. Book 17 PRV-TEN-001 already requires tenant isolation to apply to *search, AI retrieval, analytics, exports, backups, logs and APIs* — not just the primary query. Restricted-sector exclusion has the same surface area. A near-miss that leaks through the AI Secretary's retrieval layer or an analytics rollup is as disclosed as one shown on screen.

### 3.3 AI Secretary boundary

The AI Secretary may **create** a restricted record from dictation (a driver reporting a near miss out loud). It may not **retrieve** restricted content into any context, summary, "what am I missing?" answer, or exception digest. Retrieval requires a grant, and a grant belongs to a human.

Where a restricted record exists and the requester lacks a grant, the Secretary returns existence-neutral output — it does not say "there is a restricted record you cannot see," because that itself discloses. It simply omits.

---

## 4. Root incident and matter fan-out

### 4.1 Model — chosen: single root, linked matters

Owner decision: **one incident record spawns and links the derived matters.** Not separate intake per chain.

```
                    INCIDENT (root)
                    INC-2026-000551
                           │
        ┌──────────────┬───┴────┬──────────────┬────────────────┐
        │              │        │              │                │
  INSURANCE        WCB      REGULATORY     POLICE         INTERNAL
  CLAIM            CLAIM    REPORT         FILE REF       INVESTIGATION
  (outward)        (outward) (outward)     (outward)      (RESTRICTED)
        │              │        │              │                │
        └──────────────┴────────┴──────────────┘                │
                       │                                        │
              references root facts                    references root facts
              (FK, never copied)                       (FK, never copied)
                                                                │
                                                     never referenced BY
                                                     outward matters (§7)
```

Rationale: the facts of the event — time, unit, driver, location, GPS, photos, cargo state — are one set of facts. Duplicating them into three intakes guarantees they drift, and a drifted fact across an insurance claim and a WCB claim is a material problem, not a cosmetic one. This is architecture rule 3 applied to incidents.

### 4.2 Matter spine

A thin spine registers every derived matter; type-specific tables hold the lifecycle. This keeps the fan-out queryable without forcing unrelated lifecycles into one table.

```ts
export const incidentMatters = mysqlTable("incidentMatters", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  incidentId: int("incidentId").notNull(),

  matterType: mysqlEnum("matterType", [
    "INSURANCE_CLAIM",
    "WCB_CLAIM",
    "REGULATORY_REPORT",
    "POLICE_FILE",
    "CLIENT_NOTICE",
    "THIRD_PARTY_CLAIM",
    "INTERNAL_INVESTIGATION",
    "LITIGATION",
  ]).notNull(),

  // Book 17 PRV-CLS-001
  sensitivityTier: mysqlEnum("sensitivityTier", [
    "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED",
  ]).notNull(),

  // category-neutral — see §12
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull(),

  status: mysqlEnum("status", [
    "PROPOSED", "OPEN", "SUBMITTED", "IN_REVIEW",
    "CLOSED", "DECLINED", "UNKNOWN",
  ]).default("PROPOSED").notNull(),

  openedAt: timestamp("openedAt"),
  closedAt: timestamp("closedAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

Indexes: `(organizationId, incidentId)`, `(organizationId, matterType, status)`, `UNIQUE(organizationId, trackingNumber)`.

Detail tables — `insuranceClaims`, `wcbClaims`, `internalInvestigations` — each `matterId` FK to the spine. `wcbClaims` binds to Book 39 fields (`employerAwarenessAt`, `reportDueAt`, `reportedAt`, `wcbClaimNumber`, `submissionMethod`) and **must not** store diagnosis. Diagnosis is a `HIGHLY_RESTRICTED` record referenced by the claim, not a column on it.

### 4.3 Obligations are independent — [VERIFY DATA]

Per Book 30 LOSS-NOT-003, each reporting obligation carries its own deadline and status. One incident legitimately shows WCB `DUE`, insurer `COMPLETE`, regulator `NOT_APPLICABLE`.

```ts
export const incidentObligations = mysqlTable("incidentObligations", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  incidentId: int("incidentId").notNull(),

  obligationType: mysqlEnum("obligationType", [
    "WCB", "OHS", "INSURER", "CLIENT", "POLICE",
    "ENVIRONMENTAL", "TDG", "TRANSPORT", "PRIVACY",
  ]).notNull(),

  // Rule profile — architecture rule 10. Never hard-code the deadline.
  ruleProfileId: int("ruleProfileId"),
  jurisdiction: varchar("jurisdiction", { length: 40 }),

  applicability: mysqlEnum("applicability", [
    "REQUIRED", "NOT_APPLICABLE", "REVIEW", "UNKNOWN",
  ]).default("UNKNOWN").notNull(),

  awarenessAt: timestamp("awarenessAt"),
  dueAt: timestamp("dueAt"),
  completedAt: timestamp("completedAt"),

  status: mysqlEnum("status", [
    "DUE", "OVERDUE", "COMPLETE", "NOT_TRIGGERED", "REVIEW", "UNKNOWN",
  ]).default("UNKNOWN").notNull(),
});
```

**Deadline values are `[VERIFY DATA]`.** Book 39 records Alberta WCB's 72-hour employer reporting requirement and a 48-hour health-care-provider timeframe, and Book 30 repeats the 72-hour figure. Those are captured claims about an authority, not verified loaded rule data. Deadlines must resolve from a source-versioned rule profile carrying jurisdiction, authority, source reference, effective date, version and `lastVerifiedAt`. Until a profile is loaded and verified, `applicability` stays `UNKNOWN` and the obligation surfaces in the Exception Centre. An unloaded profile must never render as `NOT_TRIGGERED`.

Deadlines are provincial and differ by jurisdiction. Do not generalize Alberta values to a cross-border fleet.

---

## 5. Discretionary internal investigation

**Owner decision:** the system proposes an internal investigation. Administration may open it or decline it on the basis that the matter is handled in-house and off the insurance books. The software does not dictate how the company runs itself. The *decision* is recorded; the investigation content is not created.

### 5.1 Flow

```
INCIDENT COMMITTED
        ↓
proposeInternalInvestigation(incident)      ← rule-based, not AI-certified
        ↓
  PROPOSAL surfaces to administration
        ↓
   ┌────┴─────────────────────────────┐
   │                                  │
 OPEN                            DECLINE
   │                                  │
internalInvestigations row      NO investigation row created
created (RESTRICTED)                  │
   │                              disposition recorded:
investigation lifecycle           proposedAt, decidedBy, decidedAt,
                                  disposition = HANDLED_INTERNALLY
                                  (reason optional)
```

### 5.2 What the decline records — and what it does not

Records: that a proposal was raised, its trigger rule, who decided, when, and the disposition.

Does **not** record: any investigation content, findings, allegations, witness material, or narrative. Declining creates no investigation. There is nothing to leak because nothing is written.

This is deliberately a thin trace. It exists so the audit history is honest about a decision having been made — which protects the company, because "a deliberate documented management decision" reads very differently in a later review than a silent gap where a proposal vanished. It does not put the matter on any book that leaves the building (§7).

```ts
export const investigationProposals = mysqlTable("investigationProposals", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  incidentId: int("incidentId").notNull(),

  triggerRule: varchar("triggerRule", { length: 80 }).notNull(),
  triggerPolicy: varchar("triggerPolicy", { length: 80 }),
  proposedAt: timestamp("proposedAt").defaultNow().notNull(),

  disposition: mysqlEnum("disposition", [
    "PENDING",
    "OPENED",
    "HANDLED_INTERNALLY",   // declined — owner decision
    "NOT_WARRANTED",
    "DEFERRED",
  ]).default("PENDING").notNull(),

  decidedByUserId: int("decidedByUserId"),
  decidedByRole: varchar("decidedByRole", { length: 40 }),
  decidedAt: timestamp("decidedAt"),
  decisionReason: text("decisionReason"),        // optional, not required

  // set only when disposition = OPENED
  matterId: int("matterId"),
});
```

Constraint: `disposition = 'OPENED'` requires non-null `matterId`; any other terminal disposition requires `matterId IS NULL`. Enforce in the service layer and test both directions.

### 5.3 Proposal triggers are rules, not AI judgment

`proposeInternalInvestigation` is a deterministic pure function over incident attributes — injury severity, vehicle out-of-service, environmental release, TDG involvement, repeat pattern on the same unit or driver, client-contract requirement. AI may surface a proposal; AI may not classify an incident as investigation-warranted on its own authority. Per architecture rule 4 and Book 30 INS-AI-002, AI proposes and a human decides.

---

## 6. Break-glass access

**Owner decision:** administration is prompted before it can open a restricted record. The prompt is not a warning banner — it is the gate.

### 6.1 Flow

```
ADMIN REQUESTS RESTRICTED RECORD
        ↓
role check          → holds restricted.read for this tier?     no → DENY
        ↓
active grant?       → existing unexpired grant for this record? yes → serve + log read
        ↓
BREAK-GLASS PROMPT
  • record category shown (not content)
  • stated purpose required (free text, min length, not a dropdown alone)
  • acknowledgement of logging
        ↓
grant created: actor, role, recordId, purpose, grantedAt, expiresAt
        ↓
audit event written BEFORE content is served
        ↓
content served
        ↓
every subsequent read/export/print under this grant = its own audit event
```

The audit event is written **before** the content is returned. If the write fails, access fails. An access log that can be outrun by the read it is logging is not an access log.

### 6.2 Grant properties

- **Record-scoped**, not sector-scoped. A grant opens one record, not the vault.
- **Time-limited.** Duration is org-configurable; default short. Expiry is enforced server-side, not by hiding the UI.
- **Purpose is mandatory and stored verbatim.** A dropdown alone is insufficient — Book 17 SEC-LOG-002's example carries a real purpose string (`RTW_REVIEW`), and a free-text purpose is what makes a later review meaningful.
- **Non-transferable.** Grants bind to the user, not the session or device.
- **Revocable**, and revocation takes effect immediately (matching the B20.3 requirement).

```ts
export const restrictedAccessGrants = mysqlTable("restrictedAccessGrants", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),

  userId: int("userId").notNull(),
  roleKey: varchar("roleKey", { length: 40 }).notNull(),

  recordType: varchar("recordType", { length: 60 }).notNull(),
  recordId: int("recordId").notNull(),
  sensitivityTier: varchar("sensitivityTier", { length: 30 }).notNull(),

  statedPurpose: text("statedPurpose").notNull(),
  acknowledgedAt: timestamp("acknowledgedAt").notNull(),

  secondApproverUserId: int("secondApproverUserId"),   // §8
  secondApprovedAt: timestamp("secondApprovedAt"),

  grantedAt: timestamp("grantedAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
});

export const restrictedAccessEvents = mysqlTable("restrictedAccessEvents", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  grantId: int("grantId"),

  userId: int("userId").notNull(),
  roleKey: varchar("roleKey", { length: 40 }).notNull(),

  action: mysqlEnum("action", [
    "GRANT_REQUESTED", "GRANT_DENIED", "GRANT_CREATED",
    "VIEW", "EXPORT", "PRINT", "DISCLOSE", "AMEND", "GRANT_REVOKED",
  ]).notNull(),

  recordType: varchar("recordType", { length: 60 }).notNull(),
  recordId: int("recordId").notNull(),

  statedPurpose: text("statedPurpose"),
  outcome: mysqlEnum("outcome", ["ALLOWED", "DENIED"]).notNull(),
  denialCode: varchar("denialCode", { length: 60 }),

  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
});
```

`restrictedAccessEvents` is append-only. No application workflow may update or delete a row (Book 12 AUD-001). Denials are logged as well as grants — a pattern of denied attempts is itself security evidence (per the existing SEC-001 cross-tenant probe test).

### 6.3 Denial shape

Use the Book 12 structured decision object so a refusal is explainable rather than opaque:

```json
{
  "decision": "DENIED",
  "code": "RESTRICTED_NO_ACTIVE_GRANT",
  "subject": "RR-2026-000412",
  "reason": "This record requires a purpose-bound access grant.",
  "policy": "PRV-CLS-001@1.0",
  "authority": "LEASEOS_RESTRICTED_RECORDS_VAULT@1.0",
  "effectiveAt": "2026-09-17T14:21:00-06:00"
}
```

The denial must not disclose content, and for existence-sensitive categories must not confirm the record exists (§3.3).

---

## 7. Directional disclosure boundary

This is the property that makes "off the insurance books" real rather than aspirational.

```
RESTRICTED  ──── may reference ────▶  OUTWARD-FACING
            ◀── never auto-flows ───
```

Rules:

1. A restricted record may hold an FK to the root incident and to outward matters. Reading *up* the chain is permitted for a grant holder.
2. No outward-facing record, export, claim package, insurer submission, WCB submission, client notice, regulatory report, COI, loss run, renewal data set, analytics rollup, or AI-assembled claim package may read *down* into the restricted sector. Not filtered — **not joined**.
3. Moving restricted content across the boundary is an explicit human act: one record at a time, by an authorized role, with a stated recipient and purpose, producing a `DISCLOSE` event and a `disclosureCrossings` row.
4. Book 30 INS-AI-001 permits AI to assemble claim packages and summarize incident evidence. That capability is scoped to `CONFIDENTIAL` and below. The claim-package assembler must be architecturally unable to reach the restricted sector — enforced by permission namespace, and tested.

```ts
export const disclosureCrossings = mysqlTable("disclosureCrossings", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),

  sourceRecordType: varchar("sourceRecordType", { length: 60 }).notNull(),
  sourceRecordId: int("sourceRecordId").notNull(),
  sourceTier: varchar("sourceTier", { length: 30 }).notNull(),

  recipientType: mysqlEnum("recipientType", [
    "INSURER", "WCB", "REGULATOR", "POLICE", "CLIENT",
    "LEGAL_COUNSEL", "MEDICAL_PROVIDER", "AUDITOR", "OTHER",
  ]).notNull(),
  recipientIdentifier: varchar("recipientIdentifier", { length: 200 }),

  legalBasis: mysqlEnum("legalBasis", [
    "STATUTORY_REQUIREMENT", "SUBPOENA_OR_ORDER", "CONSENT",
    "CONTRACT", "INSURER_REQUEST", "LEGAL_ADVICE", "UNKNOWN",
  ]).default("UNKNOWN").notNull(),

  authorizedByUserId: int("authorizedByUserId").notNull(),
  authorizedByRole: varchar("authorizedByRole", { length: 40 }).notNull(),
  purpose: text("purpose").notNull(),

  dataMinimizationNote: text("dataMinimizationNote"),
  disclosedAt: timestamp("disclosedAt").defaultNow().notNull(),
});
```

`legalBasis = UNKNOWN` must block the crossing and route to review, per architecture rule 5. Book 17 PRV-DISC-001 already requires purpose, authority, data minimum, recipient and audit log to resolve before any disclosure.

---

## 8. Drug/alcohol and medical-adjacent handling

`HIGHLY_RESTRICTED` gets controls beyond the rest of the sector.

1. **Result, not record.** Store the operational outcome the business needs. Book 17 PRV-MIN-001 already makes this point with its own example: dispatch receives `FIT WITH RESTRICTIONS / no night driving / review 2026-10-01`, not a diagnosis and medication list. The same applies here — a fitness determination is derived from a test result by an authorized human; it is not the test result.
2. **Projection boundary is enforced server-side.** Books 30 and 39 both state supervisors see functional restriction and work capability, not diagnosis or full medical record. Implement as separate DTOs with an allowlisted projection, in the same pattern as the B20.3 roadside-inspection allowlisted DTO — not as a UI that omits fields from a full payload.
3. **Tighter grant.** `HIGHLY_RESTRICTED` grants take a shorter expiry, and a second approver (`secondApproverUserId`) is configurable per organization. Recommended default: required for drug/alcohol results, optional elsewhere.
4. **Separate permission.** Holding `restricted.read` does not imply access to `HIGHLY_RESTRICTED`. Medical-adjacent access is its own permission, held by fewer roles.
5. **Never a dispatch input.** A test result must not be readable by the dispatch eligibility gate. The gate consumes a fitness determination. `D&A TEST RESULT != FITNESS DETERMINATION`.
6. **Test result is not an incident.** Storing a result creates no incident, no matter, and no investigation proposal unless a human opens one.

Alberta PIPA reasonableness and notice obligations apply to collection and use here; Book 17 PRV-NOT-001 governs the notice, and acknowledgement of a notice is not consent and does not make an unreasonable practice lawful.

---

## 9. Retention and legal hold

**Owner decision:** retention is per record type; legal hold overrides retention.

```ts
export const recordRetentionRules = mysqlTable("recordRetentionRules", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),        // null = platform default

  recordType: varchar("recordType", { length: 60 }).notNull(),
  sensitivityTier: varchar("sensitivityTier", { length: 30 }).notNull(),

  retentionBasis: mysqlEnum("retentionBasis", [
    "STATUTE", "REGULATION", "CONTRACT", "INSURER_REQUIREMENT",
    "COMPANY_POLICY", "UNKNOWN",
  ]).default("UNKNOWN").notNull(),

  // [VERIFY DATA] — source-versioned, never invented
  ruleProfileId: int("ruleProfileId"),
  jurisdiction: varchar("jurisdiction", { length: 40 }),
  retentionMonths: int("retentionMonths"),
  anchorEvent: varchar("anchorEvent", { length: 60 }),  // e.g. CLAIM_CLOSED

  verificationStatus: mysqlEnum("verificationStatus", [
    "VERIFIED", "UNVERIFIED", "STALE", "UNCONFIGURED",
  ]).default("UNCONFIGURED").notNull(),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
});
```

Enforcement:

- **`UNCONFIGURED` or `UNVERIFIED` retention never authorizes deletion.** Unknown retention means retain and flag, per architecture rule 5.
- **Legal hold wins.** A record under hold is not deleted when retention expires. Book 49 already carries `MAJOR INCIDENT != NORMAL RETENTION MAY CONTINUE IF LEGAL HOLD APPLIES` and `INCIDENT CLOSED != LEGAL HOLD RELEASED`.
- **Hold release is a restricted action.** Per the B20.3 definition of done, legal-hold release is legal-role-only. That constraint carries into this subsystem unchanged.
- **Retention period values are `[VERIFY DATA]`.** Do not populate months from memory. Load from authority with provenance, or leave `UNCONFIGURED`.
- **Deletion is an audited event.** What was deleted, under which rule, by whom, when — the trace survives the content.

---

## 10. Offline capture of restricted content

The field is where near misses and injuries actually get reported, and the field is offline. But a restricted payload sitting in an unencrypted local queue on a driver's phone defeats the entire sector.

Rules:

1. **Capture is permitted offline.** A driver can report a near miss or an injury with no signal. Blocking that would suppress reporting, which is the opposite of the goal.
2. **The driver's device holds only what that driver authored**, and only until sync is acknowledged. On ack, the local copy is evicted — not merely hidden.
3. **Local restricted payloads are encrypted at rest** on the device, distinct from the ordinary evidence queue.
4. **Tier assignment is server-side.** The device does not decide sensitivity. It marks intent (`near miss`, `injury`) and the server classifies.
5. **No restricted read path on the driver device.** A driver cannot retrieve restricted records at all — including their own prior reports — through the field app. Retrieval is an office/admin function behind a grant.
6. **Sync conflicts on restricted records are never auto-resolved.** They route to human resolution, consistent with the offline-first rules in Manifest V8.
7. **The offline cache manifest must not list restricted records**, even as titles or counts. A cached index that reveals "3 restricted items" on a shared tablet is a disclosure.

---

## 11. Non-retaliation and reporter visibility

Near-miss reporting collapses the moment workers believe reports reach their supervisor with their name attached. Book 24 integrity controls and Book 39 WCB-WRK-001 already establish the principle — WCB explicitly provides a confidential channel for workers who feel pressured not to report.

Implementation:

1. **Reporter identity is stored but not broadly projected.** Safety analytics and trend views consume de-identified aggregates.
2. **Near-miss reports support optional anonymous submission** where company policy permits. The submission still produces a record; it simply carries no reporter identity.
3. **A near miss is not a disciplinary record.** `NEAR MISS REPORTED != DISCIPLINARY MATTER`. Linking a near miss to discipline requires a separate, authorized, audited act.
4. **The worker's right to report externally is never gated here.** Nothing in this subsystem may block, delay, or condition a worker's own report to WCB or OHS. `EMPLOYER DISAGREES WITH CLAIM != WORKER LOSES RIGHT TO REPORT` (Book 39).
5. **Accessing a report to identify its reporter is a purpose that must be stated.** The grant's purpose field makes that visible in review.

---

## 12. Tracking numbers

Per architecture rules 8 and 9, every artifact gets a human-readable number that is not the database identity, with format as configuration and transactional sequence generation.

| Artifact | Prefix | Notes |
|---|---|---|
| Incident (root) | `INC` | already in the canonical list |
| Insurance claim | `CLM` | outward-facing |
| WCB claim | `WCB` | outward-facing; distinct from insurer claim number |
| Regulatory report | `REG` | |
| Disclosure crossing | `DSC` | |
| **Any restricted-sector record** | `RR` | **category-neutral — see below** |

**Restricted numbers must not encode their category.** `DAT-2026-0041` discloses that a drug/alcohol test exists for someone the moment it appears in a reference, a filename, an email subject, or an exception list. Restricted records take a single neutral `RR` prefix drawn from one shared sequence; the actual category is a field inside the record, visible only behind a grant.

The same applies to display labels in any surface a non-grant-holder can see. Reference a restricted record as `RR-2026-000412` with no category adornment.

Concurrency on the `RR` sequence must be tested — a duplicate or a gap that reveals volume both matter.

---

## 13. Backend procedures and permissions

### 13.1 Permission namespace

Adopting the category-scoped evidence model proposed in the B20 notes, and retiring broad `evidence.read_all` for these categories:

```
evidence.read_safety_summary        de-identified aggregates only
evidence.read_personnel             HR-scoped, non-medical

restricted.read                     RESTRICTED tier, requires grant
restricted.read_medical             HIGHLY_RESTRICTED tier, requires grant
                                    (+ optional second approver)
restricted.grant_request            may request break-glass
restricted.grant_approve            may act as second approver
restricted.disclose                 may authorize a boundary crossing
restricted.amend                    may amend restricted content (audited)

investigation.propose_review        may see proposals
investigation.decide                may open or decline a proposal
investigation.read                  may read investigation content (+ grant)

retention.configure                 may set retention rules
legalhold.apply
legalhold.release                   legal role only (per B20.3 DoD)
```

Deny-wins behavior from the existing engine is retained. Note the B20 architectural point: broad grants plus explicit denials mean every new sensitive category requires remembering to add a shop/office denial. The restricted sector should be reached only by an explicit positive grant, never by a broad permission minus an exclusion.

### 13.2 Procedures

Every procedure below uses the role/scope authorization gate. **None may use bare `protectedProcedure`** — that is the specific failure the B20.3 definition of done closes.

```
incidents.create                        operational
incidents.get                           operational projection only
incidents.fanOut                        creates matters from obligations engine

matters.list                            tier-filtered at the query, not the UI
matters.get

obligations.evaluate                    pure fn; returns REQUIRED/NOT_APPLICABLE/REVIEW/UNKNOWN
obligations.complete

investigations.listProposals            investigation.propose_review
investigations.decide                   investigation.decide
investigations.get                      investigation.read + active grant

restricted.requestGrant                 restricted.grant_request
restricted.getRecord                    restricted.read (+_medical) + active grant
restricted.export                       logs EXPORT; blocked without grant
restricted.disclose                     restricted.disclose + legalBasis != UNKNOWN

retention.evaluate                      never deletes on UNCONFIGURED/UNVERIFIED
legalHolds.apply / .release
```

Additionally, adopt the second security test the B20 notes recommend pinning: **a procedure that exists with no declared permission mapping is an application test failure**, not merely a runtime denial. Otherwise a future developer adds `restricted.somethingNew: protectedProcedure` and silently bypasses the sector.

---

## 14. UI surfaces

| Surface | Audience | Shows |
|---|---|---|
| Incident detail | operational | root facts, outward matters, obligation deadlines. **No indication of restricted records.** |
| Matter board | office / claims | outward matters by status and deadline |
| Proposal queue | administration | pending investigation proposals, open/decline actions |
| Restricted sector | administration | category-neutral list; break-glass prompt on open |
| Access review | legal / auditor | `restrictedAccessEvents` with purposes, denials, patterns |
| Disclosure register | legal / privacy | `disclosureCrossings` with basis and recipient |
| Exception Centre | office / admin | entries per §15 |

Accessibility applies here as everywhere: per the existing A11Y tests, `BLOCKED / PENDING / UNKNOWN` states must be understandable without colour, the break-glass approval path must be keyboard operable, and a restricted-record action must not be voice-only.

---

## 15. Exception Centre entries

Each deep-links to the corrective action, per Manifest §25.

- WCB obligation `DUE` with deadline approaching — **[VERIFY DATA]**: only meaningful once a verified rule profile is loaded
- Obligation `UNKNOWN` because no rule profile is loaded for the jurisdiction
- Investigation proposal pending beyond configured window
- Break-glass grant used with no stated purpose recorded (should be impossible — surfaces as a data-integrity defect)
- Repeated denied restricted access attempts by the same user
- Disclosure crossing attempted with `legalBasis = UNKNOWN`
- Record past retention but under legal hold (informational — not actionable)
- Record past retention with `UNCONFIGURED` retention rule
- Restricted sync conflict awaiting human resolution
- Second-approver request outstanding on a `HIGHLY_RESTRICTED` grant

---

## 16. Critical invariants

Every line becomes a regression test, matching the Book 12/30/49 convention.

```
INCIDENT RECORDED            != CLAIM OPENED
INCIDENT CLOSED              != MATTERS CLOSED
INCIDENT CLOSED              != LEGAL HOLD RELEASED

INVESTIGATION PROPOSED       != INVESTIGATION REQUIRED
INVESTIGATION DECLINED       != INCIDENT ALTERED
INVESTIGATION DECLINED       != DECISION UNRECORDED
HANDLED INTERNALLY           != NO AUDIT OF THE DECISION
AI FLAGS INVESTIGATION       != INVESTIGATION WARRANTED

ADMIN ROLE                   != VAULT ACCESS
VAULT ACCESS                 != ACCESS WITHOUT STATED PURPOSE
BREAK-GLASS GRANTED          != DISCLOSURE AUTHORIZED
GRANT FOR ONE RECORD         != GRANT FOR THE SECTOR
GRANT EXISTS                 != GRANT UNEXPIRED
UI HIDES VAULT               != BACKEND DENIES VAULT

RESTRICTED REFERENCES INCIDENT != INCIDENT EXPOSES RESTRICTED
CLAIM PACKAGE ASSEMBLED      != RESTRICTED CONTENT INCLUDED
AI MAY CREATE RESTRICTED     != AI MAY RETRIEVE RESTRICTED

D&A TEST RESULT              != FITNESS DETERMINATION
D&A TEST RESULT              != INCIDENT
WCB CLAIM EXISTS             != DIAGNOSIS DISCLOSABLE
FUNCTIONAL RESTRICTION       != MEDICAL RECORD
NOTICE ACKNOWLEDGED          != CONSENT GIVEN

NEAR MISS REPORTED           != DISCIPLINARY MATTER
EMPLOYER DISAGREES           != WORKER LOSES RIGHT TO REPORT

RETENTION EXPIRED            != RECORD MAY BE DELETED
RETENTION UNCONFIGURED       != RETENTION SATISFIED
RECORD DELETED               != AUDIT TRACE DELETED

TRACKING NUMBER VISIBLE      != CATEGORY DISCLOSABLE
OFFLINE CAPTURE ALLOWED      != OFFLINE RETRIEVAL ALLOWED
SYNCED                       != LOCAL COPY EVICTED

UNKNOWN                      != PERMITTED
UNKNOWN                      != NOT APPLICABLE
```

---

## 17. Tests

Behavioural, not shape. Test exact states and named blockers.

**Authorization (negative-first)**
1. Operational role + valid restricted record id → `DENIED` at the API, not the UI
2. Admin role, no grant → `DENIED` with code `RESTRICTED_NO_ACTIVE_GRANT`
3. Grant request with empty/whitespace purpose → rejected, no content served, `GRANT_DENIED` logged
4. Grant for record A → `DENIED` on record B
5. Expired grant → `DENIED`; clock is server-side
6. Revoked grant → denied immediately, not at next login
7. `restricted.read` without `restricted.read_medical` → `DENIED` on `HIGHLY_RESTRICTED`
8. Second approver required and absent → `DENIED`
9. Audit-write failure → access fails closed
10. Any restricted procedure declared without a permission mapping → **build/test failure**

**Boundary**
11. Insurer claim package payload contains zero restricted fields — assert on the serialized payload, not the query
12. WCB submission payload contains no diagnosis
13. Analytics rollup and safety-trend query exclude restricted rows
14. AI Secretary retrieval returns no restricted content and no existence hint
15. Disclosure with `legalBasis = UNKNOWN` → blocked, routed to review
16. Cross-tenant restricted probe → denied and logged as security evidence

**Investigation discretion**
17. Decline writes a `HANDLED_INTERNALLY` disposition and **no** `internalInvestigations` row
18. Decline leaves incident and outward matters byte-identical
19. Open requires non-null `matterId`; decline requires null `matterId`
20. Declined proposal remains visible to legal/auditor and is not purgeable by normal workflow
21. Rejected proposals remain available for pattern analysis (Book 12 AUD-003)

**Retention / hold**
22. Retention job skips records under legal hold
23. Retention job skips `UNCONFIGURED` and `UNVERIFIED` rules
24. Legal-hold release by non-legal role → `DENIED`
25. Deletion writes an audit event that survives the content

**Offline**
26. Driver device local store holds no restricted payload after sync ack
27. Offline cache manifest exposes no restricted titles or counts
28. Restricted sync conflict routes to human resolution, never auto-merges
29. Driver restricted read attempt → denied on device and at server

**Numbering / concurrency**
30. `RR` tracking number encodes no category
31. Concurrent `RR` generation under load → no duplicates, no revealing gaps
32. Two concurrent grants for the same record by the same user → one active grant

**Obligations**
33. No loaded rule profile → `UNKNOWN`, never `NOT_TRIGGERED`
34. Obligations resolve independently — WCB `DUE` while insurer `COMPLETE`
35. Jurisdiction change re-evaluates against the correct profile

---

## 18. Definition of done

Per Manifest §37, this subsystem is complete only when all of the following hold together:

- B20 branch reconciled; migration 0020 active-grant uniqueness fixed
- Zero restricted-sector procedures on bare `protectedProcedure`
- Schema + forward migration + indexes + FK verification
- Server-enforced authorization on every procedure, with declared permission mapping
- Break-glass gate functional, purpose mandatory, audit written before content served
- `restrictedAccessEvents` and audit tables append-only and verified as such
- Directional boundary asserted on serialized outward payloads
- Retention + legal hold enforced, with hold overriding retention
- Offline capture works; offline retrieval blocked; local eviction verified
- Category-neutral tracking numbers, concurrency-tested
- Exception Centre entries wired and deep-linked
- Every §16 invariant has a passing regression test
- Negative and authorization tests pass
- `tsc --noEmit` clean, full test suite, production build, migration parity from a clean database
- Test counts reported separately: this subsystem / pre-existing / DB-environment / build

A schema table, an endpoint, and a screen do not constitute completion.

---

## 19. Migration plan

Sequenced after B20 reconciliation. Do not fold these into an already-applied migration.

1. **Prerequisite** — fix 0020 active-grant uniqueness (generated `activeGrantKey`, `NULL` for revoked rows, `UNIQUE(activeGrantKey)`).
2. `incidentMatters`, `incidentObligations` + indexes; backfill existing incidents into the spine where matters are already implied.
3. `investigationProposals` + the open/decline constraint.
4. `restrictedAccessGrants`, `restrictedAccessEvents` (append-only), `disclosureCrossings`.
5. `recordRetentionRules` seeded `UNCONFIGURED` for every record type — **no invented periods**. Reconcile against migration 0015 rather than creating a competing retention model.
6. Permission seeds for the `restricted.*` and `investigation.*` namespace; retire broad `evidence.read_all` for these categories.
7. `RR` sequence with transactional generation.

Each step: test on a disposable database, verify FKs and parity, document rollback.

---

## 20. Open decisions for the owner

These are genuine forks, not implementation details. Each changes the schema or the gate.

1. **Who is "administration" for vault purposes?** A single `admin` role, or a distinct `records_custodian` / `privacy_officer` separate from operational admin? Book 17 SEC-PRIN-001 calls for separation of duties, and the person who runs dispatch is not automatically the right person to read a drug test.
2. **Break-glass duration.** Default expiry for `RESTRICTED` and for `HIGHLY_RESTRICTED`.
3. **Second approver — mandatory for drug/alcohol results, or configurable?** Recommended mandatory; your call.
4. **Who can see a declined proposal?** Legal/auditor only, or also management?
5. **Is `decisionReason` required on decline, or optional?** Currently optional by design — requiring a reason edges back toward compelling justification.
6. **Anonymous near-miss reporting — permitted?** Improves reporting rates; complicates follow-up.
7. **Retention periods per record type** — `[VERIFY DATA]`. Needs an authoritative source per jurisdiction before anything is populated.
8. **Cross-border scope.** If the fleet operates outside Alberta, obligation and retention profiles are needed per jurisdiction before this subsystem can report deadlines at all.

---

## 21. What this spec does not do

- It does not implement WCB claim lifecycle — Book 39 owns that.
- It does not implement insurance claim lifecycle, coverage review, subrogation or recovery — Book 30 owns those.
- It does not implement incident command or crisis escalation — Book 49 owns that.
- It does not determine medical fitness, WCB entitlement, or coverage. AI and this subsystem record and route; authorized humans and authoritative systems decide.
- It does not supply a single regulatory deadline or retention period. Every such value is `[VERIFY DATA]` and must be loaded from authority with provenance.
