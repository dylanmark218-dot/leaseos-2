-- v22.11 — Credits and voids through the invoice path.
--
-- A void is recorded on the invoice, not by deleting it: who, when, why.
-- The snapshot stays. The billing book entries the invoice held are
-- released so the lines can be drafted again.

ALTER TABLE `invoices`
  ADD COLUMN `voidedAt` timestamp NULL AFTER `disputedAt`,
  ADD COLUMN `voidedByUserId` int AFTER `voidedAt`,
  ADD COLUMN `voidReason` varchar(400) AFTER `voidedByUserId`;
