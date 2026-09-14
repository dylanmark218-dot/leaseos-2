-- v22.10 — An approved invoice reaches the customer.
--
-- The invoice's document is rendered deterministically from its frozen
-- billing snapshot and stored beside the ticket's own documents, under the
-- kind `invoice`, so the customer portal lists and downloads it where it
-- already lists the ticket's. A document may belong to an invoice rather
-- than a ticket revision.

ALTER TABLE `fieldTicketDocuments`
  MODIFY COLUMN `kind` enum('site_ticket_r1','post_site_ticket','completion_package','invoice') NOT NULL,
  MODIFY COLUMN `revisionId` int NULL,
  ADD COLUMN `invoiceId` int AFTER `revisionId`;
--> statement-breakpoint
CREATE INDEX `fieldTicketDocuments_invoice` ON `fieldTicketDocuments` (`invoiceId`);
