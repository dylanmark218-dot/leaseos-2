# Follow-up: compliance-related persistence without organization scope

Tracked follow-up from C1a. The owner instruction was: do not repair every tenancy issue in C1a, add
no new unscoped compliance persistence, and track the existing gaps with exact tables and the
remediation dependency. C1a added `orgRef` to the two tables it touched (`dispatchEligibilityChecks`,
`dispatchOverrides`, migration 0172) and scoped every `dispatch.*` procedure on the readiness path.

"Platform" means the row is the same law for every tenant (NULL `orgRef` = platform, by design). For
those, the fix is not a tenant column. The fix is to stop tenants *writing* them without a platform
role.

| Table / surface | What is missing | Risk today | Remediation | Depends on |
|---|---|---|---|---|
| `complianceRequirements` | no `orgRef`; `requirementLoad` writes are global | a tenant's company-policy requirement would apply to every tenant | `orgRef` NULL = platform law; tenant packs carry their org; writes of platform rows need a platform role | C1b (registry reconciliation) |
| `compliancePacks` | no `orgRef` (activations use `financialEntityId`) | client/site packs cannot be tenant-owned | as above; `packKind` + `orgRef` | C1b / C8 |
| `complianceDocuments` | no `orgRef`; scoped only through the owner row | readers that do not join through the owner can cross tenants | add `orgRef`, backfilled from the owner's `coreRecordOwnership` | D-05 credential decision |
| `externalDataSources`, `knowledgeSources`, `knowledgeDocuments`, `knowledgeVersions` | no `orgRef` | platform source registry: acceptable **if** writes are platform-only | restrict writes to a platform role; keep global | C1b / C11 |
| `hosRuleLimitHistory` (and `hosRuleProfiles`/`hosRuleLimits`) | no `orgRef` | platform law: acceptable; promotion is already two-person | keep global; document it as platform | C1b (generalized ledger, D-03) |
| `evidenceRecords`, `evidenceVersions`, `evidenceSeals` | no `orgRef`; scoped via `jobId`/`capturedBy` (`evidenceInScope`) | evidence without a job is scoped by its capturer only | add `orgRef`, backfilled from job or capturer membership | C9 |
| `legalHolds`, `legalHoldRecords` | no `orgRef` | a hold is visible or placeable across tenants | add `orgRef`; scope `records.legalHold.*` | C9 |
| `retentionPolicies`, `recordRetentionState` | no `orgRef` | company retention settings are global | `orgRef` NULL = platform statutory minimum; tenant rows for company/contract retention | C9 |
| `auditPackages`, `auditPackageItems`, `auditPackageAccess` | no `orgRef`; `auditRouter.packageList` filters by `subjectRef` only | a package list can show another tenant's packages | add `orgRef`; scope every `audit.*` procedure | C9 |
| `exceptionCentre.loadExceptionSources` (surface) | takes no tenant scope | exception centre rows can cross tenants | pass the acting scope through `surfacesService` | independent; small |
| `communicationPolicies` (surface) | `currentCommunicationPolicy` ignores `scopeType`/`scopeRef` | one branch's policy governs every branch | honour scope in the resolver | independent; small |
| `dispatchEligibilityChecks`, `dispatchOverrides` rows written **before 0172** | `orgRef` NULL | read as the historical single tenant (`default`), the 0132 rule | none needed; documented | — |
