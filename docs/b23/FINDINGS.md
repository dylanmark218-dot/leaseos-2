# Verification of the B23.0 trip-operations closeout

`LEASEOS_B23_0_TRIP_OPERATIONS_CLOSEOUT.md` is filed here as received, unedited. This note records
what was checked against the code before the four engines were merged, and what did not hold.

## Confirmed

- **The four modules are genuinely new.** No file named `siteBaseline`, `tripBillingProjection`,
  `tripPassportPackage` or `safetyBinder` existed anywhere under `server/`.
- **`billing.ts`'s contract is exactly as the projection assumes.** `ChargeLineSource`
  (`server/_core/billing.ts:284`) carries `description`, `quantity`, `unit`, `rateCents`,
  `derivedFrom`, `verified`, and `calculateChargeLines` filters on `verified` into its own
  `excluded` list — so the projection's decision to pass unverified sources through rather than
  pre-filter them is correct, and its test proving the subtotal runs against the real module.
- **The disposal directory is built.** All ten named tables exist.
- **The jurisdiction-aware HOS work is built as rules-as-data.** All five named tables exist,
  with `hosRouter.ts`, `hosAttestation.test.ts` and `documentValidity.test.ts`.
- **The pre-trip defect block and the document expiry engine are built**, as claimed.
- **`todo.md` lines 176-215 are the three sections the patch names**, and the patch's replacement
  preserves every item except the one noted below.

## Corrected

### 1. The typecheck claim was false for all four modules, not one

The closeout states "`tsc --strict --noEmit` clean on all four modules under the repository's own
compiler options." Under this repository's `tsconfig.json`, `tripPassportPackage.ts` failed:

```
server/_core/tripPassportPackage.ts(243,22): error TS2802: Type 'MapIterator<PackageItemKind>' can only be
  iterated through when using the '--downlevelIteration' flag or with a '--target' of 'es2015' or higher.
server/_core/tripPassportPackage.ts(244,67): error TS7053: Element implicitly has an 'any' type because
  expression of type 'any' can't be used to index type 'Record<PackageItemKind, string>'.
```

The author's account, which is the right calibration and better than the one first recorded here:
the check ran under a hand-written `tsconfig.check.json` with `"target": "ES2022"`, not under this
repository's config, which sets **no `target` field at all** and therefore compiles as ES5. Under
ES5 a Map iterator needs `downlevelIteration`, and TS7053 follows from TS2802 — `kind` widens and
`LABEL[kind]` becomes an implicit-any index.

So the result was meaningless for all four modules; three of them passed anyway, and they stand
because they were re-checked here rather than because the original claim covered them. The absent
`target` is worth knowing about for anything else checked against this tree from outside it.

`tripPassportPackage.test.ts` was written — 125 lines, 12 tests — and did not arrive with the other
files. It dropped in transit rather than never existing.

Fixed by iterating `built.items` instead of `before.keys()`: the element type stays
`PackageItemKind` instead of widening. A 21-test suite stands in for the one that did not arrive.

### 2. `detectStaleness` mis-reported a trip carrying two items of the same kind — fixed

Found while writing that suite. `detectStaleness` keyed prior items by kind alone:

```ts
const before = new Map(built.items.map(i => [i.kind, i]));
```

A Map keyed on `kind` keeps only the last item of a repeated kind, and two disposal tickets on one
trip is an ordinary vacuum-truck round trip that the type permits. Withdrawing verification from the
first ticket yielded:

```
Disposal ticket reference changed (D-2 → D-1)     ← did not happen
Disposal ticket verification changed (verified → unverified)   ← which ticket?
```

The module reported a change that never occurred and could not say which artifact the real change
belonged to — in a package whose stated purpose is to say on its own cover what it cannot prove.

**The author's fix, applied:** `PackageItemInput` carries an `itemRef` assigned by the caller from
the trip's own structure (`"disposal_ticket:stop-2"`), never the artifact's reference — it exists
whether or not the artifact does, so a missing item is still nameable. `PackageItem` carries it
through, the staleness Map is keyed on it, and every reason renders as `${LABEL[kind]} ${itemRef}`.
`buildTripPassportPackage` refuses duplicate `itemRef` with an `unresolved` verdict and one named
gap per clash, because silently collapsing was the bug and the fix should not leave a quieter
version of it available. The refusal runs before the open-trip check, so a clash is never masked by
an open trip.

