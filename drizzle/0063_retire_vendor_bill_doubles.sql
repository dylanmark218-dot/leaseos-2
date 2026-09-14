-- v22.5 — The first ledger retires its doubles.
--
-- Every reader of vendor bills and their lines now reads the integer
-- shadows, every writer writes only them, and every row was backfilled
-- (0061) and reconciled by test since. The triggers that referenced the
-- doubles are dropped first; then the doubles; then the totals become NOT
-- NULL, as the doubles were. The grandfathered list shrinks by five.

DROP TRIGGER IF EXISTS `vendorBills_cents_bi`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `vendorBills_cents_bu`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `vendorBillLines_cents_bi`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `vendorBillLines_cents_bu`;
--> statement-breakpoint
ALTER TABLE `vendorBills`
  DROP COLUMN `subtotal`,
  DROP COLUMN `taxAmount`,
  DROP COLUMN `total`,
  MODIFY COLUMN `totalCents` int NOT NULL;
--> statement-breakpoint
ALTER TABLE `vendorBillLines`
  DROP COLUMN `unitPrice`,
  DROP COLUMN `amount`,
  MODIFY COLUMN `amountCents` int NOT NULL;
