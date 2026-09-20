# Project knowledge — coverage audit (2026-09-20, against `6b4b232` / v23.24)

Every document in the project was checked against what the repository actually contains: 408 tables,
~200 engines, 48 routers, 291 test files. This records what is built, what is specified but absent,
and one structural problem that matters more than any individual gap.

---

## 0. The finding that outranks the rest: the knowledge does not travel

The project lists roughly **180 documents**. Exactly **15 are mounted as files**:

```
LEASEOS_CLIENT_ARCHITECTURE_AND_BUILD_SEQUENCE.md   LeaseOS_Commercial_Office_Administration_Hub
LEASEOS_DRIVER_MEDICAL_QUALIFICATION_VAULT.md       LeaseOS_Contact_..._Directory_Build_Plan.pdf
LEASEOS_RESTRICTED_RECORDS_VAULT.md                 LeaseOS_Live_Assist_Unified_AI_v1_0.pdf / v2_0.pdf
LeaseOS_Canada_HOS_Compliance_Logbook.pdf / _v2      LeaseOS_Specialized_Freight_Compliance_v1.pdf
Leaseos_contact_list                                 Mapping_and_routing_engine_ / _2 / _truck_routing_3
_work_order_que_for_project_projection_
```

The other **~165 are retrievable by search but exist nowhere on disk** — the 35 policy Books, the
~15-document legal suite, the ROR-A/B/C/D series, the AI-secretary specs, the compliance master
register, the portal architecture.

That is fine while the work happens here, because search reaches them. It stops being fine the
moment the work moves. **A repository bundle carries the code and none of the specification.**
Anything picking up this build from `leaseos-v23.24.bundle` would be working from the code plus
whatever is in `docs/` — and `docs/` holds nine files, none of which are policy books.

This is the thing to fix before moving forward, and it is mechanical rather than hard: export the
~165 into `docs/knowledge/` so they are versioned alongside the code that implements them.

---

## 1. Built, and matching the specification

| Family | Evidence |
|---|---|
| Policy / requirement engine | 10 tables, 11 engines, 32 requirement seeds |
| Audit, records, retention (Book 12) | 21 tables, `auditPackage`, `retentionPolicy`, `recordsAuthorization` |
| Hydrovac / disposal / manifest (Book 06) | 20 tables, 8 engines, `manifestCustody`, `loadSense`, `disposalReconciliation` |
| Mapping / routing / GPS | 24 tables, `osmImport` / `osmTopology` / `osmLoad`, `roadGraph`, `routeEvaluation` |
| Radio / communications | 29 tables, `commPackage`, `commRoute`, `crewChannels`, `radioChannelSeeds` |
| AI secretary | 9 tables, `assistantExtraction` → `aiProposal` → `assistantCommitService` |
| Billing / invoicing | 20 tables, `fieldTicket`, `linePricing`, `invoiceDraft`, `billingAdjustment` |
| Training / competency (Book 11) | `trainingAcademy` + regulatory catalogue, `academyQualifications` |
| Taxes (GST / IFTA / CCA) | 10 tables, `gstReturn`, `iftaEngine`, `taxRuleEngine`, `capitalAssets` |
| Restricted records vault | `restrictedAccessGrants` / `restrictedAccessEvents` — matches the owner decisions |
| Workforce / payroll | 11 tables, `payrollEngine`, `workerLifecycle`, `openShifts`, `timeOff` |
| Grants / rebates | 6 tables, `fundingIntelligence`, `fundingProgramSeeds` |

---

## 2. Gaps where a gate exists and its data source does not

These are the sharp ones, because the *decision* logic is written and correct — what is missing is
anywhere to read the input from. A correct gate fed by nothing returns `UNKNOWN` forever.

### 2.1 Permits — no table

`dispatchReadiness.ts` handles permits exactly as §7 requires: three-valued, with `permitOnFile: null`
producing `permit_unknown` rather than a pass.

```ts
if (input.job.permitRequired) {
  if (input.job.permitOnFile === false) { code: "permit_missing" }
  else if (input.job.permitOnFile === null) { code: "permit_unknown" }
}
```

