-- v22.30 — 0137 (P7.5): vendor bills and payment releases go through the approval ledger.
--
-- `vendor.billApprove` had no dollar tier and no separation of duties — the same call coded
-- and approved a bill, and nothing recorded who had entered it. The recorder is kept from
-- here on (NULL on bills that predate this: an unknown preparer, which the ledger cannot
-- check and does not pretend to). Tiers come from commercialApprovalPolicies (0133/0136),
-- categories `vendor_bill` and `payment`; each decision is a signature in the ledger.

ALTER TABLE `vendorBills` ADD COLUMN `recordedByUserId` int NULL;
