# LeaseOS — B20 Checkpoint: Verified Baseline + Measurement Quality Ladder

**Date:** 2026-09-06
**Input artifact:** `leaseos-fieldroute-v20_2.zip`
**Output artifact:** `leaseos-fieldroute-v20.3-measurement-ladder.zip`

---

## 0. Read this first — what actually arrived

Three files were listed as uploaded. **One was present on disk.**

| Listed | On disk | Notes |
|---|---|---|
| `leaseos-fieldroute-v20_2.zip` | **Yes** | Verified and worked on below |
| `LeaseOS_Full_Conversation_Code_Archive_2026-09-06.zip` | **No** | Never reached the container |
| `LEASEOS_BRANCH_RECONCILIATION.md` | Text only | Content available; not a code artifact |

**The supplied ZIP is the v20 trunk, not the reconciled v21.** This is measured, not inferred:

| Claim in the v21 checkpoint | Measured in the supplied artifact |
|---|---|
| 103 tables | **87** in `schema.ts`, **87** `CREATE TABLE`, **87** in the live database |
| 19 migration files (0000–0018) | **17 files.** Slots `0016` and `0017` are empty; journal jumps `idx 15 → 18` |
| Spatial navigation merged | **0** occurrences of `roadGraph` / `dlsGrid` / `landGrid` / `routePackage` |
| LoadSense merged | **0** occurrences of `loadSense` |
| Enforcement-evasion guard in code | **0** occurrences of `avoidWeighStations` / `avoidInspectionStations` / `avoidEnforcementCheckpoints` |
| `ready_to_approve` route semantics | **0** occurrences |
| Unified `certified > calibrated > …` ladder | **0** occurrences of `certified_scale` / `calibrated` |

The v21 reconciliation described in the prior checkpoint is **not reconstructable from here**, and this
checkpoint does not attempt to reconstruct it. Migration slots `0016` and `0017` remain correctly
reserved, so Branch B still applies unchanged when its code is supplied.

---

## 1. Completed

**The full CI gate ran for the first time.** Prior checkpoints could not claim this — no
`node_modules`, no package installation, no database binary. This container had root, an open
registry, and an installable MariaDB, so the gate the previous run correctly refused to claim has
now actually executed against a real database.

**A real defect was found and fixed:** the disposal billing gate failed open on any measurement
method it did not recognize.

---

## 2. Verification — the complete gate, actually run

Replicated `.github/workflows/ci.yml` step for step, same `DATABASE_URL`, same order.

| Step | Result |
|---|---|
| MariaDB 10.11.14 installed and running | PASS |
| `pnpm install --frozen-lockfile` | PASS |
| `bash scripts/apply-migrations.sh` — 17 migrations, in order | PASS — 87 tables created |
| `bash scripts/verify-parity.sh` | PASS — 87 / 87 |
| `pnpm exec tsc --noEmit` | PASS — clean |
| `pnpm exec vitest run` | PASS — **488 / 488** across **24 / 24** files |
| `pnpm build` (vite + esbuild) | PASS — `dist/index.js` 184.9 kb |

No step was skipped and none was partially run. Test totals moved **472 → 488**; the 16 new tests are
all in `measurementQuality.test.ts`. **No existing test was modified**, including the 13 in
`disposalReconciliation.test.ts` that pin the previous behaviour.

Pre-existing build warnings (undefined `VITE_ANALYTICS_*` in `index.html`, >500 kB chunk) were
present before this change and are unrelated to it.

---

## 3. Bug found — the disposal billing gate failed open

**Root cause.** `disposalReconciliation.ts` gated billability on a single string comparison against
an untyped field:

```ts
measurementMethod?: string | null;          // not the enum union
status: !input.measurementMethod || input.measurementMethod === "unknown"
  ? "missing" : "pass";
```

This is an allowlist by exclusion. Every string that is not literally `"unknown"` passes — including
strings from a vocabulary that does not exist yet. Demonstrated, not argued:

```
old gate("certified_scale")        = pass   <-- billable
old gate("loadsense_uncalibrated") = pass   <-- billable
old gate("driver_entered")         = pass   <-- billable
old gate("estimated")              = pass   <-- billable
```

`loadsense_uncalibrated` — the weakest instrument reading in the incoming branch's own ladder —
would have been read as adequate provenance for a charge. `"estimated"` would additionally have lost
its *"confirm before billing"* flag, because the trunk compares against `"estimate"`. TypeScript could
not catch either, because the field is `string`, not the enum union.

This directly contradicts invariants **#7 (unknown must stay unknown)** and **#22 (pending values must
not automatically become invoice lines)** — but only *after* Branch B merges. On the trunk today only
trunk vocabulary exists, so the hole is latent. That makes it exactly the kind of defect that lands
silently during a merge and is discovered in an invoice dispute.

