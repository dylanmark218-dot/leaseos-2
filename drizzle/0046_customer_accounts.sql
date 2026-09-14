-- v21.9.1 — Customer identity.
--
-- "ABC Energy" is a name. Two companies in one database can each have a
-- customer by that name, and cash application compared names. A customer
-- account is an identity: one entity, one account, one name — and a payment
-- allocates only to an invoice of the same entity and the same account.

CREATE TABLE `customerAccounts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `accountRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `name` varchar(220) NOT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerAccounts_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerAccounts_accountRef_unique` UNIQUE(`accountRef`),
  CONSTRAINT `customerAccounts_entity_name_unique` UNIQUE(`financialEntityId`,`name`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `customerAccountId` int NULL AFTER `customer`;
--> statement-breakpoint
ALTER TABLE `customerPayments` ADD COLUMN `customerAccountId` int NULL AFTER `customer`;
--> statement-breakpoint
ALTER TABLE `customerCredits` ADD COLUMN `customerAccountId` int NULL AFTER `customer`;
