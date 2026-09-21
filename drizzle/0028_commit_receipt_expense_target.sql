-- v20.15 — A third typed commit target.
--
-- Forward migration rather than an edit to 0025: the receipt enum gains
-- `expense_record` so a photographed receipt can commit to an expense DRAFT
-- through the same audited, allowlisted, independently authorized boundary
-- as trip stops and defects. Nothing else about the receipt spine changes.

ALTER TABLE `assistantCommitReceipts`
  MODIFY COLUMN `targetType` enum('trip_stop','maintenance_defect','expense_record') NOT NULL;
--> statement-breakpoint

-- A claim may be recorded without an opportunity. A historical claim entered
-- to seed the double-dip ledger, or a claim a bookkeeper knows about that never
-- passed through matching, still has to be on the ledger — the ledger is what
-- makes the next duplicate detectable.
ALTER TABLE `fundingClaims`
  MODIFY COLUMN `fundingOpportunityId` int NULL;
