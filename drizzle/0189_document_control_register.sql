-- 0189 — Document Control, Checkpoint B: the 0144 register becomes origin-aware.
--
-- Slot: built as 0179 on claude/document-control-architecture-jlffzk; renumbered 0189 when adopted onto
-- main (2026-09-24), because main took 0179 for trip_stop_provenance and open branches hold 0180–0188
-- (docs/architecture/MIGRATION_COLLISION_REGISTER.md). Content unchanged.
--
-- A controlled record must always say how it came to exist (originKind), who issued it (issuerKind
-- and the resolution of that issuer), which definition governs it, whether it carries a LeaseOS
-- control number, and where it stands in its review/issue lifecycle (controlState). Rows registered
-- before this migration have a NULL originKind, which reads as "unrecorded" — never as a guess.
-- Their controlState defaults to confirmed: a person registered them with a hash.
--
-- `controlNumber` is NULL for every externally issued document, by rule and by the write path; where
-- it is set it is unique per business. `bookScopeKey` is COALESCE(bookOrgRef,'default') so the unique
-- index can see the historical single tenant, whose bookOrgRef is NULL.
ALTER TABLE `commercialDocuments`
  ADD COLUMN `bookScopeKey` varchar(64) NOT NULL DEFAULT 'default',
  ADD COLUMN `definitionRef` varchar(64) NULL,
  ADD COLUMN `definitionKey` varchar(40) NULL,
  ADD COLUMN `originKind` enum('leaseos_generated','organization_template','customer_template','external_form_rendered','system_rendered','external_scanned','external_digital_import','reference_document') NULL,
  ADD COLUMN `issuerKind` enum('tenant','customer','facility','vendor','regulator','government_authority','manufacturer','other_third_party','unknown') NULL,
  ADD COLUMN `issuerOrgRef` varchar(64) NULL,
  ADD COLUMN `issuerFacilityId` int NULL,
  ADD COLUMN `issuerName` varchar(220) NULL,
  ADD COLUMN `controlNumber` varchar(64) NULL,
  ADD COLUMN `controlNumberIssuedAt` timestamp NULL,
  ADD COLUMN `controlState` enum('captured','needs_classification','proposed','confirmed','issued','void','withdrawn') NOT NULL DEFAULT 'confirmed',
  ADD COLUMN `templateRevisionRef` varchar(64) NULL,
  ADD COLUMN `renderManifestHash` varchar(64) NULL,
  ADD COLUMN `capturedByUserId` int NULL,
  ADD COLUMN `capturedByDeviceRef` varchar(64) NULL,
  ADD COLUMN `importChannel` enum('device_sync','office_upload','portal','api','email','system') NULL,
  ADD COLUMN `confirmedByUserId` int NULL,
  ADD COLUMN `confirmedAt` timestamp NULL,
  ADD COLUMN `issuedByUserId` int NULL,
  ADD COLUMN `voidedByUserId` int NULL,
  ADD COLUMN `voidedAt` timestamp NULL,
  ADD COLUMN `voidReason` varchar(500) NULL;
--> statement-breakpoint
-- Legacy rows: the scope key follows the book, and the definition key is the document type when a
-- platform definition of that key exists. Nothing infers an origin.
UPDATE `commercialDocuments` SET `bookScopeKey` = COALESCE(`bookOrgRef`, 'default');
--> statement-breakpoint
UPDATE `commercialDocuments` d JOIN `documentDefinitions` f ON f.`definitionKey` = d.`documentType` AND f.`scopeKey` = 'platform' AND f.`status` = 'active'
  SET d.`definitionKey` = d.`documentType`, d.`definitionRef` = f.`definitionRef`;
