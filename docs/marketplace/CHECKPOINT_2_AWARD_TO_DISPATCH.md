# Marketplace — Checkpoint 2: Award → canonical dispatch (0234)

**Release label:** v23.27
**Migration:** `0234_marketplace_contracts.sql`
**Date:** 2026-10-01
**Builds on:** `CHECKPOINT_1_MARKETPLACE_FOUNDATION.md` (0233)

## What this closes

After the client presses AWARD, nobody re-enters anything. The award becomes a contract, the
contract becomes the contractor's job and commercial chain, and the contractor dispatches it
through the same door its dispatcher's screen uses:

```
Marketplace posting → accepted bid (hashed revision) → award
      → contract (0234)                          [client issues]
            → jobs row, owned by the CONTRACTOR, customerOrgRef = client
            → commercialJobChains row, numbered JOB-…-C01 by the shared allocator
      → dispatchPostings + dispatchRoles          [contractor dispatches, via dispatchRoleService.createPosting]
            → one PRIMARY_UNIT slot per unit the posting required, carrying the required equipment class
```

From there the existing systems take over unchanged: role assignment with its eligibility
fingerprint, bookings, tickets, the commercial chain's load numbering, contractor payables and
billing. None of them learned anything new; the marketplace handed them a job they already know
how to run.

## The two doors, and why there are two

**`marketplace.contractIssue`** — the client, `marketplace.posting.manage`. One transaction under
the posting lock: posting `awarded → contracted`, award `awarded → contracted`, the job, the chain
(`CONTRACT:<jobId>` sequence, same allocator as `contractorOperations.jobChainCreate` — lifted
into `server/_core/commercialChainNumbers.ts` so there is one), the contract row carrying the
award's content hash, two trail events and two outbox rows.

**`marketplace.contractDispatch`** — the contractor, gated by **`dispatch.assign`**, the
permission its dispatcher already needs to create a posting. The canonical door
(`dispatchRoleService.createPosting`) runs its own transaction in the contractor's scope — it
refuses a job the contractor does not own, which is exactly why the job is created as the
contractor's — so the bridge is two steps made safe by idempotence: a dispatch posting that
already exists for the contract's job is bound rather than duplicated (a crash between the two
steps leaves nothing orphaned), and a second call on a dispatched contract returns what it has.

The client's part ends at issue. It cannot dispatch the contractor's job, and its own dispatcher
cannot read the contractor's slots, because the job is not the client's.

## Model

`marketplaceContracts`: one per award (unique on award, posting and job), both organizations, the
content hash, the job and chain it created, the dispatch posting it was bound to, `issued →
dispatched` (or `cancelled`, unexposed), who issued and who dispatched.

The legacy `jobs.mode` is read from the work type (`jobModeForWorkType`) and decides nothing
downstream on its own.

## Authorization

| Procedure | Permission |
|---|---|
| `marketplace.contractIssue` | `marketplace.posting.manage` |
| `marketplace.contractDispatch` | `dispatch.assign` |
| `marketplace.contractGet`, `marketplace.contractsMine` | `marketplace.read` |

Procedure census 652 → 656.

## Tests

`server/marketplaceBridge.db.test.ts`, through the real router against the gate database: the
contract refused before the award and by the wrong party; the job and chain exactly as the posting
stated them; the award moved to `contracted`; the contract read by both parties and by nobody
else; the client, the contractor's office (no `dispatch.assign`) and a stranger refused at the
dispatch door; four `PRIMARY_UNIT` slots listed back through `dispatch.listRoles` as the
contractor's own with the required equipment class, and invisible to the client's dispatcher;
cancellation closed once contracted; the trail and the outbox in order; a second dispatch binding
rather than duplicating; and a dispatch posting created by the canonical door before the bridge's
second step being bound instead of doubled.

## Not in this checkpoint

The client's one-time tracking links are not activated from the award yet (the customer live
view's own portal invitation path remains the door). The contractor cannot decline an issued
contract from here; `cancelled` exists on the contract and nothing exposes it. Posting states past
`dispatched` (`active`, `completed`, `closed`) have no door yet; they belong with tickets and
closeout feeding back. Verified readiness, the job-board UI and the clarification thread remain
P10.3 and P10.4.
