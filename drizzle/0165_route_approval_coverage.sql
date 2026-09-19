-- v23.12 — 0165 (§10.4): what was known when the route was approved.
--
-- Owner decision of 2026-09-19. Verified coverage is persisted per axis on the approval itself, and
-- not recomputed later, for one reason: a route approved at 13% verified weight coverage must still
-- read 13% after the province publishes data that lifts it to 60%. "Was this reasonable on what we
-- had?" and "what do we have now?" are different questions, and only the stored answer survives to
-- be asked.
--
-- Same shape as `0159` storing the axle determination rather than re-deriving it, and for the same
-- reason: the inputs move, the decision does not.
--
-- The coverage figures are deliberately NOT a gate. A percentage threshold would demand a second
-- signature on essentially every Alberta route, because OpenStreetMap carries 24 `maxweight` tags
-- across 512,979 vehicle-road ways — and a signature given hundreds of times a week is a keystroke,
-- not a control. Escalation is driven by `highConsequenceUnresolved` / `secondApprovalRequired`,
-- which name specific unresolved facts on roads the route actually uses.
ALTER TABLE `routeApprovals`
  ADD COLUMN `coverageByAxisJson` text NULL,
  ADD COLUMN `totalApplicableChecks` int NULL,
  ADD COLUMN `totalVerifiedChecks` int NULL,
  ADD COLUMN `highConsequenceUnresolved` int NULL,
  ADD COLUMN `secondApprovalRequired` tinyint(1) NULL,
  ADD COLUMN `secondApprovalReasonsJson` text NULL,
  ADD COLUMN `secondApproverUserId` int NULL,
  ADD COLUMN `secondApprovedAt` timestamp NULL;
