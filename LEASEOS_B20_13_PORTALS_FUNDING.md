# LeaseOS — v20.14 Checkpoint: Portal Composition + Funding Knowledge Panel

| | Previous | New |
|---|---|---|
| Version | v20.13 | **v20.14** |
| Tables | 132 | **136** |
| Migrations | 24 | **25** |
| Procedures (role-authorized) | 142 | **152** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 104 | **109** |
| Sensitive permissions | 31 | **33** |
| Universal permissions | 1 | **2** |
| Tests | 886 | **961** |
| Test files | 40 | **42** |
| Parity | 132/132 | **136/136** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 422.8 kb |

---

## Provenance, stated first

When I restored the working tree to continue from v20.13, it contained **seven
files I did not write**, timestamped roughly 35 minutes after my promotion
document and covering exactly the two topics in the new design documents:

`fundingIntelligence.ts` · `fundingProgramSeeds.ts` · `portalComposition.ts` ·
`portalFunding.test.ts` · `0026_funding_intelligence.sql` · plus edits to
`schema.ts` and `recordsAuthorization.ts` — about 1,800 lines.

I have no record of authoring them and I am not claiming to have. They got the
same treatment as the ChatGPT candidate did: **reviewed against every invariant,
then gated.** They passed both. What follows is what I verified, and then what I
added.

---

## What arrived, and why it was kept

Reviewed against the invariants before running anything:

| Invariant | Held? |
|---|---|
| Program figures (CAPG, CSBFP, ITC rates, IEG, CALA, intake dates) **not hard-coded as fact** | Every seed is `unverified`, with a `CLAIMED` constant naming the summary as the only source. A test asserts zero verified programs. |
| Matching **fails closed** on unverified | Capped at `possible`; `strong` requires verification. Test-pinned. |
| Estimates are **never bare numbers** | Explicit `Estimate` object with a `basis`; "labels an estimate from unverified details as such". |
| Farming excluded from general financing **as data, not code** | Exclusions evaluated first and terminal; the agricultural equivalent surfaces for the same trigger. |
| **Pre-approval warning** before spend | `purchaseAdvisory()` — the "do not purchase yet" case. |
| **No double-dipping** | `assessStacking()` — one expense, one ledger; `unknown` stacking rule resolves to review, not clear. |
| Intake status is **dated, not permanent** | Derived from open/close dates with a funding-exhaustion flag; "warns that funding may run out before the published close". |
| Portals compose from **existing** `DomainRole` and `Permission` types | No second permission system. `builtAround` is informational; the API enforces independently. |
| **Reserved slots 0016/0017 untouched** | Journal still runs 0015 → 0018. |

Gate on the unmodified tree: parity 136/136, typecheck clean, **940/940**.

The tests were substantive, not shape-only — "caps an unverified program at
'possible' even when everything fits", "excludes a corporation from the
farming-only loan program", "presents the financing program as repayable, not as
a grant", "does not dump every panel on every portal".

---

## What I added: the API, and the boundaries it holds

**None of it was callable.** Same gap as every tranche. `portalFundingRouter.ts`
— **10 procedures, all through `roleProcedure`**.

**Portals compose from the session, never the request.** `portals.mine` has no
input at all; it reads the roles the gate already loaded. `panelsFor` refuses a
portal the caller does not hold. A driver gets `field_workforce` and
`worker_self_service`; adding `safety` gains `safety_compliance` and loses
nothing — additive, pinned.

**Portal composition is the second universal permission.** It is self-scoped in
code, like the tax organizer: nobody composes someone else's session. The list
is now two entries and the test still holds it there.

**The funding surface is closed to the field.** A driver is refused the program
list, matching and the purchase advisory. HR sees training matches and cannot
record a claim. `funding.programs.manage` — the act that lets a program surface
as "strong" — is **controller-only, like `tax.rules.manage`**, and an external
accountant is refused it.

**The company profile is loaded, not typed.** A client that can declare itself a
farming business can also declare itself not one. Profile comes from the
caller's financial entity, and a missing entity screens *conservatively*, so
matches fall to "more information required" rather than to "strong" on facts
nobody supplied.

**Stacking checks against claims the server loads.** A double-dip check that
takes the client's claim list as input only finds the duplicates the client
admitted. Pinned by a source-level test that the procedure has no
`existingClaims` input.

**A claim is held, not silently recorded.** `prohibited` is a hard stop.
`possible_duplicate` and an unknown stacking rule return `heldForReview: true`
— neither recorded on a guess nor refused on one.

**Nothing is guaranteed through the API.** Every trigger returns zero `strong`
matches while every program is unverified. A program load with an unverified
source is stored unverified whatever was requested. `estimated → received` is
refused as an illegal transition.

---

## What is deferred, honestly

The router's `loadExistingClaims()` and `listOpportunities()` currently return
empty. The **boundary** exists and is tested — no client-supplied claim list, no
skipped rungs — but the persistence into `fundingClaims` and
`fundingOpportunities` is not wired. That follows the `payrollService` pattern
and is a small, mechanical next step; I chose to land the gate first because the
gate is the part that is easy to get wrong later.

The program registry is served from the seed. Loading a *verified* program
(controller-only) records the decision but does not yet persist to
`fundingPrograms`.

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source still never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative tax, HOS, retention **or funding-program** rule loaded.
Every determination in all four correctly returns UNKNOWN or `unverified`.

---

## Exact next tranche

Two things, in order:

**v20.15 — funding persistence + P3 continued.** Wire `fundingClaims` /
`fundingOpportunities` reads and writes (small), then resume P3: OCR and
document extraction into proposed fields, persistent question queue, merchant
memory, duplicate fingerprinting. The typed commit boundary and now the
knowledge panel both sit ready underneath.

The portal registry gives P6 what it was missing — a data-driven answer to
"which portal does this person open, and what goes in it" — so the UI tranche
can build against `portals.mine` rather than inventing its own routing.