**The reconciliation report called unifying the two vocabularies a design tidiness point. It is a
correctness requirement, and it has to land before the merge, not after.**

**Fix.** New `server/_core/measurementQuality.ts` — one closed ladder, one vocabulary:

- Typed `MeasurementMethod` union covering the superset of both schema enums.
- `classifyMeasurementMethod()` **fails closed** — anything unregistered is `unknown` and holds the
  charge, rather than being waved through.
- The unrecognized string is **preserved** on the classification (`unrecognizedValue`) and surfaced in
  the detail, so a vocabulary gap becomes a reportable exception rather than a silent pass.
- `compareMeasurementQuality()` / `strongerMeasurementMethod()` rank two disagreeing sources. They
  rank; they do not discard the loser. Both measurements survive — which one bills stays a human
  decision.
- Authority ranks are spaced by 10, and the `authority_certified` tier is **declared but deliberately
  unoccupied**. That is the slot a certified-scale reading belongs in. Declaring the shape is forward
  planning; populating it with Branch B's spellings would be fabricating a branch that has not
  arrived, so it is left empty and a test asserts nothing claims it.

**Regression coverage (16 tests).** Foreign-vocabulary values held; near-miss spelling
(`"estimated"` ≠ `"estimate"`) not silently inheriting the accepted classification; ladder ordering
and symmetry; `authority_certified` reserved and unoccupied; and the end-to-end assertion that a
disposal with `loadsense_uncalibrated` holds the disposal charge while **other charges still
proceed** — preserving the partial-hold principle.

---

## 4. Files changed

| File | Change |
|---|---|
| `server/_core/measurementQuality.ts` | **New** — closed ladder, classifier, precedence comparators |
| `server/_core/disposalReconciliation.ts` | Billing gate now classified against the ladder; import added |
| `server/_core/measurementQuality.test.ts` | **New** — 16 regression tests |
| `LEASEOS_B20_MEASUREMENT_LADDER.md` | **New** — this checkpoint |

Three source files touched, 419 diff lines. Deliberately narrow.

---

## 5. Schema / migrations

**No schema change. No new migration. Parity unchanged at 87 / 87.** The defect was in application
logic, so it was fixed in application logic.

One schema divergence found and **documented rather than silently absorbed** — the two
`measurementMethod` enums are not identical, confirmed in both `schema.ts` and the live database:

```
loads            enum('meter','scale','gauge','estimate','customer_stated','unknown')
fieldTicketLines enum('meter','scale','gauge','estimate','customer_stated','system_timed','unknown')
```

`system_timed` exists on field ticket lines and not on loads. That is plausibly intentional — a
system-clocked duration suits a billable time line and not a load quantity — so it was **not**
"fixed" by guessing. The union in `measurementQuality.ts` is their superset, so one classifier serves
both safely. Narrowing them to one shared enum is a schema decision that needs your call.

---

## 6. Backend / UI

Backend: one pure module, no new endpoints, no authorization surface, no I/O. UI: unchanged.

---

## 7. Remaining gaps

- **Spatial navigation + LoadSense — code still not supplied.** Slots `0016`/`0017` reserved.
- **Integrated Operations** (`operationsEngine.ts`, `aiSecretary.ts`, `OperationsControlCenter.tsx`) —
  still never supplied. Flagged since the V7 manifest.
- **Enforcement-evasion guard is still documentation, not a test.** The reconciliation report was
  right that it should be test-pinned. It cannot be pinned here, because the routing preference
  structure it guards lives in the branch that has not arrived.
- **B20 Records & Compliance Vault** (evidence sealing, field vault, incident/near-miss, retention and
  legal hold, audit package builder) — designed in the supplied architecture document, not built.

---

## 8. External data

No regulatory, map, or resource data was added, verified, or asserted in this checkpoint. The
retention-period question raised in the Records Vault document — that the Canadian 14-day figure is
an ELD roadside-production requirement rather than a universal document-retention rule, and that
federal HOS carrier retention and TDG shipping-document retention are separate and different — is
**not** encoded anywhere in this trunk yet and remains unverified against current sources.

---

## 9. Next recommended step

**Send the spatial + LoadSense branch as a `.zip`.** This container now has the full gate standing:
MariaDB running, dependencies installed, all 19 migrations applicable in one pass, complete suite,
typecheck and production build. The ladder that Branch B's source precedence must merge into is now
in place and test-pinned, so the merge has something correct to land on instead of two vocabularies
drifting past each other.

If Integrated Operations can also be recovered, send both and they reconcile in one pass.

**If neither branch is available**, the highest-leverage work that needs no missing code is **B20A —
Evidence Record Core**: the immutable evidence object, relationship graph, SHA-256 seal and version
chain. It is the foundation every other B20 sub-build depends on, and it is entirely additive to this
trunk.