**There is no `permits` table anywhere in 408 tables.** The caller has to supply `permitRequired` and
`permitOnFile`, and has nowhere to read them from. The gate is right; the record behind it was never
built. Permits appear in the custom instructions eight times — dispatch eligibility, TDG routing,
oversize/overweight, ERP, the offline cache, the manifest chain.

### 2.2 TDG reference data — a free-text field with nothing to check it against

TDG *shipping* data exists as columns: `unNumber varchar(20)`, `properShippingName varchar(220)`,
`packingGroup varchar(40)`, `dangerousGoodsClass varchar(20)`.

What does not exist:

- **no UN-number reference set** — so `unNumber` accepts any string, and §11's "never invent a UN
  number" has no counterpart rule that could *catch* an invented one
- **no placard derivation** — placards are a listed output in §11 and a `placards` enum value in a
  document category, with no engine producing them
- **no SDS storage** — §16 lists SDS in the pre-departure offline cache; there is no SDS table
- **no ERAP registration** — `erap` appears only in training-topic coverage, not as an operational record

`tdgCertificateContents` and `tdgTopicCoverage` are real and well-sourced, but they are about
*training certificates* for TDG, not about classifying a load.

---

## 3. Documents with owner decisions already taken, and no code

| Document | Decisions | Repo state |
|---|---|---|
| **Driver medical & qualification vault** (39 KB + owner decisions 2026-09-17) | opt-in uploads, licence condition codes, insurance ties | `workerQualifications` / `qualificationTypes` exist. **Nothing medical**: no opt-in tier, no condition codes, no fitness-to-work record |
| **Contact / communications / emergency directory** (315 KB — the largest single document) | full build plan | `crews` / `crewMembers` / `jobCrewAssignments` exist. **No contacts table, no emergency contacts, no next-of-kin, no muster points** |

Both were decided on and neither was built. The emergency directory is the one I would rank first on
consequence: muster points and emergency contacts are the records whose absence is only discovered
during the event that needs them.

---

## 4. Policy Books with no representation

32 requirement seeds against 35+ books in the manifest. Books that appear **nowhere** in the code or
in the existing build register:

- **Book 10 — Environmental Protection, Spill Response & Emergency Management** — zero tables. The
  domain where "unknown is not safe" carries the most weight, and the least built.
- Book 08 — Forestry & Logging
- Book 23 — Business Continuity & Disaster Recovery
- Book 24 — Ethics & Whistleblower
- Book 25 — Landowner, Community & Indigenous Relations
- Book 26 — Journey Management & Remote Travel
- Book 27 — Camp, Travel & Workforce Lifestyle
- Book 31 — Wildlife & Animal Encounters

Books 26 and 31 are worth separating from the rest: journey management and wildlife-vehicle safety
are *operational* in a way that ethics policy is not — they belong to the trip, and the trip is built.

---

## 5. Specified layers with no counterpart

- **Scenario engine ("what happens if")** — `projections` and `calendarProjection` exist; neither
  models a scenario. No scenario tables.
- **Language / communication mediation layer** — nothing. No translation, no language preference on
  worker or customer records.
- **Emergency health & worker welfare layer** — nothing.

---

## 6. Recommended order

1. **Export the ~165 unmounted documents into `docs/knowledge/`.** Everything else in this list is
   discoverable from the specification; the specification is currently discoverable only from here.
2. **Permits table.** The gate is already written and already correct. This is the highest
   ratio of unblocked behaviour to work in the entire list.
3. **TDG reference set + SDS storage.** Turns `unNumber` from a free-text field into a checkable one,
   and fills a named hole in the offline cache.
4. **Emergency directory + muster points.** Decisions taken, plan written, consequence asymmetric.
5. **Driver medical vault.** Decisions taken 2026-09-17.
6. **Book 10 environmental/spill**, then Books 26 and 31 as trip-attached rules.

Items 2 and 3 are the ones that change what the system can currently *refuse*. The rest add
coverage; those two close gates that are presently open because nothing feeds them.
