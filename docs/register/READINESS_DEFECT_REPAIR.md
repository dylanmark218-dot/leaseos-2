# Readiness defect repair — X-1 … X-8

Baseline `f21cd1bc2070ae179d431177fd0f286965e0f3c3`. Implementation defects only: no P8.4 policy is
encoded here, `SAFETY_CEILINGS` is untouched and still `{}`, and nothing about P8.3 or P6.7 moved.

Eight defects were confirmed against a real MariaDB before any of this was written. Each one was a
case of the system contradicting its own data model, not a case of the model being undecided.

---

## 1. A critical defect no longer clears itself by chronology

**Before.** `readinessComposer` decided whether a critical defect was still open by comparing
timestamps:

```ts
const releasedAfter = (d) => releases.some(r => r.releasedAt > d.reportedAt);
```

Any release row on the unit that was newer than a defect cleared that defect. It did not have to
name it, or belong to its work order, or have passed its test, or even be a release: a
`releaseType: "revoked"` row satisfied the comparison exactly as well as a full release. And because
no production path could ever set `maintenanceDefects.status = 'resolved'` — five insert sites, zero
update sites — this comparison was not one clearing mechanism among several. It was the only one.

**After.** Two conditions, decided separately, as the programming manifest has always listed them
("unresolved critical defects" and "critical work-order mechanic release" are its items 8 and 9):

| | Question | Source |
|---|---|---|
| the defect | is there a critical defect nobody has resolved? | `maintenanceDefects.status` |
| the release | does the release evidence for each critical defect still stand? | `workOrderReleases`, matched by `resolvedDefectIds` |

Neither is inferred from the other, and neither is inferred from chronology. A release is evidence
about the defects it **names**.

## 2. `resolved` is a real state transition

**Before.** `maintenanceDefects.status` carried `resolved` from the day the table was created.
`telematicsRouter` already refused to clear a fault code until "the defect it became" was resolved —
a state nothing in the system could produce. Readiness filled the gap by inference.

**After.** `records.maintenance.resolveDefect` resolves **one named defect**. It requires
`maintenance.record_release` — the permission that already governs mechanic and work-order release,
held by `mechanic` and `shop_lead`. Deliberately not `maintenance.write_defect`, which drivers and
office staff hold so they can *report* a defect: whoever may raise one must not thereby close it.

It refuses a defect that does not exist, one outside the caller's scope (as "not found", never
"forbidden"), and one already resolved. A **critical** defect additionally requires a release that
names it and still stands. There is no bulk form and no `ready = true`: the failure this replaces
cleared every critical defect on a unit at once, so resolving exactly one is the whole operation.

Migration `0169` adds `resolvedAt`, `resolvedByUserId`, `resolvedByReleaseId` and `resolutionNote`.
`resolvedByReleaseId` is the load-bearing one — it is what lets readiness notice that the release a
resolution rested on was later revoked.

## 3. `releaseType`, `testResult` and `resolvedDefectIds` are no longer dead data

`resolvedDefectIds` was written on every release and read by nothing. All three are now read, in
`currentReleaseEvidenceFor`. A release is evidence for a defect only when four things hold, and each
of them was a separate confirmed defect when it did not:

1. the release **names** that defect in `resolvedDefectIds`;
2. it is not a revocation;
3. its test did not fail;
4. it has not been withdrawn by a later revocation on its own work order.

`evaluateMechanicRelease` already guarded the moment a release was *written*. This guards every
later *read* of one — and the two were not the same guard, because
`records.maintenance.revokeRelease` appends its row without consulting the evaluator at all.

## 4. Revoking a release can no longer improve readiness

**Before, observed:** a critical defect whose only release event was a revocation went from
`blocked` with two non-overridable blockers to zero blocking blockers. The revoking procedure
returned `{ unitHeld: true }` in the same call.

**After:** a revocation is never positive evidence, and it withdraws the release it supersedes. If a
defect was resolved on a release that is later revoked, the defect stays resolved — a recorded human
act is not undone by inference — but the release condition fails, so the unit blocks again. The
blocking set may grow on a revocation. It can never shrink.

## 5. The composer reads enforcement state itself

**Before.** `composeReadiness` raised enforcement blockers only when the caller passed
`subject.enforcement`. Not one production caller did — `dispatchRouter`'s input schema has no field
for it — so the capability this system will not let anyone override reported **PASS** on every
dispatch, from an input nothing supplied, while active orders sat in `outOfServiceOrders`. "Never
evaluated" and "evaluated and clear" were the same answer.

**After.** The composer queries `outOfServiceOrders` through `enforcementEvents`, which is what
carries the real `unitId`, `trailerId` and `operatorId` — `subjectRef` on the order is free text the
confirming caller supplies, so matching on it would be guesswork. Tenant scoping is mandatory: the
unit's owning organization comes from `coreRecordOwnership`, and an order recorded against another
organization cannot ground this one's truck.

The evaluator is unchanged. It was always correct when fed; what was missing was the data path.

| Enforcement state | Result |
|---|---|
| active applicable order | `BLOCKED`, non-overridable (`oos.<scope>`) |
| evaluated, no applicable active order | `PASS` |
| inspection whose result was never established | `enforcement_result_unknown`, severity `unknown` |
| the read itself failed | `NOT_EVALUATED` (`no_data_source_loaded`) → required-capability `unknown` blocker |

A caller omitting an optional object is not evidence that enforcement was checked and clear.

## 6. The logic that had no coverage now has it, and it is sensitive

`readinessComposer`'s critical-defect derivation had no test at all. The one integration test that
cleared a critical defect did it with a raw `UPDATE ... SET status = 'resolved'` that no production
caller could perform, so it could not tell the two mechanisms apart.

`server/readinessDefectRepair.db.test.ts` is 25 database-backed cases against real production code.
Nine planted mutations were each caught by at least one of them, with every source file restored
byte-for-byte afterwards.

---

## Operational consequence, stated plainly

On an existing deployment, a unit carrying an open critical defect that was "cleared" by the old
timestamp rule **will now block**. That is the repair, not a regression: those units were reported
ready on evidence that named nothing. Clearing them takes a mechanic release naming the defect and
an explicit `records.maintenance.resolveDefect`.

## Not addressed here

X-9 (blocking blockers marked overridable), X-10 (the clamp under-report) and X-11 (`needs_review`
documents satisfying a credential check) are static findings that were not execution-verified, and
are out of scope for this branch. P8.4 remains undecided and unimplemented.
