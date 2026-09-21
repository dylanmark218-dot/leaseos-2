# LeaseOS — B20.8 Checkpoint: External Data Foundation + Routing Adapter

| | Previous | New |
|---|---|---|
| Version | v20.11 | **v20.12** |
| Tables | 128 | **131** |
| Migrations | 22 | **23** |
| Procedures (role-authorized) | 142 | **142** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 104 | **104** |
| Sensitive permissions | 31 | **31** |
| Tests | 791 | **825** |
| Test files | 34 | **35** |
| Parity | 128/128 | **131/131** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 361.4 kb |

---

## What I did with the geospatial inventory

Your assessment is right and it is the biggest shortcut found so far: ATS + AER +
NRN/OSM + 511 + Valhalla + MapLibre turns P5 from "build a map engine" into
"integrate proven ones."

I did **not** import anything, deploy anything, or vendor anything. Two reasons.

**Slot 0016 is still reserved.** Building a spatial subsystem now is precisely
the parallel-subsystem the directive forbids, and it would collide with the
Spatial branch when it arrives.

**Nothing in the inventory has been verified.** The licence terms, rate limits,
dataset formats and attribution obligations are a research summary, not
something anyone checked against the authority. Encoding them as fact would be
the same failure as hard-coding a tax rate.

So I built the two things that must exist *before* an import, and one that
closes a gap carried since the first reconciliation.

---

## 1. External data source registry — the provenance spine

Three tables (`externalDataSources`, `externalDatasetImports`,
`externalFeedFetches`) and `externalDataRegistry.ts`, with **two gates that fail
closed**:

**Licence.** An unverified source may be *inspected* and nothing else. Verified
sources are still refused for redistribution when terms are `unknown`, refused
for commercial operation when commercial use is `unknown`, and refused entirely
when attribution is required but no attribution text is recorded — an
attribution you forgot to render is a breach you cannot see.

**An offline map package is a redistribution.** Pre-downloading a work area onto
a tablet is not merely "using" the data. Tested explicitly, because it is the
easy thing to get wrong.

**Share-alike surfaces as a derived-database obligation** rather than as a
property of the file.

**Freshness.** A layer past its own update interval is `stale` and
`usableForConstraintSatisfaction: false`. A road-ban layer that has not
refreshed since the ban was posted answers "no restriction" exactly like one
that never had a restriction. Stale yields UNKNOWN, never PASS. No recorded
update interval is also UNKNOWN — you cannot tell currency without one.

**One cached fetch serves the fleet.** `planFeedFetch` throttles centrally
against the published limit, serves stale rather than breaching terms, and says
how long to wait. Fifty trucks polling an authority independently is both a
terms breach and a good way to lose access.

---

## 2. Routing adapter — and gap item #5 finally closes

`compileConstraintProfile` already emits gross weight, per-group axle loads,
length, width, height and dangerous-goods status. `truckRoutingAdapter.ts`
translates that into an engine-neutral truck request. LeaseOS is not writing a
pathfinder.

**The enforcement-evasion guard now exists in code.** I said in B20.6 that it was
blocked because it guarded a preference structure in the missing branch. That
was the wrong place to look. It belongs at LeaseOS's own outbound boundary — the
last point where a preference becomes a request to a router. A guard here holds
whatever the upstream branch turns out to look like, and invents nothing.

- Matches on **normalized substrings**, not exact keys. The realistic risk is not
  someone typing `avoidWeighStations`; it is a later "avoid delays" heuristic
  quietly acquiring a scale-avoidance term. `minimizeDelays_avoidScale` is
  rejected.
- **Refuses the whole request** rather than filtering the key out. Silently
  dropping it would let a caller believe evasion had been applied.
- Weigh stations, inspection stations and ports of entry **may still be
  displayed** — knowing a scale is ahead is operational awareness.
- Lawful preferences pass: tolls, ferries, unpaved, low clearance, seasonal bans.

**A router finding a path is not the road being clear.** `assessRoutingResult`
returns `unknown` when any restriction layer is stale or any constraint is
unresolved, *despite* a clean engine answer, and never returns `approved` —
only `ready_to_approve`, still requiring an authenticated human acknowledgement.

**Zero dimensions are refused.** A truck router given a height of 0 will
cheerfully route under a bridge the vehicle cannot clear.

---

## Real bug found

**I used the wrong regulatory confidence vocabulary.** I wrote the adapter
against `"verified"`. The trunk's actual ladder is
`unverified | operator_supplied | authority_confirmed`. TypeScript caught it —
had it compiled, *every* route including authority-confirmed ones would have
been forced to REVIEW, and the middle tier would have been invisible.

Corrected, and it made the model better: `operator_supplied` now sits explicitly
between the two, which matches the standing invariant that a driver-reported
bridge posting can block a corridor but can never certify one as clear.

---

## DATA_SOURCES.md

Committed. Eleven candidate sources and seven software components, **every row
marked `unverified`**, with a per-source verification checklist. A test asserts
every row is unverified and that the document still says plainly *"do not import
anything on the strength of this document."*

It is a verification work queue, not a statement of fact.

---

## Newly closed

Gap item **#5** — enforcement-evasion routing guard. Carried as documentation
since the first branch reconciliation; now code with 8 tests.

Directive §31 (authoritative datasets) has its **framework**: registry,
provenance, licence gate, freshness gate, throttling. The data itself remains
unloaded.

---

## Genuine blockers

**BLOCKED — P0 branch reconciliation.** Spatial Navigation, LoadSense and
Integrated Operations source has still never been supplied. Slots 0016/0017
reserved. Everything in this tranche is additive and reconciles.

**BLOCKED — dataset import and source verification.**
*Why:* no source has been verified against its authority. Licences, rate limits
and update intervals are claims.
*Required input:* either authoritative verification of the eleven candidates, or
a decision to research them. **This is the one place in the project where web
research would genuinely help** — and I would rather run it than guess.
*Safe work continuing:* everything above; the gates make an unverified source
inert rather than dangerous.

**BLOCKED — P9 tax/HOS/retention rules.** Unchanged. Loading path exists
(controller-only); no rule loaded, so determinations correctly return UNKNOWN.

---

## Exact next tranche

Two options, and I would take the first:

**A — Verify the eleven candidate sources** against their authorities and
populate the registry with real licence terms, attribution text, rate limits and
update intervals. That unblocks the entire P5 spatial tranche and is the only
task here that needs research rather than code.

**B — P3 AI Secretary + scanner + question queue.** No external dependency, sits
on the Evidence Vault and expense surface, and is the largest remaining
executable piece.

Say the word on A and I will run the research; otherwise I continue with B.
