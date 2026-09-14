-- v22.9 — An invoice from the ticket's decisions.
--
-- Until now no application path created an invoice; AR, cash and the
-- commercial check read rows that only tests wrote, and the billing book
-- and snapshot tables had no writers. An invoice is now drafted from a
-- signed ticket's accepted lines and their pricing decisions, line by line,
-- each line naming the ticket line and the decision it came from; the
-- billing book is opened for the job and its entries written; finalization
-- freezes a snapshot with a hash. Money is cents.

CREATE TABLE `invoiceLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `invoiceId` int NOT NULL,
  `lineNo` int NOT NULL,
  `fieldTicketLineId` int,
  `pricingDecisionRef` varchar(64),
  `serviceCode` varchar(60),
  `description` varchar(300) NOT NULL,
  `quantityMillis` int NOT NULL,
  `billableQuantityMillis` int NOT NULL,
  `unit` varchar(20) NOT NULL,
  `rateMillis` int,
  `amountCents` int NOT NULL,
  `basis` varchar(160) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `invoiceLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `invoiceLines_invoice_line_unique` UNIQUE(`invoiceId`, `lineNo`)
);
