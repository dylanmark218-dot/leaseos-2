# Marketplace — Checkpoint 5 (P10.5): the Job Board UI

**Release label:** v23.30
**Migration:** none
**Date:** 2026-10-02
**Builds on:** checkpoints 1–4 (0237–0240)

## What this is

The Marketplace area of the office portal at `/marketplace`, in the navigation beside Training
Academy: Job Board, My Bids, Invitations, Awards, Active Contracts, Completed Work. It reads and
writes only the `marketplace.*` procedures; it decides nothing the server did not already decide.

Built the way every office screen since P7.9 is built: a pure view (`MarketplaceView.tsx`, facts
in through props, actions out through callbacks) and a container (`Marketplace.tsx`) that wires
it to tRPC and nothing else. The design system's six-state vocabulary carries every readiness row
(✓ Ready, ! Review, × Blocked, ? Unknown) — icon and word, colour reinforcing.

## What each screen shows, and what it refuses to show

* **Job Board** — every posting the organization may see, each with its bidding window as the
  server computed it. The selected tender: its structured fields, its typed requirements
  (client-stated ones marked "not machine-checked"), the discussion, and then one of two panels.
  As the **client**: lifecycle actions the state allows (publish, open, close, issue contract;
  cancel only with a reason), the bids with their prices *as withheld or not by the server*, each
  bidder's **eligibility projection** (eligible / eligible with warnings / not currently eligible,
  "changed since submission"), a shortlist button, and an award that needs a ten-character reason —
  under the sentence that the award is never the lowest number. As a **bidder**: the organization's
  own verified readiness rows with their detail and the dispatch gate's questions named as not
  decided here, the draft form (fixed, unit-rate or hourly; cents only; units offered), save, and a
  submit button enabled only when the server's verdict is submittable — a blocked draft stays
  editable and says so. Questions go up from bidders; answers, publication and notices come from
  the client; a published clarification shows "asker withheld".
* **My Bids** — every revision with its readiness at submission, beside the picture now and the
  changed-since-submission flag.
* **Invitations** — invite-only tenders this organization was asked into.
* **Awards** — postings awarded (either role) and the organization's accepted and rejected bids.
* **Active Contracts** — issued and dispatched contracts with job and chain numbers; the
  contractor's "Dispatch" door creates the slots, and the text says staffing and the readiness gate
  continue on the Dispatch screen.
* **Completed Work** — empty, and says why: nothing is called complete before closeout (P10.7).

## Tests

* `client/src/pages/MarketplaceView.dom.test.tsx` (8): the board as a bidder (window, requirements,
  sealed price text; readiness vocabulary and a submit disabled while blocked; the draft's
  validation and pricing shape; asking and the withheld asker), as the client (projections without
  reasons, a withheld price, the ten-character award, lifecycle actions and the reasoned cancel,
  posting creation), and the other five tabs including the honest empty Completed Work.
* `client/src/a11y/a11y.dom.test.tsx` — seven Marketplace surfaces (both roles on the board and
  every tab) run through the real axe WCAG A/AA rules at three widths.
* `server/a11yCoverage.test.ts` names the container as not-a-surface; `crossLayerIntegrity`
  proves every procedure the view references is mounted.

## Not in this checkpoint

A browser end-to-end run (the repository has none for any screen). Profile editing and following
have procedures but no screen yet. Company profile pages, the preferred-contractor list, and the
private client ↔ bidder conversation (P10.6) are next.
