# LeaseOS — UNRELEASED 0079 candidate: jurisdiction confidence, capture truth, priority sync, HOS reality

**Base:** exact `leaseos-0078-worktree-UNRELEASED.zip` supplied 2026-09-11.  
**Status:** **UNRELEASED / review candidate.** Do not call this production-green until the repository's normal disposable-MariaDB `ci-gate.sh` has run with dependencies installed.  
**Baseline already contained:** A — `routeApprovals.buildRef` production wiring and build/segment mismatch refusal; B — the award-recompute geographic-basis regression (“test 10”) and its companion geography regressions.

## Measured source state after this candidate

- 276 tables — unchanged.
- 78 migration files — +1 (`0079_sync_capture_authorization.sql`).
- 426 role-authorized procedures — unchanged.
- 95 test files / 1,682 `it(...)` cases — +5 cases, no new test file.
- 0016/0017 remain reserved and absent.

These are source counts only. The full gate was **not runnable in this container** because the supplied tree has no `node_modules` and there is no MariaDB client/server here.

## C — jurisdiction confidence is now honest

### Defect

`routeCommunicationGeography.ts` derived a segment province from `externalDataSources.jurisdiction`. That field describes the **dataset** (`CA-AB`), not the jurisdiction at every coordinate in the segment. A border-straddling polyline could therefore look confidently Alberta without coordinate-level province-boundary evidence.

### Change

`SegmentGeography` / `ResolvedSegmentGeography` can now carry:

- `jurisdictionConfidence`: `confirmed | probable | ambiguous | unknown`
- `jurisdictionCandidates`
- `jurisdictionEvidenceRefs`
- an optional `crossing` record with `fromProvince`, `toProvince`, and evidence references

The current database resolver deliberately labels a verified source-wide `CA-XX` jurisdiction **`probable`**, not `confirmed`. It does **not** invent a crossing, second province, or timestamp because the current tree contains no authoritative coordinate province-boundary layer.

For province-limited channel conditions:

- `confirmed` can permit or exclude;
- `probable` => `unknown` and cannot authorize;
- `ambiguous` => `crosses` and cannot authorize;
- `unknown` => `unknown`.

The same rule now applies to a company radio authorization whose licence is province-scoped. Previously that gate could silently skip the provincial check when route geography existed but no caller-supplied province was present.

### Deliberate operational consequence

A route resolved only from source-wide Alberta metadata can now move from `authorized` to **`unknown`** for a province-limited radio rule. This is intentional. The previous answer was stronger than the evidence. Wiring an authoritative Canadian province/territory boundary layer is the next step that can restore `confirmed` where justified.

No migration was needed for C: it is derived decision vocabulary, not a new source of truth.

## D — recording is separate from authorization

Migration `0079_sync_capture_authorization.sql` extends the existing `syncPackageItems`; it does not create a second sync ledger.

Each synchronized item now retains the device's **capture-time claim**:

- `authorized`
- `unauthorized`
- `unknown` (default, including legacy clients)

with optional `captureAuthorizationReason`.

Important semantic boundary: this is explicitly a **device claim about capture context**, not a server authorization decision. A later successful sync never upgrades `unauthorized` or `unknown` to `authorized`.

The local `Outbox.saveDraft()` defaults to `unknown` unless the caller actually knows the capture-time state. The sync engine transports the claim into the existing package item, and the server stores it alongside the verified evidence item.

The existing field-device admission behavior remains unchanged: revoked/untrusted devices can retain local records, but the server refuses their package. This candidate does not weaken device attestation or key admission.

## E — safety evidence cannot sit behind 500 photos

The client queue used to be pure FIFO and then `slice(0, 500)`. Therefore 500 old photos could exclude a newer HOS event from the next package.

`captureSyncPriority()` and `prioritizeQueuedCaptures()` now order:

1. **0 — safety/legal state:** HOS event, incident, defect report
2. **10 — readiness/authorization evidence:** pre-trip, post-trip, TDG document, job acceptance, tailgate, signature
3. **20 — operations:** load/disposal tickets, fuel/expense receipts, voice note
4. **40 — bulk media:** photo

Within a tier, capture time and then local ID preserve deterministic FIFO ordering.

Regression: 500 older photos plus one newer HOS event selects the HOS event first and 499 photos; one photo waits for the next package.

No migration was needed for E.

## F — HOS records reality; it does not rewrite it

The existing HOS architecture already computed clocks from observed duty entries and returned `exceeded` findings separately. This candidate does **not** touch the unverified regulatory seeds in `hosRuleSeeds.ts` and does not verify any seeded number.

A new invariant test uses a **synthetic test-only 60-minute rule**. It proves:

- the observed status remains `driving`;
- the rule engine returns `exceeded`;
- the input duty record remains `driving` after determination.

That pins the rule: a non-compliant event remains part of the historical record and gets a finding; it is never rewritten into a permitted status.

## Five added regression cases

1. Source-wide jurisdiction metadata is `probable` and cannot authorize a province-limited channel rule.
2. A province-scoped company licence also refuses to authorize on only-probable jurisdiction.
3. An explicit AB/BC ambiguous crossing returns `crosses` and full authorization remains `unknown`.
4. 500 photos cannot starve a newer HOS event.
5. HOS exceedance does not rewrite an observed `driving` status.

The existing database-backed geography agreement test was also strengthened: it now expects the source-derived AB jurisdiction to be `probable`, and expects the sealed package to say the transmit answer is UNKNOWN rather than presenting source metadata as coordinate proof.

## Validation performed here

Completed:

- strict TypeScript compile of the changed pure engines/runtime files with global `tsc`: **PASS**
- executable smoke assertions for jurisdiction `probable`, explicit `ambiguous` crossing, 500-photo priority, and HOS record-vs-finding invariant: **PASS**
- source counts regenerated through `scripts/current-state.sh`: **276 tables · 78 migrations · 95 files · 1,682 tests · 426 role procedures**
- schema and migration inspected together: `0079` only alters `syncPackageItems`; no duplicate sync/HOS/jurisdiction tables were introduced

Not runnable here:

- full Vitest suite (dependencies are not present in the supplied ZIP)
- applying migration 0079 to disposable MariaDB / column-level parity (no MariaDB client/server in this container)
- production Vite/esbuild build (dependencies absent)

## Required review gate before promotion

Run the normal repository gate from an empty disposable database:

```bash
DATABASE_URL=mysql://... bash scripts/ci-gate.sh
```

Promotion requires migration 0079 application, 276/276 column parity, TypeScript, all tests, production build, authorization inventory checks, and regenerated current state to pass together.

## Next highest-value work

Do **not** weaken `probable` back to `confirmed` just to recover a green radio answer. Instead, add a licence-cleared authoritative province/territory boundary layer and make the jurisdiction resolver produce coordinate-backed `confirmed` or polygon-intersection-backed `ambiguous`. The decision vocabulary and fail-safe behavior are now ready for that data.