**A second defect the author caught in the same file, also fixed:** `canonical()` sorted by `kind`,
which is not a total order when kinds repeat. `Array.prototype.sort` is stable, so the input order
survived into the hash and two logically identical input arrays hashed differently — the package
then reported staleness on a set that had not changed. Verified before fixing: the same two tickets
in two orders produced `41080bf2…` and `6b26d884…`. Sorting by `itemRef` settles both problems at
once. The original suite missed it because its order-independence test used one item per kind.

The pinned `DEFECT:` test is replaced rather than adjusted, as intended. The suite now asserts that
two same-kind items are tracked separately and named, that the two orders hash alike, and that a
duplicate identity is refused.

### 3. Smaller factual slips in the closeout

- **`dispatchEnforcementService.ts` is at `server/`, not `server/_core/`**, and it is not where the
  gate lives: `criticalDefectCount` and `mechanicReleaseVersion` are fields on
  `server/_core/dispatchAward.ts:33-34`, fed from `readinessComposer.ts:598`. The claim that the
  gate exists is true; the citation is not.
- **"583 server modules"** counts test files. `server/` holds 591 `.ts` files, 302 of them
  non-test.
- **"next free migration number is `0164`+"** — the tail is `0167_route_evaluation_identity.sql`,
  so the next is `0168`. The closeout hedges this ("check `drizzle/` for the actual tail"), and the
  hedge is the part to follow.

### 4. The todo patch would have narrowed one open item

The patch replaces

> `- [ ] Validate Canada and U.S. short-haul, HOS, HazMat, and cross-border assumptions against current official regulator sources`

with

> `- [ ] Verify each seeded HOS figure against its clause (P9 — controller/management only, one figure at a time)`

The second is not the first. It covers seeded HOS figures and drops HazMat and cross-border
assumptions, which nothing else on the list carries. Both are now present, both unticked. Every
other item in the patch matches an existing one.

The patch's `[~]` state is kept: an engine that is built, tested and unreachable is neither done nor
not started, and the arrow note beside each says exactly what is outstanding. Nothing parses
`todo.md`, so the new marker breaks no guard.

## Standing

All four engines are declared in `DECLARED_UNWIRED` in `server/engineReachability.test.ts` and the
census pin moves 50 → 54. They are reachable from their tests and from nothing else, which is what
the closeout intends. The wiring plan in §"Wiring — the next commit" is not done, and its three open
questions — the service-code mapping, the baseline window, and whether the binder requirement set is
seeded per jurisdiction — are the author's to answer, along with the trip-completion hook.

---

## Addendum — a claim in the filed closeout that measurement contradicts

`LEASEOS_B23_0_TRIP_OPERATIONS_CLOSEOUT.md:68` says:

> `MAD === 0` (every sample identical) falls back to a multiple-of-median rule rather than dividing
> by zero, and the `math` string says which rule ran.

The parenthesis is wrong, and `siteBaseline.ts` carried the same claim in a code comment until
`02e378dbf`. The median absolute deviation is zero as soon as **more than half** the samples share
the median value; spread on either side does not prevent it.

Measured, and now pinned as a test:

| n | copies at the median | MAD |
|---|---|---|
| 12 | 6 | 0.5 |
| 12 | 7 | **0** |
| 11 | 5 | 1 |
| 11 | 6 | **0** |
| 8 | 4 | 0.5 |
| 8 | 5 | **0** |

`n = 8` is `MINIMUM_SAMPLES`, so it is the first baseline any site ever gets — five of eight is
enough to put a brand-new baseline on the loose rule from its first day.

Why it matters rather than being pedantry: the fallback is deliberately much looser than the
z-rule. A 26-minute setup reads `elevated` against MAD 1 and `within_baseline` against MAD 0. So
"every sample identical" is misleading in the dangerous direction — it reads as degenerate input a
reviewer skims past, when it is in fact the ordinary state of a consistent site, which is most
sites. The closeout is filed unedited; the code comment and both `math` strings now say it
correctly.
