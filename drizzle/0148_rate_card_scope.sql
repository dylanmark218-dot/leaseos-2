-- v22.48 — 0148 (P4.1 router 10, second slice): a billing rate card is company-private pricing and
-- carried no owner. As jobs (0132): NULL = the historical single tenant's; a member sees the rate
-- cards their organization owns. Manifests already carry orgRef (0129); nothing wrote it until now.
ALTER TABLE `billingRateCards` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `billingRateCards_org` ON `billingRateCards` (`orgRef`);
