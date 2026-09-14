# LeaseOS — v22.14 Checkpoint: Legal Land Both Ways, Entrances as Records

| | v22.13 | **v22.14** |
|---|---|---|
| Tables | 257 | **259** (`siteAccessPoints`, `siteAccessConfirmations`) |
| Migrations | 69 | **70** (`0071`) |
| Role-authorized procedures | 383 | **389** (+6) |
| Sensitive (fail-closed) permissions | 98 | **99** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,510 | **1,516** (+6, `legalLand.test.ts`) |
| Test files | 86 | **87** |
| Parity | 257/257 | **259/259 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## One recommendation declined, with reasons

The design note proposes adding PostgreSQL/PostGIS beside MySQL as a second
database. **Not in this tranche.** A township is 810 parcels and 269 road
segments; a bounding-box prefilter and point-in-ring in TypeScript answer in
milliseconds, and the v22.13 fabrics already hold the geometry. A second
database is two connection pools, two migration chains, two backup and
restore paths and cross-database consistency to reason about — real
operational cost for no capability needed yet. The point where PostGIS
genuinely earns it is the **provincial routing graph**, which is P0 and
blocked anyway. When that is built, PostGIS comes with it, and this tranche
is what it will read from.

Most of the rest of the note was already shipped in v22.13 — the ATS
importer, the access-road importer, the source registry with licences, the
centroid-versus-entrance separation. This is the part that wasn't.

## The parser reads people, the validator refuses the impossible

`13-24-54-18-W5` · `13/24-54-18-W5` · `13-24-054-18W5` ·
`LSD 13 SEC 24 TWP 54 RGE 18 W5M` · `13 24 54 18 W5` · `13-24-54-18-5` —
all one parcel, all one identity **`AB:M5:R18:T54:S24:L13`**, so two
spellings can never become two leases. Out of range still fails **by field**:
section 44 is refused as *Section 44 is outside 1–36*, never guessed.

## A GPS fix, read back as legal land

Point-in-polygon against the imported grid. Live, from the township imported
in v22.13:

```
FIX 53.684625, -116.529010
  → LSD-13 SEC-24 TWP-054 RGE-18 MER-5
    AB:M5:R18:T54:S24:L13 · 0 m from centroid · road allowance: false
```

Where the position sits on a road allowance, the answer says so — a truck on
the allowance is not on the land it adjoins. Where the grid is not imported,
that is the answer, not a nearest guess.

## The entrance is a record, not a pin

A lease has entrances. Each is **derived** from the grid and the road fabric
or **recorded** from the field, proposed by one person and confirmed by
another (the proposer cannot confirm their own), carrying gate presence and
turnaround capability, one preferred per parcel.

**Confidence is counted, never asserted.** A passage is evidence: reached,
reached with difficulty, or could not reach, with the trip, operator and a
**configuration fingerprint** — `SUPERB|3AX|63.5T|4.15H|2.60W|27.5L`. One
passage is never *confirmed*; three passages by two operators with a person's
confirmation is. A failure standing against successes is **disputed**, for a
person to settle. And the fingerprint distinguishes *this exact rig has been
through* from *some other truck has* — because one truck's passage does not
prove another's.

## An imported road on the four axes

The v22.0 evaluator has always taken caller-supplied segments. It now takes
the **imported** ones: a corridor between two points, nearest first, each
road stating the surface Alberta states — and **nothing else**. The province
publishes no weight, axle, clearance, width, length or seasonal limit on that
layer, so this emits no attribute for any of them and the evaluator reads
them UNKNOWN. Live, a loaded 63,500 kg unit over 40 real segments:

```
CORRIDOR evaluated | 40 segments | warning
  unknown 80 · failing 0 · legal unknown · confidence unverified
  surfaces: gravel, dry_weather, paved, driveway
```

Zero failures and still **not** clear to dispatch. That is the invariant
holding under real data: the map's silence is never a permission.

## Corrected on the way

Two suites asserted on whole-table counts — the import-run log and the
entrance list — which broke the moment a second suite legitimately wrote to
them. Both now assert on the rows their own run created; the tables are
meant to accumulate.

## Files

**New:** `0071_site_access_points.sql` · `_core/legalLand.ts` ·
`legalLand.test.ts` (6)

**Changed:** `_core/dls.ts` (forgiving parser, `lsdIdentity`) ·
`geoRouter.ts` (+6 procedures) · `schema.ts` · `recordsAuthorization.ts` ·
`geoImport.test.ts` (scoped) · two count pins · inventory · generator

## Not built, and named

OSM/Geofabrik import and the routing graph — **P0 stands**: nothing here
computes a route, only evaluates a straight corridor of imported roads.
Bridges as their own records. Road restrictions harvested from any authority
(the table exists; nothing populates it). Breadcrumb-derived geometry
confirmation. AER ST37 — commercial redistribution still needs written
permission. Vector tiles and offline packs.

## Blockers

**P0/P5** — no routing source. **AER ST37 / ST102** — written permission.
**Alberta 511** — API key. **P9** — no verified rule.
