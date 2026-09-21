-- v22.66 — 0152 (P8.1): the eligibility check keeps the capability picture it was decided on.
--
-- dispatchEligibilityChecks already stores the verdict, the blockers and the fingerprint, so a
-- decision can be explained later. What it could not store, until the capability contract existed,
-- is what was NOT evaluated when the decision was made: a module switched off, one never licensed,
-- one that did not apply to that trip. A required capability that was unevaluated does leave a
-- blocker (`capability_not_evaluated_*`), so that much was recoverable — but an OPTIONAL one leaves
-- no trace at all, and "which checks were not run against this dispatch" is precisely what an audit
-- package is asked months afterwards.
--
-- Recomputing it at package time would answer with today's configuration for yesterday's decision,
-- which is worse than not answering: it would look like evidence.
--
-- NULL means the check predates the contract. Unknown stays unknown; it is not backfilled with an
-- assumption that everything was evaluated.
ALTER TABLE `dispatchEligibilityChecks`
  ADD COLUMN `capabilitiesJson` text NULL,
  ADD COLUMN `capabilityVerdict` varchar(16) NULL;