--> statement-breakpoint
CREATE UNIQUE INDEX `commercialDocuments_control_number` ON `commercialDocuments` (`bookScopeKey`,`controlNumber`);
--> statement-breakpoint
CREATE INDEX `commercialDocuments_state` ON `commercialDocuments` (`bookScopeKey`,`controlState`,`originKind`);
--> statement-breakpoint
-- A link carries the id beside the human ref, the role the record plays for the document, and whether
-- a person, the owning domain, or an extraction proposed it. Legacy links were entered by people.
ALTER TABLE `commercialDocumentLinks`
  ADD COLUMN `recordId` int NULL,
  ADD COLUMN `role` varchar(40) NULL,
  ADD COLUMN `source` enum('human','domain','ocr_proposed') NOT NULL DEFAULT 'human',
  ADD COLUMN `confirmationStatus` enum('proposed','confirmed') NOT NULL DEFAULT 'confirmed',
  ADD COLUMN `linkedByDeviceRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `commercialDocumentLinks_record_id` ON `commercialDocumentLinks` (`recordType`,`recordId`);
--> statement-breakpoint
-- Identifiers another issuer assigned, scoped by that issuer: a facility by id, an organization by
-- ref, otherwise the normalised name. Facility A's ticket 12345 and Facility B's ticket 12345 both
-- exist. Within one issuer the write path decides: identical bytes are the same document and are
-- refused; different bytes with the same reference need a person's recorded override. A row that
-- mirrors a column another domain owns (disposalTickets.facilityTicketNumber) says so and is
-- read-only here.
CREATE TABLE `documentExternalReferences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `referenceRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `bookScopeKey` varchar(64) NOT NULL,
  `documentId` int NOT NULL,
  `referenceType` varchar(40) NOT NULL,
  `referenceValue` varchar(120) NOT NULL,
  `referenceValueRaw` varchar(120) NOT NULL,
  `issuerKind` enum('tenant','customer','facility','vendor','regulator','government_authority','manufacturer','other_third_party','unknown') NOT NULL,
  `issuerOrgRef` varchar(64) NULL,
  `issuerFacilityId` int NULL,
  `issuerName` varchar(220) NULL,
  `issuerScopeKey` varchar(160) NOT NULL,
  `source` enum('ocr_proposed','human_entered','portal_submitted','api_imported','domain_mirrored') NOT NULL,
  `confirmationStatus` enum('proposed','confirmed','rejected') NOT NULL DEFAULT 'proposed',
  `confirmedByUserId` int NULL,
  `confirmedAt` timestamp NULL,
  `mirrorOfTable` varchar(40) NULL,
  `mirrorOfId` int NULL,
  `mirrorOfColumn` varchar(40) NULL,
  `duplicateOfDocumentId` int NULL,
  `duplicateOverrideReason` varchar(300) NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentExternalReferences_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentExternalReferences_referenceRef_unique` UNIQUE(`referenceRef`),
  CONSTRAINT `documentExternalReferences_document_issuer_value` UNIQUE(`documentId`,`referenceType`,`issuerScopeKey`,`referenceValue`)
);
--> statement-breakpoint
CREATE INDEX `documentExternalReferences_lookup` ON `documentExternalReferences` (`bookScopeKey`,`referenceType`,`referenceValue`);
--> statement-breakpoint
-- Append-only. The timeline of a controlled document is read from here, in sequence, never inferred
-- from the row's final state. The trigger below refuses an UPDATE or DELETE outright.
CREATE TABLE `documentControlEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentId` int NOT NULL,
  `sequence` int NOT NULL,
  `eventType` varchar(60) NOT NULL,
  `actorUserId` int NULL,
  `actorSource` enum('human','system','ai','integration','external') NOT NULL,
  `deviceRef` varchar(64) NULL,
  `previousState` varchar(40) NULL,
  `newState` varchar(40) NULL,
  `detailJson` text NULL,
  `occurredAt` timestamp NOT NULL,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentControlEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentControlEvents_seq_unique` UNIQUE(`documentId`,`sequence`)
);
--> statement-breakpoint
CREATE TRIGGER `documentControlEvents_append_only_update` BEFORE UPDATE ON `documentControlEvents` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'documentControlEvents is append-only';
--> statement-breakpoint
CREATE TRIGGER `documentControlEvents_append_only_delete` BEFORE DELETE ON `documentControlEvents` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'documentControlEvents is append-only';
