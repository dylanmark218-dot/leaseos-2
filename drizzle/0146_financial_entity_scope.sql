-- v22.41 — 0146 (P4.1 router 4): the financial entity is the tenant boundary for money.
-- Payroll profiles, pay periods, pay runs, settlements, expenses and registrations all key
-- to a financial entity; the entity had no owner, so nothing scoped them. As in 0132:
-- NULL = the historical single tenant's; a member sees the entities their organization owns.
ALTER TABLE `financialEntities` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `financialEntities_org` ON `financialEntities` (`orgRef`);
