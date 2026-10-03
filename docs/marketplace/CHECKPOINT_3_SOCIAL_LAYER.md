# Marketplace — Checkpoint 3: the social layer on the commercial core (0235)

**Release label:** v23.28
**Migration:** `0235_marketplace_social_layer.sql`
**Date:** 2026-10-01
**Builds on:** checkpoints 1 (0233) and 2 (0234)

## What this adds, and the one rule it is built on

The tender discussion, the opportunity feed, company profiles and preferred-contractor lists —
and **no new messaging engine**. Every notification the marketplace sends is a
`workflowNotifications` row in the recipient organization's tenant, addressed to its dispatcher,
office and management roles, which the universal inbox (`surfaces.inbox`) already reads. The
suite proves the invited organization's dispatcher sees the invitation in that inbox. Each
notification is written in the same transaction as the domain change and is idempotent on its
key, so a retried transaction cannot tell a company twice and a rolled-back state never
announces itself.

## Tender discussion (`marketplaceClarifications`)

* A bidder's **question** is private to the asker and the client. The client notified.
* The client's **answer** is written once; a correction is a new notice, never an edit. The asker
  notified.
* **Publishing** an answered question makes it one clarification for every bidder, with the
  asker withheld from everyone but the client and the asker, and tells every organization with a
  stake in the posting (anyone who has started a bid, every invitee). This is the fairness
  mechanism: no bidder is quietly handed information the others were not.
* A **notice** is the client's own clarification with no question behind it (a road ban lifted,
  a changed detail). Public from birth, same notifications.
* Questions and notices are taken only while the tender is live (`published`, `bidding`).
* Every step is on the posting's trail: `question_asked`, `question_answered`,
  `clarification_published`, `notice_issued`.

`clarificationVisibility` (pure) decides who reads what; `listClarifications` applies it.

## Opportunity feed (`marketplaceFollows`)

An organization follows a work type, an operating area, both, or everything. When a **public**
posting opens for bidding, every organization whose follow matches is told once; an invite-only
tender reaches nobody by following; an organization never hears about its own posting.
`followMatches` and `followMatchKey` (pure) hold the rule; the match key makes the follow unique
without relying on a unique index over NULLs.

## Profiles (`marketplaceCompanyProfiles`) and preferred lists (`marketplacePreferredContractors`)

A profile is what a company **declares**: display name, description, work types, operating
areas, equipment types. `profileGet` returns it beside what LeaseOS can state itself — the
organization's status, its contractor business profile, the number of marketplace awards and how
many reached contract — and `rating: "not_available"`, because a rating needs completed work and
a signed-off closeout, and an empty number would read as a bad one.

A client keeps a preferred-contractor list and `postingInvitePreferred` invites all of it to a
tender in one act, each invitation its own row, event and notification; already-invited
organizations are counted, not re-invited.

## Award outcomes

The awarded bidder and every rejected bidder are notified in the award's transaction.

## Authorization

Fourteen procedures, census 656 → 670. Asking, following and the profile are the contractor side
(`marketplace.bid.manage`); answering, publishing, notices and preferred lists are the client
side (`marketplace.posting.manage`); reads are `marketplace.read`.

## Tests

* `server/_core/marketplace.test.ts` +5: match keys, matching on both facets, never self or
  invite-only, visibility of private and published clarifications, the live-tender rule.
* `server/marketplaceSocial.db.test.ts` (5 cases through the real router): a matching follow
  notified once with the exact rows and read back from `surfaces.inbox`, a non-matching and a
  self follow not; the question private → answered (still private, write-once) → published
  (asker withheld, interested organizations told) → notice → refused once bidding closes;
  preferred list upsert and bulk invitation with inbox delivery; the profile's declared and
  recorded halves; award notifications to winner and losers.

## Still open

The job-board UI itself (P10.5). Verified readiness against the compliance registry (P10.3).
Private client ↔ bidder messaging before award and contractor ↔ client after award, which belongs
on a message-board channel rather than here. Ratings, which need closeout.
