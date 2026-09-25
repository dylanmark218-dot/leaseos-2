# Unit scope sweep — mutations that take a unit id from the request (2026-09-25)

Found while fixing `fieldRoute.trips.create` (commit `18f3f68`). **Recorded, not fixed**: the owner asked
for the findings before any wider remediation.

The invariant `trips.create` now holds: *a caller may not write a record naming a unit the caller's
organization cannot see, and the refusal is "not found".* `roleProcedure` checks a role, never a tenant,
and the schema declares no foreign keys, so a unit id that is not checked in the procedure is written
as given — another organization's, or one that does not exist.

Method: every `roleProcedure` mutation in `server/*Router*.ts`, `server/routers.ts` and
`server/recordsRouter.ts` whose input takes `unitId`, `trailerId`, `unitIds` or `assignedUnitId`, with
no `unitInScope` / `workOrderInScope` / `ownershipScopeWhere` / `recordBelongsToOrganization` in its
body, then each path followed through its services by hand. Line numbers are at `18f3f68`'s parent.

| # | Procedure | Class | What a foreign unit id reaches |
|---|---|---|---|
| 1 | `asset.register` | UNGUARDED | `capitalAssets.unitId`/`trailerId`, both UNIQUE — registering another organization's truck takes its slot, and the duplicate refusal names the other organization's `assetRef` |
| 2 | `closeout.delayRecord` | UNGUARDED | `delayEvents.unitId`; the ticket number is unscoped too, unlike its siblings |
| 3 | `commercialSetup.definitionPropose` | UNGUARDED | `chargeDefinitions.unitId`; no money scope, unlike its siblings |
| 4 | `comms.unitCapabilitySet` | UNGUARDED | overwrites the other organization's `unitRadioCapabilities` and resets it to unverified |
| 5 | `comms.planForPath` | UNGUARDED | `communicationPlans.unitId`; reads the foreign unit's radio fit |
| 6 | `comms.packageBuild` | UNGUARDED | `communicationPackages.unitId`; same read |
| 7 | `dispatch.setRoleAssignment` | **guarded** | `applyBinding` checks unit, trailer, operator and job in the transaction |
| 8 | `enforcement.eventConfirm` | PARTIAL | the event carries the caller's tenant, but the **defect and work order it creates** have none and are scoped through the unit's owner — they land in the other organization's shop queue, and a critical one blocks its truck in readiness |
| 9 | `enforcement.panelGrantIssue` | UNGUARDED | `roadsidePanelGrants.unitId` |
| 10 | `fuel.dispenseRecord` | UNGUARDED | `fuelTransactions`/`bulkFuelDispenses.unitId`; pollutes the other organization's consumption figures |
| 11 | `geo.accessConfirmPassage` | UNGUARDED | `siteAccessConfirmations.unitId` |
| 12 | `ifta.distanceRecord` | UNGUARDED | `jurisdictionDistanceRecords.unitId`; entity and trip unscoped too |
| 13 | `insurance.claimOpen` | UNGUARDED | `insuranceClaims.unitId` |
| 14 | `payroll.submitTime` | PARTIAL | own profile scoped; `payrollTimeEntries.unitId` not |
| 15 | `payroll.expenseCreate` | UNGUARDED | `expenseRecords`/`expenseAllocations.unitId`; entity unscoped too |
| 16 | `roadside.open` | UNGUARDED (existence only) | **a defect and an open roadside event on the other organization's unit — readiness blocks that truck, overridable by no one** |
| 17 | `purchasing.request` | UNGUARDED | `purchaseAuthorizations.unitId`; entity unscoped |
| 18 | `vendor.billRecord` | UNGUARDED | `vendorBills.unitId`, and the pricing context |
| 19 | `records.incident.capture` | UNGUARDED | `incidentReports.unitId`; with no job, the incident is then attributed to the unit's owner and becomes invisible to its author. The sibling `records.nearMiss.report` does guard |
| 20 | `fieldRoute.trips.create` | **fixed** in `18f3f68` | — |
| 21 | `fieldRoute.assistant.draft` | UNGUARDED | `assistantProposals.unitId`; the proposal can become visible to, and committable by, the other organization |
| 22 | `fieldRoute.identity.jobUnits.create` | PARTIAL | job scoped; unit and operator not, except indirectly through a readiness check in *enforced* mode |

`fieldRoute.trips.create`'s other ids are also unchecked: `jobId` (`jobInScope` exists), `operatorId`
(`operatorInScope` exists), `manifestId`, `destinationFacilityId`. `originLocationId` points at shared
reference data with no tenant.

**Severity order proposed for remediation:** #16 and #8 (a foreign user can ground another
organization's truck, with no override), #1 (slot squatting and a disclosure), #19 and #21 (records
move to the other organization), then the rest. Each fix is the same shape as `trips.create`'s, with a
red test first.

**Consequence already applied:** the Fleet & Equipment Portfolio foundation does **not** read
`incidentReports.unitHeld` into readiness yet (the portfolio design's R-11). Until #19 is fixed, a user
in one organization could file an incident naming another organization's unit and ground it.
