-- 0172 — a tracking number stops being globally unique.
--
-- Phase B of the owner's decision. 0171 put ownership on every table a minted
-- number lands in and scoped every lookup that addresses a record by one. This
-- is the flip those were the prerequisite for:
--
--   before   UNIQUE (invoiceNumber)          one number, one record, anywhere
--   after    UNIQUE (orgKey, invoiceNumber)  one number per organization
--
-- so Tenant A and Tenant B may both hold FT-000001 and they are different
-- records because their ownership differs. That is the business rule: LeaseOS
-- must not depend on a human-readable number being unique across every company
-- using the platform.
--
-- WHY orgKey RATHER THAN orgRef. `orgRef` is nullable, and MySQL treats NULLs
-- as DISTINCT inside a unique index. A composite on (orgRef, number) would
-- therefore place no constraint at all on the unattributed rows — and, worse,
-- none on a single-tenant deployment, where every new row is written with a
-- NULL owner by design. The whole point of the constraint would be lost
-- precisely where there is only one tenant to protect.
--
-- `orgKey` is a stored generated column, COALESCE(orgRef, '~unattributed'), so:
--
--   two organizations may hold the same number          A / B          allowed
--   one organization may not repeat its own number      A / A          refused
--   the unattributed pool may not repeat one either     NULL / NULL    refused
--
-- The last line is what keeps a single-tenant installation honest. `orgRef`
-- keeps its NULL-means-UNATTRIBUTED meaning untouched; nothing is coerced to a
-- sentinel in the column anybody reads.
--
-- The tilde in '~unattributed' is deliberate: it sorts after the alphanumerics
-- an orgRef is minted from, and no organization reference can collide with it.
--
-- orgKey is deliberately NOT declared in drizzle/schema.ts. MySQL accepts a
-- generated column in an INSERT only when the value is DEFAULT (an explicit one
-- is error 1906), so declaring it is safe until somebody sets it — a trap
-- rather than a contract. Nothing in the
-- application needs to read it either — scoping is on orgRef, and the only
-- place that names orgKey is the counter's own raw SQL, which knows it is
-- COALESCE(orgRef, '~unattributed'). The index exists in the database and the
-- constraint is enforced there, which is where it belongs.
--
-- Twelve sequence types mint numbers. Eleven of them land in the tables below;
-- the twelfth is ORG, and organizations.orgRef is NOT touched. It IS the tenant key, and a
-- per-organization counter for the sequence that mints it would need an acting
-- organization in order to create one.

ALTER TABLE `trackingReferences`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `trackingReferences_trackingNumber_unique` ON `trackingReferences`;
--> statement-breakpoint
CREATE UNIQUE INDEX `trackingReferences_org_scope_uq` ON `trackingReferences` (`orgKey`, `trackingNumber`);
--> statement-breakpoint
ALTER TABLE `trackingSequences`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `trackingSequences_scope_idx` ON `trackingSequences`;
--> statement-breakpoint
CREATE UNIQUE INDEX `trackingSequences_org_scope_uq` ON `trackingSequences` (`orgKey`, `sequenceType`, `branch`, `periodKey`);
--> statement-breakpoint
ALTER TABLE `invoices`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `invoices_invoiceNumber_unique` ON `invoices`;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_org_scope_uq` ON `invoices` (`orgKey`, `invoiceNumber`);
--> statement-breakpoint
ALTER TABLE `fieldTickets`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `fieldTickets_ticketNumber_unique` ON `fieldTickets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `fieldTickets_org_scope_uq` ON `fieldTickets` (`orgKey`, `ticketNumber`);
--> statement-breakpoint
ALTER TABLE `disposalTickets`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `disposalTickets_ticketNumber_unique` ON `disposalTickets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `disposalTickets_org_scope_uq` ON `disposalTickets` (`orgKey`, `ticketNumber`);
--> statement-breakpoint
ALTER TABLE `billingBooks`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `billingBooks_bookNumber_unique` ON `billingBooks`;
--> statement-breakpoint
CREATE UNIQUE INDEX `billingBooks_org_scope_uq` ON `billingBooks` (`orgKey`, `bookNumber`);
--> statement-breakpoint
ALTER TABLE `customerCredits`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `customerCredits_creditRef_unique` ON `customerCredits`;
--> statement-breakpoint
CREATE UNIQUE INDEX `customerCredits_org_scope_uq` ON `customerCredits` (`orgKey`, `creditRef`);
--> statement-breakpoint
ALTER TABLE `writeOffRequests`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `writeOffRequests_requestRef_unique` ON `writeOffRequests`;
--> statement-breakpoint
CREATE UNIQUE INDEX `writeOffRequests_org_scope_uq` ON `writeOffRequests` (`orgKey`, `requestRef`);
--> statement-breakpoint
ALTER TABLE `delayEvents`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `delayEvents_delayRef_unique` ON `delayEvents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `delayEvents_org_scope_uq` ON `delayEvents` (`orgKey`, `delayRef`);
--> statement-breakpoint
ALTER TABLE `calibrationSweeps`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `cs_ref` ON `calibrationSweeps`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calibrationSweeps_org_scope_uq` ON `calibrationSweeps` (`orgKey`, `sweepRef`);
--> statement-breakpoint
ALTER TABLE `manifestReconciliationOverrides`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `mro_ref` ON `manifestReconciliationOverrides`;
--> statement-breakpoint
CREATE UNIQUE INDEX `manifestReconciliationOverrides_org_scope_uq` ON `manifestReconciliationOverrides` (`orgKey`, `overrideRef`);
--> statement-breakpoint
ALTER TABLE `signatoryAuthorities`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`orgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `signatoryAuthorities_authorityRef_unique` ON `signatoryAuthorities`;
--> statement-breakpoint
CREATE UNIQUE INDEX `signatoryAuthorities_org_scope_uq` ON `signatoryAuthorities` (`orgKey`, `authorityRef`);
--> statement-breakpoint

-- commercialDocuments keys on `bookOrgRef` rather than `orgRef`: a commercial
-- document belongs to a BOOK, which is the axis this table already carried
-- before 0171 and the reason it is not in that migration's list. Its DOC
-- sequence is minted per book, so its reference has to be unique per book and
-- not per installation, exactly like the eleven above.
ALTER TABLE `commercialDocuments`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`bookOrgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `commercialDocuments_ref` ON `commercialDocuments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `commercialDocuments_org_scope_uq` ON `commercialDocuments` (`orgKey`, `documentRef`);
--> statement-breakpoint

-- commercialApprovals keys its ledger row on the SUBJECT, and subject
-- references are minted per organization now. Left global, two books holding
-- CR-2026-000001 would share one approval chain: one business's manager
-- approving their own credit would satisfy the other business's, on a subject
-- they have never seen. The book is part of the subject's identity.
ALTER TABLE `commercialApprovals`
  ADD COLUMN `orgKey` varchar(48) AS (COALESCE(`bookOrgRef`, '~unattributed')) STORED;
--> statement-breakpoint
DROP INDEX `commercialApprovals_subject` ON `commercialApprovals`;
--> statement-breakpoint
CREATE UNIQUE INDEX `commercialApprovals_subject` ON `commercialApprovals` (`orgKey`, `subjectType`, `subjectRef`);
