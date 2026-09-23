-- 0171 — tenant ownership for tracking, and for everything a tracking number
-- is minted into. Phase A: ownership only, no behaviour change.
--
-- The owner's decision is per-organization sequence counters, with a tracking
-- reference identified by (orgRef, trackingNumber) rather than by a globally
-- unique trackingNumber. Re-auditing before writing this found the change is
-- not confined to the two tracking tables: nextTrackingNumber has twelve
-- production call sites, and each writes its result into a different table's
-- globally UNIQUE column — invoices.invoiceNumber, fieldTickets.ticketNumber,
-- disposalTickets.ticketNumber, billingBooks.bookNumber, customerCredits,
-- writeOffRequests, delayEvents, calibrationSweeps, manifestReconciliation-
-- Overrides. Ten of those eleven tables carry no ownership column at all.
--
-- So two organizations each counting from 1 would both mint INV-2026-000001
-- and the second INSERT would fail. A per-organization counter cannot be
-- switched on until those tables can tell two organizations' numbers apart.
--
-- THE ORDERING CONSTRAINT. Relaxing uniqueness before the readers are scoped
-- would introduce the very defect this checkpoint removes: while invoiceNumber
-- is globally unique an unscoped `WHERE invoiceNumber = ?` is unambiguous, but
-- the moment two organizations may both hold that number it returns whichever
-- row the database happens to yield. So:
--
--   Phase A (this migration)  ownership columns + proven backfill. Uniqueness
--                             stays global, the counter stays shared. Nothing
--                             about numbering moves, so nothing can collide.
--   Phase B (0172)            uniqueness becomes composite and the counter
--                             becomes per-organization, once every
--                             lookup-by-value is scoped.
--
-- BACKFILL. orgRef is nullable and is populated ONLY where the authoritative
-- chain proves the organization. Nothing is attributed to "default" to satisfy
-- a constraint, and there is no NOT NULL here to force that choice. NULL means
-- UNATTRIBUTED and nothing else — in particular it does not mean "shared":
-- application code must not let an ordinary acting organization read a NULL
-- row, which is the disclosure this whole checkpoint exists to prevent.
--
-- ORG is deliberately untouched. It mints organizations.orgRef, which IS the
-- tenant key; a per-organization counter for it would need an acting
-- organization in order to create one.

ALTER TABLE `trackingSequences` ADD COLUMN `orgRef` varchar(40) NULL AFTER `sequenceType`;
--> statement-breakpoint
ALTER TABLE `trackingReferences` ADD COLUMN `orgRef` varchar(40) NULL AFTER `trackingNumber`;
--> statement-breakpoint
ALTER TABLE `fieldTickets` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `billingBooks` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `delayEvents` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `customerCredits` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `writeOffRequests` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `manifestReconciliationOverrides` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `calibrationSweeps` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint
ALTER TABLE `signatoryAuthorities` ADD COLUMN `orgRef` varchar(40) NULL;
--> statement-breakpoint

-- ATTRIBUTED — the job owns the record, and the job carries a real orgRef.
UPDATE `fieldTickets` t JOIN `jobs` j ON j.id = t.jobId
  SET t.orgRef = j.orgRef WHERE j.orgRef IS NOT NULL;
--> statement-breakpoint
UPDATE `disposalTickets` t JOIN `jobs` j ON j.id = t.jobId
  SET t.orgRef = j.orgRef WHERE j.orgRef IS NOT NULL;
--> statement-breakpoint
UPDATE `billingBooks` b JOIN `jobs` j ON j.id = b.jobId
  SET b.orgRef = j.orgRef WHERE j.orgRef IS NOT NULL;
--> statement-breakpoint
UPDATE `delayEvents` d JOIN `jobs` j ON j.id = d.jobId
  SET d.orgRef = j.orgRef WHERE j.orgRef IS NOT NULL;
--> statement-breakpoint

-- ATTRIBUTED — money is owned by its financial entity (0146 calls that the
-- tenant boundary for money), so an invoice or a credit inherits from there.
UPDATE `invoices` i JOIN `financialEntities` e ON e.id = i.financialEntityId
  SET i.orgRef = e.orgRef WHERE e.orgRef IS NOT NULL;
--> statement-breakpoint
UPDATE `customerCredits` c JOIN `financialEntities` e ON e.id = c.financialEntityId
  SET c.orgRef = e.orgRef WHERE e.orgRef IS NOT NULL;
--> statement-breakpoint

-- ATTRIBUTED, one hop further: a write-off is about an invoice, and the
-- invoice has just been attributed above. Order matters here.
UPDATE `writeOffRequests` w JOIN `invoices` i ON i.id = w.invoiceId
  SET w.orgRef = i.orgRef WHERE i.orgRef IS NOT NULL;
--> statement-breakpoint

-- ATTRIBUTED — a custody override is about one manifest.
UPDATE `manifestReconciliationOverrides` o JOIN `manifests` m ON m.id = o.manifestId
  SET o.orgRef = m.orgRef WHERE m.orgRef IS NOT NULL;
--> statement-breakpoint

-- ATTRIBUTED — a tracking reference that names a job directly.
UPDATE `trackingReferences` r JOIN `jobs` j ON j.id = r.jobId
  SET r.orgRef = j.orgRef WHERE j.orgRef IS NOT NULL;
--> statement-breakpoint
-- And one whose entity is a job by (entityType, entityId) rather than by jobId.
UPDATE `trackingReferences` r JOIN `jobs` j ON j.id = r.entityId
  SET r.orgRef = j.orgRef
  WHERE r.orgRef IS NULL AND r.entityType IN ('JOB','job') AND j.orgRef IS NOT NULL;
--> statement-breakpoint

-- UNATTRIBUTED, left NULL on purpose and recorded here rather than guessed:
--
--   calibrationSweeps      no ownership chain exists. A sweep is about a
--                          measurement device, and devices carry no owner.
--   signatoryAuthorities   customerAccountId is the COUNTERPARTY, not the
--                          owner. Attributing a record to the company it is
--                          about would be exactly the inference this
--                          checkpoint forbids.
--   trackingSequences      configuration, owned by nobody historically. The
--                          rows that exist were minted under the single tenant
--                          and no organization can be proven for them.
--   every row above whose chain ends in a NULL orgRef — the job, entity or
--                          manifest is itself unattributed, so the leaf is too.
--
-- These stay NULL. Unknown ownership stays unknown.

CREATE INDEX `trackingReferences_org_number_idx` ON `trackingReferences` (`orgRef`, `trackingNumber`);
--> statement-breakpoint
CREATE INDEX `trackingSequences_org_scope_idx` ON `trackingSequences` (`orgRef`, `sequenceType`, `branch`, `periodKey`);
--> statement-breakpoint
CREATE INDEX `fieldTickets_org_idx` ON `fieldTickets` (`orgRef`);
--> statement-breakpoint
CREATE INDEX `disposalTickets_org_idx` ON `disposalTickets` (`orgRef`);
--> statement-breakpoint
CREATE INDEX `invoices_org_idx` ON `invoices` (`orgRef`);
--> statement-breakpoint
CREATE INDEX `customerCredits_org_idx` ON `customerCredits` (`orgRef`);
--> statement-breakpoint
CREATE INDEX `writeOffRequests_org_idx` ON `writeOffRequests` (`orgRef`);
