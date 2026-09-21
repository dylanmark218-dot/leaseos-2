-- v22.20 — 0083: what the order actually demands, as a value.
--
-- `releaseCondition` is the issuing authority's own words and stays exactly as
-- written. This adds the typed act those words require, so the dominance rule —
-- company policy may strengthen the condition and never weaken it — is decided
-- from stored data rather than from an argument a caller happened to pass.
--
-- It is NULL where nobody has established which act is required, and NULL means
-- exactly that. It is never inferred by parsing the prose: deciding whether a
-- truck may move by string-matching "reinspection" in free text is the kind of
-- cleverness that eventually frees a truck it should not.

ALTER TABLE `outOfServiceOrders`
  ADD COLUMN `requiredFindingType` enum('repair_verification','reinspection','inspector_release','document_confirmation','waiting_period_complete','other') NULL AFTER `releaseCondition`;
