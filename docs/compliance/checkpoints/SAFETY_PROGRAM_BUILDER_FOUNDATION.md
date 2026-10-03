# Safety & Compliance Program Builder — foundation (0228)

Status: **complete on branch `claude/safety-compliance-program-builder-2qnty0`** (PR #99), with main (`48a64e1`) merged in.

**Integrating with main.** Merging main brought four guards this branch had not met, and the router now uses
the paths they require: qualifications through `effectiveQualifications`; carrier and unit documents through
`complianceDocumentValidity` (registered as a known reader); the program's financial entity proved with
`assertEntityInScope`; and the database suite draws user ids from its own band (228,000,000), clear of every
other suite's.

**Tenant boundary review (follow-up to PR #99, which merged at `144c07b` before this review finished).** Every identifier a procedure accepts is proved against the
caller's organization before anything is stored or read through it, and refuses as NOT FOUND:

| Identifier | Procedures | Proof |
|---|---|---|
| `financialEntityId` | `programSet` | `assertEntityInScope` |
| user ids (`ownerUserId`, `assignedToUserId`, `workers[].userId`) | `policyCreate`, `correctiveActionOpen`, `trainingMatrixCompute` | main's `userInScope` |
| `customerAccountId` | `overlaySet` | `customerAccounts` through main's `orgScopeWhere` |
| evidence ids (`sourceEvidenceRecordId`, `evidenceRecordId`) | `overlaySet`, `correctiveActionProgress` | main's `evidenceInScope` |
| overlay refs (`clientOverlayRefs`, `overlayRef`) | `versionDraft`, `trainingRequirementUpsert` | `clientPolicyOverlays` in the caller's scope |
| `policyRef`, `versionRef`, `reviewRef`, `overlayRef`, `requirementRef`, `actionRef` | their procedures | the row's own `orgRef` / `scopeKey` |

Before this review, `trainingMatrixCompute` accepted any user id and read that person's training records into
the caller's matrix, and the other user, customer, evidence and overlay ids were stored unchecked. Three more
boundaries were tightened: regulatory references are shared by every organization, so `referenceUpsert` and
`referenceVerify` now run only from the platform (single-tenant) scope; `events` shows an organization its own
events only, not platform catalog work or who across the platform did it, and a chain break outside the
caller's organization is reported without its reference; and in the single tenant the workforce and COR counts
now follow main's 0132 rule (people with no organization membership; jobs with no organization) instead of
counting every organization's rows. `clientOrgRef` names a counterparty by reference only and nothing reads or
writes through it; `sourceRef`, `deviceRef` and `packRef` are labels or catalog keys. Scope helpers are main's
own (`userInScope`, `evidenceInScope`, `orgScopeWhere`, `assertEntityInScope`).

**One chain under concurrency** (migration `0237`, a follow-up after #99 merged with `0228`; drafted as `0233`,
then `0236`, and moved above the slots other branches had since claimed; a new file because the migration ledger refuses an
edited, applied one). `safetyProgramEvents.previousHash` is UNIQUE, so two writers that read the same
head cannot both link to it; the loser re-reads the head and retries. Before, concurrent writes could fork the
chain and `verifyChain` would report a break that was never tampering.

The database suite's second case proves each refusal from another organization, the platform-only rule for
references, own-scope events, the single-tenant workforce rule, and an intact, fork-free chain after six
concurrent writes. Removing the matrix worker check, the reference scope rule or the ledger retry each makes it
fail.

**Migration slot.** Drafted as `0182`. On merging main, document control had claimed `0182` and main's head was
`0227`, so the migration moved to `0228` — the first slot above every slot in use on main and all 131 remote
branches. It creates only new tables and depends on nothing after `0174`. The register and
`server/migrationSlots.test.ts` record the move. This is the
data model and template engine, plus the first two categories of the Alberta Commercial/Oilfield content
pack: company foundation (19 templates), occupational health and safety (39), commercial trucking / National
Safety Code (41) and oilfield and industrial operations (36), loaded as drafts.
Every other template is a skeleton and every regulatory reference seeds unverified. Further categories load
one at a time into the keys this checkpoint creates.

## Why it is its own subsystem

Alberta keeps two requirements apart: a National Safety Code carrier must have written and *implemented*
safety and maintenance programs, and an OHS program alone does not satisfy that; an employer of 20 or more
regularly employed workers must have a health and safety program, and committee or representative duties
follow workforce size. A COR audit then scores documentation, interviews and observation — a policy that
exists proves the first only. So the model is organized by **module** (14, in the order of the library) and by
**pack** (core, Alberta OHS, Alberta NSC, federal carrier, Saskatchewan, British Columbia, oilfield, hydrovac,
ground disturbance, client, company), and every policy is a controlled object with evidence that it operates.

The 0036 pair `writtenProgramVersions` / `programAcknowledgements` is untouched: it stays the compliance
registry's record that a program was published (`compliance.programPublish`). This is where a program is
authored, versioned by section, acknowledged per version and measured.

## Tables (14, migration `0228_safety_program_builder.sql`)

| Table | What it is |
|---|---|
| `safetyProgramModules` | The 14 library modules; `codePrefix` mints policy codes (`HSE`, `OHS`, `NSC`, `OIL`, `GD`, `WHM`, `ERP`, `INC`, `CON`, `LW`, `ENV`, `TRN`, `CTR`, `VEN`) |
| `policyTemplates` | The template registry: 284 platform templates from `server/_core/safetyProgramCatalog.ts`, each with module, pack, document kind, skeleton sections, content hash, default acknowledgement/review/owner, cited reference keys; `orgRef` set = a company's own template |
| `regulatoryReferences` | Citations by key (`ab.ohs_code.part28_working_alone`, `ca.tdg.regulations.part6_training`, …): 32 seeds, all **unverified**; a person verifies, and never the person who recorded it; editing a verified citation un-verifies it |
| `policyRegulatoryLinks` | Template ↔ reference and policy ↔ reference |
| `companySafetyPrograms` | One per organization: name, operations profile, selected packs and modules, assembly hash |
| `companyPolicies` | The controlled object: server-minted `policyCode` (`HSE-POL-001`, unique per scope), template lineage, owner and approver roles, current version, acknowledgement requirement, review interval and next review |
| `policyVersions` | Immutable after approval; `versionHash` chains over `previousVersionHash`, `contentHash`, number and policy; preparer, approver, effective, superseded, withdrawn all named |
| `policyAcknowledgements` | One per (version, person): `readAt`, `understoodAt`, `questionsAnsweredAt`, `signedAt`, `signatureHash` over the version hash the worker saw |
| `clientPolicyOverlays` | Client-specific requirements (Suncor, Cenovus, CNRL, …) layered on a policy or module, with their source |
| `policyReviews` | Scheduled and triggered reviews; `revision_required` opens a corrective action on the owner |
| `trainingRequirements` | Position → requirement (external certificate, company training, client orientation, policy acknowledgement, equipment competency), with enforcement and renewal; platform-scoped rows apply to every company |
| `companyTrainingMatrix` | Snapshot rows of one computation (`computationRef`), never a live view; each row says the evidence it relied on |
| `correctiveActions` | Source, owner, due date, completion by one person, verification by another; overdue derived from `dueAt` |
| `safetyProgramEvents` | Append-only, hash-chained ledger of every write; `events({ verifyChain: true })` walks it |

`scopeKey = COALESCE(orgRef, 'platform')` on the tables whose unique indexes must see the tenant split.
Schema/migration parity after merging main: **479 / 479**. Column parity was run against the applied migration (MariaDB 10.11).

## Engine (`server/_core/safetyProgram.ts`, pure)

- `programObligations(profile)` — what a profile obliges, each line naming the reference key it rests on.
- `recommendedPacks` / `recommendedModules` / `assembleProgram` — core always; a template is in when its pack
  and module are selected; the assembly hash changes with the selection and with a template version.
- `policyCode(prefix, kind, seq)` — `HSE-POL-001`; `versionHash`, `contentHash`, `signatureHash`, `eventHash`.
- `approvalDecision` — draft only, never the preparer, approver role checked (management may always approve).
- `acknowledgementDecision` — read → understood → questions → sign, approved version only, no repeat after signing.
- `trainingMatrixFor` — verified evidence beats unverified, later expiry beats earlier, expiry derived from
  issue date and renewal when the record has none; a signature on a superseded version is `missing`.
- `verificationDecision` — completed only, never the completer. `correctiveActionView` derives overdue.
- `corReadiness(evidence)` — ten elements, each with reasons; "ready" needs operating evidence, a document alone
  is at best "attention", nothing at all is "no_evidence".
- `vendorPackageManifest` — what the package would hold and what is missing by title; an expired COR is missing.

## Content packs (`server/_core/safetyProgramContentPacks.ts`)

A content pack is one category of the Alberta Commercial / Oilfield Safety Template Pack. Category 1,
**company foundation**, is written: 19 templates in `server/_core/safetyProgramContent/companyFoundation.ts`
(mission, philosophy, management commitment, the health and safety / environmental / quality /
transportation safety / maintenance policies, stop-work authority, worker / supervisor / management /
contractor responsibilities, code of conduct, ethics, regulatory compliance, client and site rules,
enforcement and discipline, document control). The text names the company and its officers only through
merge fields (`{{company.name}}`, `{{company.president}}`, `{{company.safetyManager}}`, `{{policy.code}}`,
`{{policy.version}}`, `{{policy.effectiveFrom}}`) and cites no section number of any instrument — a test
holds both. `syncContent` loads a pack: a skeleton becomes a **draft**, a draft whose text changed in code is
re-issued as a new template version, and a template a person has marked **reviewed** is never overwritten
(it is listed as skipped). `versionDraftFromTemplate` renders a company's first version from its template
with the program's name and the supplied officers; a field it cannot fill stays visible in the text and is
named in the response.

Category 2, **occupational health and safety**, is in `server/_core/safetyProgramContent/ohs.ts`: 39
templates covering hazard assessment (policy, formal assessment, FLHA, JHA, JSA), the safe work practice and
safe job procedure systems, orientation (including young and new workers), competency and training, PPE,
respiratory protection, hearing conservation, eye/face and hand protection, fall protection and working at
heights, working alone, fatigue, fitness for duty, impairment, heat and cold stress, ergonomics,
housekeeping, slips and trips, lockout, machine guarding, electrical safety, fire prevention, inspections,
corrective actions, safety meetings, the right to refuse, near-miss reporting, the Alberta 20-worker health
and safety program (mapped element by element to the documents that satisfy it) and the committee or
representative. The few figures the text states — the 3-metre fall-protection threshold, the 85 dBA exposure
limit, the 20-worker and 5-to-19-worker committee and representative thresholds — are the ones a reviewer must
confirm against the instrument as consolidated; a test holds the committee thresholds in the text equal to the
ones the obligations engine uses.

Category 3, **commercial trucking / National Safety Code**, is in `server/_core/safetyProgramContent/nscTrucking.ts`:
41 templates covering driver qualification, abstracts and licence verification; hours of service, ELD and
sleeper berth; driver fatigue; dispatch and driver responsibility and the no-coercion rule; speed, seat belts,
distracted and defensive driving, backing; journey management, winter, adverse weather, mountain, remote and
radio-controlled roads; load, cargo and equipment securement; weights and road bans; TDG by road, shipping
documents and placarding; fueling; pre-trip and post-trip inspection, defect reporting, out-of-service
equipment, CVIP tracking, preventive maintenance, repair authorization, tires and coupling; collision
reporting, roadside inspection response, carrier profile monitoring and progressive correction. With the
Transportation Safety Policy and Maintenance Policy from category 1, these are the carrier's written safety and
maintenance programs. **Hours-of-service limits are not restated**: the policies point to the LeaseOS rule
profile that the duty-status engine enforces, and a test holds them free of hour figures so the text cannot
disagree with what is enforced. Figures stated (24-hour trip inspection validity, 12-month abstract review,
cargo-securement WLL and g-force criteria) are for the reviewer to confirm against the instruments.

Category 4, **oilfield and industrial operations**, is in `server/_core/safetyProgramContent/oilfieldIndustrial.ts`:
36 templates — 26 in the oilfield pack (orientation, site entry, prime contractor, permit to work, SIMOPS, line
of fire, pinch points, H2S, gas detection, the H2S emergency response plan, ignition control, flammable
atmospheres, bonding and grounding, hot work, confined space and tank entry, pressure, stored energy,
high-pressure lines, rig moves, spotters, heavy equipment, exclusion zones, lifting, rigging, suspended loads)
and 10 in the hydrovac / vacuum truck pack (hydrovac excavation, vacuum trucks, tank cleaning, pressure
washing, fluid and chemical transfer, loading, produced water, sewage, waste and disposal sites). Figures
stated (19.5 per cent oxygen; H2S deadening smell at around 100 ppm; the 10 ppm and 15 ppm H2S limits) are for
the reviewer to confirm. Figures that vary by site — gas alarm set points, LEL limits for hot work, spacing
from wellheads, hydrovac pressure and temperature near buried facilities — are not invented: the text names
who sets each (the safety manager, the permit, the client's site rules, the facility owner), and a test refuses
any distance, pressure or LEL figure in the pack.

Content in every category is written through per-kind builders (`safetyProgramContent/shared.ts`), and the
integrity check now also refuses a template whose headings differ from its skeleton's, in order.

## API (`server/safetyProgramRouter.ts`, mounted as `safetyProgram`, 38 procedures, all `roleProcedure`)

Library: `catalog`, `templateDetail`, `syncCatalog`, `syncContent`, `referenceList`, `referenceUpsert`,
`referenceVerify`. Program: `obligations`, `programGet`, `programSet`, `assemble`. Policies: `policyCreate`,
`policyList`, `policyDetail`, `versionDraft`, `versionDraftFromTemplate`, `versionEdit`, `versionApprove`,
`versionWithdraw`, `policyRetire`.
Acknowledgement: `myPolicies`, `acknowledge` (self-scoped), `acknowledgementStatus`. Overlays and reviews:
`overlaySet`, `overlayList`, `reviewSchedule`, `reviewComplete`. Training: `trainingRequirementList`,
`trainingRequirementUpsert`, `trainingMatrixCompute`, `trainingMatrix`. Corrective actions:
`correctiveActionOpen`, `correctiveActionProgress`, `correctiveActionVerify`, `correctiveActionList`.
Readiness: `corReadiness`, `vendorPackageManifest`, `events`.

The organization is the caller's acting scope (`resolveActingScope`), never input. Another organization's
policy is **not found**, never forbidden. The catalog and references are platform-level.

### Permissions

| Permission | Holders | Sensitive |
|---|---|---|
| `safety_program.read` | safety, management, hr, office, auditor, legal, controller | no |
| `safety_program.write` | safety, management, hr | no |
| `safety_program.manage` (library sync, program selection, requirements, references) | safety, management | yes |
| `safety_program.approve` (versions, withdrawals, retirement, review outcomes) | safety, management | yes |
| `safety_program.verify` (corrective actions, references) | safety, management | yes |
| `safety_program.read_own` (`myPolicies`) | universal, self-scoped | no |
| `safety_program.acknowledge_own` (`acknowledge`) | universal, self-scoped | yes |

Operational procedure map: +38 (634 → 672 on the branch; 820 → **858** after merging main). Router surface: 898 → **936** after merging main. Universal permissions: 13 → 15. Bare `protectedProcedure`: 0.

## Evidence the matrix and readiness read

Training matrix holdings: qualifications come only through main's canonical adapter,
`effectiveQualifications` (`server/qualificationReads.ts`), which applies the Academy-over-legacy rule, the
evidence-document check and the organization boundary; the matrix maps its verdict (held → verified;
expired → expired; unverified or pending → pending verification; none or rejected → not held) and never
re-decides it. Company `trainingRecords` are read directly (verified = `verificationStatus = verified`), and
`policyAcknowledgements` against each policy's current version. Workforce: `organizationWorkers` (active, with
a user) for an organization; in the single tenant, everyone holding an active role.

COR readiness interim sources, named in the response (`evidenceSources`): hazard assessments =
`tailgateMeetings` (90 days); safety meetings = `safetyEvents` typed `safety_meeting` / `toolbox_talk` (90
days); drills = `safetyEvents` typed `emergency_drill` (12 months); inspections = `inspections.observedAt`
(90 days); incidents = `incidentReports` + `nearMissReports` (12 months), investigated = has an
`incidentActions` row. For an organization these count through the job's `orgRef` or the unit's ownership;
rows with no job are not counted for a multi-tenant organization. A dedicated hazard-assessment record and
a drill record are follow-ups, not this checkpoint.

Vendor package documents: `complianceDocuments` on the program's `financialEntityId` (`cor_certificate`,
`wcb_clearance`, `insurance_proof`, `safety_fitness_certificate`) and `cvip_certificate` per unit in scope, each
judged by main's canonical `complianceDocumentValidity` rather than a date comparison here; the router is
registered as a known `complianceDocuments` reader in `server/complianceValidityGuard.test.ts`. `programSet`
proves a named financial entity belongs to the caller's organization with `assertEntityInScope` before storing
it, so the manifest only ever reads the caller's own entity. `cor_certificate` is not yet a seeded requirement
doc type; the manifest names it as missing until one is filed. The PDF/ZIP archive is not built here — the
manifest is.

## Tests

- `server/_core/safetyProgram.test.ts` — 50 cases (content pack integrity, heading order, merge fields, OHS, trucking and oilfield content checks included): catalog integrity (unique keys, real modules and packs,
  every cited reference exists, seeds cannot carry a verification), obligations by profile, assembly and its
  hash, policy codes, version chain, approval and edit rules, acknowledgement steps, matrix statuses and
  evidence choice, corrective-action rules, COR readiness by evidence, manifest, ledger chain, packs.
- `server/safetyProgram.db.test.ts` — one end-to-end run against the applied schema: idempotent sync, role
  refusals, obligations, program set and assembly coverage, `HSE-POL-001` / `HSE-POL-002` / `OHS-FRM-001`,
  preparer refused as approver, immutability after approval, another organization not found, stepwise
  acknowledgement with signature bound to the version hash, workforce acknowledgement status, training
  requirement and matrix (signature counts, then a new version makes it missing again; the earlier run is
  history), review → corrective action, overlay, overdue action, completer refused as verifier, recorder
  refused as verifier, edited citation un-verified, COR readiness reasons, manifest gaps, chain intact.
- `server/procedureAuthorization.test.ts`, `operationalApiAuthorization.test.ts`,
  `_core/recordsAuthorization.test.ts` — updated pins (670 procedures; the universal list).

## Validation at this checkpoint

Run here against a local MariaDB 10.11 with `scripts/ci-gate.sh` (results recorded in the commit message and
below when the gate completes). Typecheck clean; test-file typecheck adds no errors; parity 424/424.

## Not in this checkpoint

Policy body content beyond company foundation, OHS, trucking and oilfield (every other template is a skeleton; the written text is
a draft a person adapts and reviews before it is marked reviewed); verification of any regulatory reference (all
unverified — provision numbers are what the template authors worked from and must be checked against the
instruments as consolidated); a client UI; the PDF/ZIP vendor package; a hazard-assessment record and a drill
record of their own; Saskatchewan and British Columbia pack content (the packs exist as overlays with no
templates); dispatch enforcement of `trainingRequirements.enforcement` (the readiness composer still reads
the Academy's requirements — binding the matrix to it is a later step).
