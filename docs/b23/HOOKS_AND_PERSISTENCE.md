# B23.0 — where the four engines get called, and what persists

Answers the closeout's open item 5 (the trip-completion hook) and the "then cached" half of its
recommendation. Written against `b0de29226`.

The framing this starts from is the owner's: "cached" hides four decisions, because the four outputs
do not share an invalidation story. Each section below states the answer and the code that settles
it. **Three of the four are settled and ready to build. The fourth is blocked on a decision, for a
reason the closeout did not see.**

---

## 1. Passport package — an artifact, never invalidated

Settled. It is evidence of what was true at build time; it goes stale and is superseded, and neither
is invalidation.

The shape to follow already exists and is not a guess: `communicationPackages` carries
`status: ["current","superseded","stale"]`, `staleReasonsJson`, `stalenessDetectedAt`,
`supersedesPackageRef`, `manifestHash`, `dependencyHash`, `builtByUserId`, `builtAt`. The
supersede-by-status idiom is used in at least eleven places (`auditPackages`, `customerRateCards`,
`customerContractTerms`, `roadGraphBuilds`, `commercialDocuments`, `ccaSchedules`, …), so
`tripPassportPackages` inherits a convention rather than inventing one.

`detectStaleness` already returns the package with `status` and `staleReasons` changed and the
verdict, hash and `builtAt` untouched. That maps onto those columns exactly. Nothing rebuilds on its
own; `mayReleaseWithoutAcknowledgement` stays the gate.

**Hook: trip completion, on demand.** This is the only one of the four that belongs on completion,
and the closeout's "on demand, then cached" is right here and only here — automatic assembly at
completion produces packages nobody opens and stale ones nobody rebuilds.

## 2. Site baselines — a statistic, recomputable freely

Settled. Recomputing makes no new claim about the past, so the only cost is compute. Cache for
speed, invalidate on any new confirmed sample, no ceremony, and `buildSiteBaseline` stays the
authority over whatever is cached.

## 3. Binder snapshot — time-dependent, so hash staleness cannot see it

Settled, and the owner's trap is real. `safetyBinder.ts` classifies against a supplied `now` twice
over: `days < 0` → `expired`, and `days <= type.warnWithinDays` → `verified_expiring`. A document
that was `verified_current` yesterday is `verified_expiring` today with no input change at all, so a
`detectStaleness`-style input-hash check would report "current" on a snapshot that is already wrong.

So: cache with an explicit `validUntil`, computed as the earliest boundary the item set can cross —
for each counted item with an expiry, the earlier of `expiresAt` and `expiresAt − warnWithinDays`;
`validUntil` is the minimum across them, and null when no item has an expiry. Past it the snapshot
is recomputed, not trusted. An `applicability_unknown` item has no boundary and does not lower it,
which is correct: it is already unsatisfied and cannot decay further.

## 4. Billing projection — blocked, and not for the reason the closeout gives

The closeout says it "belongs inside the existing billing path, called where
`evaluateBillingReadiness` already runs." **There is no such path.** `evaluateBillingReadiness` is
referenced only from `billing.test.ts` and `degradationSuite.test.ts` — it has no production call
site. `_core/billing.ts` is itself in `DECLARED_UNWIRED`, with the reason "billing engine predates
this audit; reachability not yet established", and after this merge its only importer anywhere is
`tripBillingProjection.ts`, for a type.

The live invoicing path is a different stack:

```
_core/rateResolution.ts   resolveRate, priceQuantity, ChargeDefinition, Unit, MeasurementBasis
_core/linePricing.ts      priceLineAndRecord → chargeDefinitions → writes pricingDecisions
_core/invoiceDraft.ts     draftFromTicket over those decisions
invoicingRouter.ts        the procedures that actually run
```

So there are two rate-resolution rules in this tree, and **two exported functions named
`resolveRate`** — `rateResolution.ts`'s, which prices against `chargeDefinitions` with a scope
level, a minimum, an increment and a `MeasurementBasis`, and `tripBillingProjection.ts`'s, which
prices against a `RateLine[]` the caller supplies. They also disagree on vocabulary: the live `Unit`
carries `half_hour`, `shift`, `mile`, `litre`, `kg`, `acre`, `metre`, `foot`, `piece`, `worker`,
`crew`, `none`; the projection's `RateUnit` has seven members. The live path records money in
millis (`rateMillis`, `billableQuantityMillis`); the projection uses `rateCents` and a plain number.

Most consequentially they disagree on the pricing subject. The live path prices **a field-ticket
line**, recording one `pricingDecisions` row per line with a `decisionRef` the invoice then cites.
The projection prices **a trip**, against a rate card, citing nothing. Those are different pricing
authorities, and an invoice can only have one.

This is exactly the defect class `engineReachability.test.ts` was written to catch — "two correct
things that did not know about each other" — and the census could not catch it, because both halves
are *declared* unwired and so neither trips the unreached-and-undeclared check. A declaration is a
promise to wire something later; it is not evidence that what it will wire into exists.

**Decision needed before this one is wired.** Three options, and the middle is not recommended:

