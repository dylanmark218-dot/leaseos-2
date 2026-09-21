# LeaseOS — v22.5.1 Checkpoint: Operational Truth Boundary + Legacy Surface Closure

**An integrity release, discovered by audit.** Nothing here claims P0/P5 or
P9 solved; the routing source is still not loaded and no seeded rule is
verified.

| | v22.5 | **v22.5.1** |
|---|---|---|
| Tables | 250 | **250** |
| Migrations | 62 | **62** |
| Role-authorized procedures | 356 | **356** |
| Externally-gated / integration-gated | 33 / 2 | **33 / 2** |
| Bare `protectedProcedure` | 0 | **0** |
| Refused trust-bearing inputs on legacy creates | 0 | **17** |
| Demo pages in production routes | 8 | **0** (8 under `/showcase`, writes refused) |
| Tests | 1,460 | **1,478** (+12 boundary, +6 client truth) |
| Test files | 80 | **82** |
| CI gate | PASS | **PASS** |

No new tables, migrations or procedures. Every count is read from the source.

---

## Two questions, not one

Authorization answers *may this person perform this kind of action*. The
older create paths in `server/routers.ts` let the request answer the second
question — *what is now true* — so an authorized driver could submit a
defect already resolved, a document already verified, a load already
classified, a signature already authenticated with a hash of `Date.now()`,
a route already "imported + driver verified" while the spatial layer says
no source is loaded. The audit named thirteen paths; the boundary covers
every trust-bearing input on the monolith's creates and captures.

## The boundary, at the schema

Seventeen inputs are `REFUSED`: a present value fails validation with the
reason — *established by its own review, verification or transition
procedure, never by a create or capture* — it is not silently dropped, so an
old client learns. Evidence and document status; TDG classification and its
verification time; defect, incident, manifest and signature status; the
signature's method and hash; a scan's access role; a new unit's inspection
and maintenance state; route-context verification and confidence;
route-decision source and confidence; a breadcrumb's unit.

Each create then writes the honest state explicitly: `needs_review`,
`needs_verification`, `open`, `draft`, `pending`, and a new unit is
**due and under review** — a row proves nothing until the inspection and
maintenance facts exist. Verification is `evidence.verify` and
`documents.review`; resolution is a later act.

## Identity and binding are the server's

A scan's access role is the strongest role the caller holds. A duty record
is the signed-in driver's operator; naming another operator needs dispatch,
HR or management, and the record is marked as an amendment by that user. A
breadcrumb binds to the operator's one active trip — no active trip, no
attachment; another trip named, refused. A route decision is stored as
*manual choice (routing source not_loaded)*, confidence *manual — not
authority data*; a route context's stated source is recorded as a statement,
confidence low, verification empty.

## The client

The compiler proved the client side of the audit once the refusals were in
place: eight demonstration pages sent `status: "authenticated"`,
`documentHash: sha256:${Date.now()}`, `inspectionStatus: "current"`,
`confidence: "Imported + driver verified"`. They now live under
`/showcase/*` inside `ShowcaseFrame`, which raises a flag the tRPC client's
first link reads: **every mutation from a showcase page is refused before it
leaves the browser**, with a visible error; queries still run. The six
dashboard paths redirect there. `/map` shows the routing source's real
status; `/jobs`, `/evidence` and `/safety` are authoritative surfaces that
state what they hold and point to the portal; `/` is the portal. A source
guard fails the gate if a demonstration identifier appears in production
client code, if a showcase page is mounted unframed, or if any showcase
create sends a refused value.

## Files

**New:** `operationalTruth.test.ts` (12) · `clientTruth.test.ts` (6) ·
`client/src/lib/showcaseGuard.ts` · `client/src/showcase/ShowcaseFrame.tsx`,
`README.md` · `client/src/pages/authoritative/Surfaces.tsx`

**Changed:** `server/routers.ts` (17 refusals; honest states; session
resolution) · `client/src/App.tsx`, `main.tsx` · eight pages moved to
`client/src/showcase/` with their trust-bearing sends removed ·
`fieldroute.test.ts` (sends observations only) · truth guard · inventory ·
generator

## Named, still open

The 85 legacy procedures remain in the monolith; the boundary covers their
trust-bearing inputs, and their migration into typed domain routers
continues as before. Evidence capture from a job or trip context in the
portal shell (the authoritative `/evidence` surface points there; the
portal's quick capture is the path). Per-field classification of every
input of every procedure as observation, claim, resolved, derived,
verified, approval, signature or system state — this release enforces the
consequences on the paths where it mattered; the catalogue is not written.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
