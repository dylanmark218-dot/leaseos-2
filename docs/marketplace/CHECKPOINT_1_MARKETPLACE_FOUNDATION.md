# Marketplace — Checkpoint 1: Posting + Bid + Award domain (0237)

> **Migration numbers renumbered 2026-10-03:** this work was written as `0189`–`0192`; `main` took `0189`, `0191` and `0192` first, so the four moved to `0233`–`0236`; `main` then took `0236` (#135) with `0233`–`0235` claimed by other open branches, so the four marketplace migrations now ship as `0237`–`0240`, unchanged. Numbers in these checkpoint documents use the new slots.

**Release label:** v23.26
**Migration:** `0237_marketplace_bid_award.sql` (0175–0188 are claimed by open branches; see
`docs/architecture/MIGRATION_COLLISION_REGISTER.md`)
**Date:** 2026-10-01

## What this is

The commercial layer between a CLIENT organization that needs work performed and the CONTRACTOR
organizations able to perform it: a client posts a work opportunity, contractors bid, the client
awards. It is deliberately **not** a classifieds page: every row carries the organization it belongs
to, every transition is a locked, versioned, audited transaction, a submitted bid is immutable, and
the sealed-tender rule is enforced where the data is read, not where a button is drawn.

It is distinct from `dispatchPostings` / `dispatchBids` (migration 0013), which record one company's
own OPERATORS' willingness to take a shift. A marketplace award is what will later create the
canonical dispatch posting (checkpoint 2); nothing in this checkpoint creates a dispatch job.

## Scope of this checkpoint — and what is deliberately left out

**In:** the posting lifecycle, the bid lifecycle with write-once revisions, invite-only tenders,
sealed and open visibility, the deadline enforced by the clock, a declared-only bid readiness
picture, the award bound to a content hash with the client's rationale, the append-only tender
audit trail, outbox events, tenant isolation, role authorization, pure and database-backed tests.

**Out, on purpose:** any UI; automatic creation of the dispatch posting / work order on award
(checkpoint 2); the clarification thread and public clarifications (the discussion system);
company profiles, following, matching notifications; verification of a bidder's declared
qualifications against the compliance registry, insurance risk, HOS forecast or operator
availability (those rows read `UNKNOWN` / `declared, not verified` today, and say so); payments
and commissions.

## The model

| Table | Holds | Mutability |
|---|---|---|
| `marketplacePostings` | the opportunity: structured fields, requirements, pricing basis, visibility, distribution, deadline, lifecycle `state`, `version` | edited only in `draft`; state moves under lock with optimistic version |
| `marketplaceInvitations` | who was invited to an invite-only tender | append |
| `marketplaceBids` | the bid HEAD — one per (posting, bidder): `state`, `currentRevisionId`, the working `draftContentJson` | state and draft move; nothing else |
| `marketplaceBidRevisions` | every submission: `contentJson`, `contentHash`, comparable total, the readiness picture at that instant | **write-once** |
| `marketplaceAwards` | one per posting: the bid, the revision, its `contentHash`, the rationale, the readiness picture | state only (`awarded` → `contracted` / `cancelled`) |
| `marketplaceEvents` | the tender trail: every transition, actor, organization, from, to, detail | append-only |

Every write also inserts a `domainEventOutbox` row (`marketplace.<event>`) in the same
transaction, via the existing `buildOutboxRow`, so the workflow engine can react and nothing can
exist without its event.

### Posting lifecycle

```
draft → published → bidding → bidding_closed → awarded → contracted → dispatched → active → completed → closed
cancel: from draft, published, bidding, bidding_closed, awarded   (never once contracted)
```

The states past `awarded` are declared in the machine (`server/_core/marketplace.ts`) so it is
complete; this checkpoint exposes no door into them.

### Bid lifecycle

```
draft → submitted → (withdrawn → submitted as a NEW revision)
submitted → shortlisted
submitted | shortlisted → accepted | rejected      (terminal)
```

A submitted bid is never edited. A change is a withdrawal and a new revision; v1 stays as v1. The
award recomputes the revision's hash from its stored content and refuses if it no longer matches
what was recorded at submission — tested by editing the row underneath the system.

### The bidding window is a clock

`biddingWindow(posting, now)` is open only when the posting is in `bidding` **and** the deadline,
where one is set, has not passed. A submission at the deadline is refused while the row still reads
`bidding`, because nobody has run the close yet. The client may close early; the trail records
`closedEarly: true` with the deadline it pre-empted.

### Sealed tender

`mayViewBidPricing` is the one rule: a bidder always sees its own price; the client sees prices on
an **open** posting at any time and on a **sealed** posting only from `bidding_closed` onward; any
other organization never sees another's price. The read models apply it to every row they return,
and the withheld shape says why (`pricing: { visible: false, reason }`). An open posting shows
eligible viewers an aggregate range over live bids, never a competitor's bid.

### Bid readiness — declared, not verified

> **Superseded at 0240 (checkpoint 4).** Readiness is now verified against the canonical registries;
> the declared qualifications remain in the bid's content and decide nothing. See
> `CHECKPOINT_4_VERIFIED_READINESS.md`. The paragraph below describes checkpoint 1 as built.

`assessBidReadiness` produces the ladder a client reads: counterparty, organization, contractor
profile, invitation, bidding window, certifications, permits, dangerous goods, insurance,
equipment, units, driver availability, HOS forecast. Each row is `PASS` / `WARNING` / `FAIL` /
`UNKNOWN`. Any `FAIL` makes the verdict `draft_only`: the bid can be prepared and saved but not
submitted. Requirement rows compare the posting's requirements with what the bidder **declares**,
and every passing requirement row reads `declared, not verified` so nobody mistakes a declaration
for a verification. Driver availability and HOS forecast are `UNKNOWN` ("not evaluated in this
checkpoint"), which is a warning in the picture, not a pass. The picture is frozen on the revision
and copied onto the award.

### The award

A person's decision with a reason, never "lowest wins". Under the posting lock; one award per
posting (unique index as well as the state machine); bound to the revision's content hash; every
other live bid rejected in the same transaction, each with its own event; the posting advances to
`awarded`.

## Authorization

Four permissions, two sides:

| Permission | Holders | Sensitive |
|---|---|---|
| `marketplace.read` | dispatcher, office, management, controller, auditor | |
| `marketplace.posting.manage` | office, management | |
| `marketplace.bid.manage` | dispatcher, office, management | yes |
| `marketplace.award` | management, controller | yes |

Eighteen `roleProcedure`s in `server/marketplaceRouter.ts` (`marketplace.*`), all acting for the
organization `resolveActingScope` establishes from membership; no procedure reads an organization
from input. Procedure census: 634 → 652.

## Tenant isolation, stated as behaviours the suite pins

* A draft is visible to its client only; to everyone else it is "not found", so its existence leaks
  to nobody.
* Only the client edits, publishes, opens, closes, invites, shortlists, awards or cancels; a stale
  `expectedVersion` is refused, never merged.
* An organization cannot bid on, or invite itself to, its own posting.
* An invite-only posting is listed to and readable by invitees alone.
* No bidder and no third organization reads the client's comparison table; a bidder reads the
  posting's events and its own bid's, never a competitor's.
* A third party sees that an awarded posting was awarded and to whom, not the price or the reason.

## Tests

* `server/_core/marketplace.test.ts` — 29 cases, no database: every transition and every refusal,
  the clock, the sealed rule, the range aggregate, content validation per pricing type, comparable
  totals (UNKNOWN when a quantity is missing; rounding), the content hash (stable across key order,
  moved by any content change), the readiness ladder, references.
* `server/marketplace.db.test.ts` — 7 cases through the real router against the gate database: the
  full sealed tender; the deadline at the clock; invite-only and isolation; a suspended bidder,
  pricing-basis mismatch and the wrong role at every door; cancellation after award; the tampered
  revision refused at award.
* `server/procedureAuthorization.test.ts`, `server/operationalApiAuthorization.test.ts` — the census
  moves to 652 and every new procedure is declared, wired and held by somebody.

## Next checkpoint

Connect an accepted award to the canonical dispatch/job creation workflow: award → contract /
work order → `dispatchPostings` + roles → operators and equipment → routes → tickets → billing →
closeout, with the client's one-time tracking links activated from the award, so nothing is
re-entered. Then the job-board UI, matching notifications, contractor profiles and the tender
discussion thread on top of this core.