1. **Adapt the projection onto the live stack.** `projectTripChargeLines` keeps its job — turning a
   completed trip into billable quantities with named omissions — but emits what
   `priceLineAndRecord` consumes: a service code, a quantity, a live `Unit`, and a
   `MeasurementBasis` rather than a `verified` boolean. Its odometer/GPS distinction becomes
   `meter` vs `operator_estimate`, which the live vocabulary already expresses and which
   `priceQuantity` already reasons about. Its own `resolveRate` is deleted. Recommended: the
   projection's judgements survive, the second pricing authority does not.
2. **Wire `billing.ts` as a second authority.** Requires answering why an invoice would have two,
   and what happens when they disagree. Not recommended.
3. **Leave both declared unwired** and say so in the register, rather than describing a call site
   that does not exist. Honest, and it defers the same decision.

Nothing here argues the projection's *rules* are wrong. The refused rate tie, the implausible
odometer, the never-a-zero-rate discipline are all good and mostly absent from the live path. The
question is only which module owns them.

---

## The second hook: alerts belong on confirmation, not completion

The owner's point stands, and the path exists. "Setup took 3× the median" is worth having while the
truck is on site; waiting for the trip to close throws that away.

The confirmation path is `gps.confirmZoneEvent` (`server/routers.ts:914`). A GPS-detected arrival or
departure lands as a `zoneEvents` row with `status: "pending"`, and a driver or dispatcher confirms
or rejects it, optionally binding it to a `tripStopId`. `tripGps.ts`'s own header says the pending
event "must confirm before it can populate the trip timeline."

**So there are two hooks with different triggers, and only the passport package hangs off
completion.** Raising an alert is a write on the confirm path, not a side effect of someone reading
`assessStop` — otherwise alerts exist only while a screen is open.

### Durability: use the outbox, and it is not overbuilt

`domainEventOutbox` is real and production-grade — claimed via `SELECT … FOR UPDATE SKIP LOCKED`,
with a lease (`retryAvailableAt`), `attemptCount`, `lastError` and dead-lettering — and
`workflowRuntime.ts` drains it. More to the point the precedent is exact:
`_core/enforcementOutbox.ts` exists *because* the same question was answered once already, and its
header is the argument for doing it again:

> ENQUEUE runs in the caller's transaction. It must not do anything that can fail for reasons
> unrelated to the commit … CONSUME runs afterwards, separately, and may be retried.

Enqueue inside the `confirmZoneEvent` transaction, with an `eventId` derived from the zone event so
a retried confirm cannot enqueue twice; consume separately to write the `siteStopAlerts` row. The
alert then lives or dies with the confirmation that justified it, which inline raising cannot
promise. Following an existing pattern with a working consumer is cheaper than the inline version it
replaces, not dearer.

---

## Blocking finding: `tripStops` has no `confirmed` column

`StopSample.confirmed` in `siteBaseline.ts` and `BillableStop.confirmed` in
`tripBillingProjection.ts` are the central discipline of both engines — unconfirmed timings are
excluded outright, never down-weighted. **`tripStops` records no such fact.** Its columns are
`arrivedAt`, `setupStartedAt`, `operationStartedAt`, `operationCompletedAt`, `departedAt`,
`durationMinutes`, `setupMinutes`, `waitMinutes`, `quantity`, `quantityUnit`, `ticketNumber`,
`notes` — no confirmation, no confirming user, no confirmed-at.

The fact exists one table away: `zoneEvents.status = "confirmed"` with `confirmedBy`, `confirmedAt`
and a nullable `tripStopId`. So `confirmed` has to be **derived** — a stop is confirmed when a
confirmed zone event is bound to it — and the derivation is a judgement nobody has recorded:

- A stop with an arrival event confirmed but no departure event: confirmed, or not? The timings the
  baseline reads (`setupMinutes`, `waitMinutes`) span both.
- A stop whose timings a dispatcher typed directly, with no zone event at all: unconfirmed forever
  under a strict reading, which would mean manual entry can never establish a baseline.
- A stop with a *rejected* zone event and hand-entered times: the rejection is about the GPS
  detection, not about the times.

Whichever way it goes, it should be answered once, in one function, and read by both engines —
otherwise it will be answered twice differently, which is the thing this codebase keeps catching.
Until then neither engine can be wired to real data, because the field they filter on does not exist.

---

## Build order, once the two decisions land

1. Derive-confirmed helper + the `confirmed` semantics decision. Blocks 2 and 4.
2. `siteStopBaselines` cache, `siteStopAlerts`, the outbox enqueue in `confirmZoneEvent` and its
   consumer. Independent of the billing decision.
3. `tripPassportPackages` + `tripPassportPackageItems` on the `communicationPackages` shape;
   `tripPassportRouter`. Independent of everything above except `itemRef` assignment, which is the
   caller's job and belongs with the router.
4. `unitBinderSnapshots` with `validUntil`; `safetyBinderRouter`.
5. Billing projection — only after option 1/2/3 above is chosen.

Authorization inventory entries and `tenantScope*.db.test.ts` coverage accompany each router, per
the closeout's items 3 and 4.
