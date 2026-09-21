-- v22.6 — The fuel ledger retires its doubles.
--
-- Amounts to cents, the per-unit price to thousandths (0062), every reader
-- on the shadows, every writer writing only them, every row backfilled and
-- reconciled since. Triggers first, then the doubles, then the total NOT
-- NULL as it was. The grandfathered list shrinks by five.

DROP TRIGGER IF EXISTS `fuelTransactions_cents_bi`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `fuelTransactions_cents_bu`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `fuelTransactions_money_bi`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `fuelTransactions_money_bu`;
--> statement-breakpoint
ALTER TABLE `fuelTransactions`
  DROP COLUMN `unitPrice`,
  DROP COLUMN `subtotal`,
  DROP COLUMN `taxAmount`,
  DROP COLUMN `total`,
  DROP COLUMN `reimbursedAmount`,
  MODIFY COLUMN `totalCents` int NOT NULL;
