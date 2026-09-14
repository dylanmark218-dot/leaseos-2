-- v22.3 — Integer money shadows on the two highest-traffic ledgers that
-- still carry money as double: vendor bills and fuel. Forward migration
-- only: the double columns stay (older readers keep working), the cents
-- columns are backfilled from them by ROUND(x * 100), and every write
-- from here on sets both. A test reconciles the pairs on every row. The
-- remaining double money columns are pinned as a grandfathered list that
-- can only shrink.

ALTER TABLE `vendorBills`
  ADD COLUMN `subtotalCents` int AFTER `subtotal`,
  ADD COLUMN `taxAmountCents` int AFTER `taxAmount`,
  ADD COLUMN `totalCents` int AFTER `total`;
--> statement-breakpoint
UPDATE `vendorBills` SET `subtotalCents` = ROUND(`subtotal` * 100), `taxAmountCents` = ROUND(`taxAmount` * 100), `totalCents` = ROUND(`total` * 100);
--> statement-breakpoint

ALTER TABLE `vendorBillLines`
  ADD COLUMN `unitPriceCents` int AFTER `unitPrice`,
  ADD COLUMN `amountCents` int AFTER `amount`;
--> statement-breakpoint
UPDATE `vendorBillLines` SET `unitPriceCents` = ROUND(`unitPrice` * 100), `amountCents` = ROUND(`amount` * 100);
--> statement-breakpoint

ALTER TABLE `fuelTransactions`
  ADD COLUMN `subtotalCents` int AFTER `subtotal`,
  ADD COLUMN `taxAmountCents` int AFTER `taxAmount`,
  ADD COLUMN `totalCents` int AFTER `total`;
--> statement-breakpoint
UPDATE `fuelTransactions` SET `subtotalCents` = ROUND(`subtotal` * 100), `taxAmountCents` = ROUND(`taxAmount` * 100), `totalCents` = ROUND(`total` * 100);
--> statement-breakpoint
-- The database guarantees the shadow for any write that bypasses the application's dual write (imports, raw fixtures, older tools):
-- a missing shadow is filled from the double on insert; a double changed without its shadow re-derives it on update. Single
-- statements, so the migration runner needs no delimiter change.
CREATE TRIGGER `vendorBills_cents_bi` BEFORE INSERT ON `vendorBills` FOR EACH ROW SET NEW.`subtotalCents` = COALESCE(NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`taxAmountCents` = COALESCE(NEW.`taxAmountCents`, ROUND(NEW.`taxAmount` * 100)), NEW.`totalCents` = COALESCE(NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
CREATE TRIGGER `vendorBills_cents_bu` BEFORE UPDATE ON `vendorBills` FOR EACH ROW SET NEW.`subtotalCents` = IF(NEW.`subtotal` <=> OLD.`subtotal`, NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`taxAmountCents` = IF(NEW.`taxAmount` <=> OLD.`taxAmount`, NEW.`taxAmountCents`, ROUND(NEW.`taxAmount` * 100)), NEW.`totalCents` = IF(NEW.`total` <=> OLD.`total`, NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
CREATE TRIGGER `vendorBillLines_cents_bi` BEFORE INSERT ON `vendorBillLines` FOR EACH ROW SET NEW.`unitPriceCents` = COALESCE(NEW.`unitPriceCents`, ROUND(NEW.`unitPrice` * 100)), NEW.`amountCents` = COALESCE(NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `vendorBillLines_cents_bu` BEFORE UPDATE ON `vendorBillLines` FOR EACH ROW SET NEW.`unitPriceCents` = IF(NEW.`unitPrice` <=> OLD.`unitPrice`, NEW.`unitPriceCents`, ROUND(NEW.`unitPrice` * 100)), NEW.`amountCents` = IF(NEW.`amount` <=> OLD.`amount`, NEW.`amountCents`, ROUND(NEW.`amount` * 100));
--> statement-breakpoint
CREATE TRIGGER `fuelTransactions_cents_bi` BEFORE INSERT ON `fuelTransactions` FOR EACH ROW SET NEW.`subtotalCents` = COALESCE(NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`taxAmountCents` = COALESCE(NEW.`taxAmountCents`, ROUND(NEW.`taxAmount` * 100)), NEW.`totalCents` = COALESCE(NEW.`totalCents`, ROUND(NEW.`total` * 100));
--> statement-breakpoint
CREATE TRIGGER `fuelTransactions_cents_bu` BEFORE UPDATE ON `fuelTransactions` FOR EACH ROW SET NEW.`subtotalCents` = IF(NEW.`subtotal` <=> OLD.`subtotal`, NEW.`subtotalCents`, ROUND(NEW.`subtotal` * 100)), NEW.`taxAmountCents` = IF(NEW.`taxAmount` <=> OLD.`taxAmount`, NEW.`taxAmountCents`, ROUND(NEW.`taxAmount` * 100)), NEW.`totalCents` = IF(NEW.`total` <=> OLD.`total`, NEW.`totalCents`, ROUND(NEW.`total` * 100));
