-- v22.91 — 0161 (P3.2): whether accepted lines may bill while other lines are disputed is the
-- customer's contract to decide, not ours.
--
-- P3.2's original definition reads "accepted lines flow to billing WHEN CUSTOMER CONFIG PERMITS."
-- The permission half was never built: the readiness engine says "accepted lines may still be
-- billed" for every customer on every ticket. Some contracts genuinely work that way. Others
-- require the whole ticket accepted before any of it invoices, and billing part of a disputed
-- ticket against one of those is a dispute generator and arguably a breach.
--
-- NULL is the important value here, and it is the default on purpose. An unset flag means nobody
-- has recorded what this contract says — which is not permission. `billingReadiness` answers
-- REVIEW for NULL rather than billing, because "we never asked" and "the contract allows it" are
-- different facts and only one of them is a reason to send an invoice.
ALTER TABLE `customerContractTerms`
  ADD COLUMN `partialAcceptanceBillable` tinyint(1) NULL;
