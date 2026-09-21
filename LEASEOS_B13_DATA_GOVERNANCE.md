# LeaseOS — B13: Data Governance & Road Graph

**Status:** engine built and tested. **156 tests across 9 engines**, all green.
**Manifest reference:** V8 §32 External data ingestion and provenance · §16 Real routing graph
**Companion to:** `LEASEOS_B12_ROUTING_EVIDENCE.md`

---

## 1. Corrections to the record

**Table count: 52 was right, my 53 was wrong.** My earlier `grep -c 'mysqlTable'` matched the
import line as well as the declarations. Verified four ways — schema declarations, unique schema
names, migration `CREATE TABLE` statements, unique migration names — all returned 52 before this
pass. V8's correction stands.

After B13: **58 tables, 13 migrations**, schema and migrations in parity (checked, not assumed).

---

## 2. Why this was the right next build

With the Integrated Operations branch unavailable, V8 identified two paths. This is the
non-conflicting one, and it attacks the actual hard stop:

> B12's compiler/evaluator is present, but dispatch-grade routing is still gated by authoritative
> data. **This is a data-governance gate, not an engine-code gap.**

Exactly right — so the fix is a governance layer, not more routing code. B13 builds the machinery
that lets real data become trustworthy, without fabricating any of it.

---

## 3. Three rules enforced mechanically

`server/_core/dataIngestion.ts` — 25 tests.

### Rule 1 — a batch missing provenance is rejected, not stored with blanks

`validateImportBatch()` rejects on missing resource type, jurisdiction, source authority, dataset
version, import timestamp, checksum, or a zero record count. **There is no code path that produces
a stored road restriction nobody can attribute.**

Missing licence terms, effective date or source reference are *warnings* — they don't stop the
import, but they're recorded against it. An unlicensed import is a legal exposure worth surfacing
before someone builds a product on it.

### Rule 2 — coverage is measured, never claimed

`assessCoverage()` returns `unknown` when the expected extent isn't known, rather than an
optimistic 100%:

> `4182 bridges imported. Total extent unknown — coverage cannot be measured, so it is not claimed.`

Partial coverage states the consequence plainly: *"Gaps remain; unmapped segments evaluate as
unknown."* Which is exactly what B12's evaluator does with them.

### Rule 3 — confidence is promoted by evidence, never defaulted

`validateImportBatch()` **rejects any batch declaring itself `authority_confirmed`**. The only
route to that state is `confirmDataset()`, which requires a named person and a named authority, and
refuses a confirmation dated before the import it confirms.

So *"who said this bridge limit was right?"* always has an answer, with a date and a reference.

`operator_supplied` sits between: a dispatcher entering a limit they know is better than nothing
and worse than an authority.

---

## 4. Supersession retains, never deletes

`planSupersession()` marks earlier batches for the same resource + jurisdiction superseded and
returns `retainForReproducibility: true`. Old batches stay.

This is load-bearing for B12 gate 7: a routing decision made in March must remain reproducible
against **March's data**. Deleting a superseded dataset would silently break every historical
decision that depended on it.

---

## 5. The engine/data distinction, made explicit

`assessDispatchTrust(jurisdiction, batches)` separates two questions that are easy to conflate and
dangerous to confuse:

| Question | Answer today |
|---|---|
| Does the routing engine work? | Yes — 37 tests across compiler and evaluator |
| May its output be relied on for dispatch? | **No** — no authority-confirmed data loaded |

> `Routing for AB is NOT dispatch-grade. The engine works; the data does not yet support a clear decision.`

Trust is per-jurisdiction and per-resource-type. A confirmed Alberta dataset does not vouch for
Saskatchewan — there's a test for that, because it's the kind of shortcut that looks harmless and
isn't.

---

## 6. Road graph persistence

Six tables. B12's evaluator currently receives segments as supplied input; these persist them in
the same shape, so it reads stored rows without reshaping.

| Table | Purpose |
|---|---|
| `importBatches` | Every provenance field from manifest §32, plus coverage and supersession |
| `datasetConfirmations` | The named-person promotion record |
| `roadSegments` | Geometry, class, surface, jurisdiction |
| `segmentAttributes` | One row per (segment, check) — mirrors `SegmentAttribute` exactly |
| `bridges` | Clearance, posted weight, posted axle group, seasonal restriction |
| `routeEvidenceEntries` | Persisted evidence ledger — one row per check per decision |

Two details that matter:

**A NULL `limitValue` is meaningful.** It evaluates as `unknown`, never as clear. The column is
nullable on purpose, and B12 has three tests covering it.

**Provenance is per-attribute, not per-import.** A route assembled from a provincial bridge dataset,
a municipal truck-route file and a driver observation has three different trust levels *within one
route* — so `source`, `sourceVersion`, `verifiedAt` and `confidence` live on each attribute row.
That's what lets the evaluator return `review` for a satisfied-but-unverified limit while returning
`pass` for a confirmed one on the same segment.

`routeEvidenceEntries` carries `vehicleValue`, `limitValue` and `unit` so `reproduceVerdict()`
replays a decision from the database with no map access.

---

## 7. What this deliberately does not do

**It loads no regulatory data.** No thresholds, no bridge limits, no truck routes. Every value in
the module is a test fixture with an `example.invalid` reference.

Populating it is a procurement and verification task, not a coding one:

1. Obtain each dataset from its issuing authority, with licence terms
2. Import — lands as `provisional` / `unverified`
3. A named person confirms against the authority → `authority_confirmed`
4. `assessDispatchTrust()` starts returning trustworthy for that jurisdiction
5. Only then can routing return `clear`

Steps 1 and 3 need a person with a phone. That's the correct division of labour: the software
enforces the discipline, a human supplies the authority.

---

## 8. Status

| Engine | Tests |
|---|---|
| geofence · tracking · billing · fieldTicket · disposalReconciliation · taxonomy | 94 |
| routingCompiler · routeEvaluation | 37 |
| **dataIngestion** | **25** |
| **Total** | **156** |

58 tables · 13 migrations · 31 prototype screens.
Typecheck: 1 pre-existing error (`TripOperationsWorkspace.tsx(77,846)`, Phase 0 item 3, untouched).
Full suite: 13 failures confined to `server/fieldroute.test.ts`, all requiring `DATABASE_URL`
(Phase 0 item 4).

---

## 9. Next

**Still branch-blocked:** reconciling Integrated Operations needs its actual ZIP. Nothing in B13
touches those files, so it merges cleanly either way.

**Unblocked on this branch:**

1. `db.ts` functions + tRPC router for ingestion, confirmation and segment lookup
2. Wire `evaluateRoute()` to read persisted `segmentAttributes` instead of supplied input
3. Persist `routeEvidenceEntries` on each decision; add a "why this route?" screen reading them back
4. Path-finding across the graph — B12 evaluates a given route, it doesn't choose between routes
5. Admin UI for import, coverage and the confirmation workflow
6. Offline route packages with `assessDatasetFreshness()` already built in B12
