-- 0182 — Document Control, Checkpoint F: scanner and import convergence.
--
-- Slot: 0178–0181 are Checkpoints A–D on this branch; 0182 is the next number free on main and on
-- every open branch at the same scan (docs/architecture/MIGRATION_COLLISION_REGISTER.md).
--
-- A scan or an import enters the register with no template and no known form: the server hashes
-- the bytes it received, stores them once as the evidence record, and registers the row at
-- `captured`. Whatever is later derived from those bytes — the OCR text, a page image, a
-- thumbnail, a redaction — is a DERIVATIVE: its own row, its own bytes, its own hash, and the hash
-- of the original it was derived from. A derivative never overwrites anything and is never
-- overwritten; a captured document's bytes never change (a corrected scan is a new document).
--
-- An OCR extraction is a PROPOSAL. `documentExtractions` (0027) already records one and the
-- assistant's proposal tables already hold its fields and questions; the column below ties an
-- extraction to the register row it was read from, so the row can show what was proposed and a
-- person can confirm it — or not. Nothing extracted becomes a fact of the row without that act.
ALTER TABLE `documentExtractions` ADD COLUMN `documentId` int NULL;
--> statement-breakpoint
ALTER TABLE `documentExtractions` ADD INDEX `documentExtractions_document` (`documentId`);
--> statement-breakpoint
CREATE TABLE `documentDerivatives` (
  `id` int AUTO_INCREMENT NOT NULL,
  `derivativeRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `bookScopeKey` varchar(64) NOT NULL,
  `documentId` int NOT NULL,
  `evidenceRecordId` int NULL,
  `sourceContentHash` varchar(64) NOT NULL,
  `derivativeKind` enum('ocr_text','extraction_json','page_image','thumbnail','searchable_pdf','redaction','other') NOT NULL,
  `producer` varchar(80) NOT NULL,
  `producerVersion` varchar(40) NULL,
  `extractionRef` varchar(64) NULL,
  `storageKey` varchar(512) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `mimeType` varchar(120) NOT NULL,
  `byteLength` int NOT NULL,
  `createdByUserId` int NULL,
  `actorSource` enum('human','system','ai','integration','external') NOT NULL DEFAULT 'system',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `documentDerivatives_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentDerivatives_ref_unique` UNIQUE(`derivativeRef`),
  CONSTRAINT `documentDerivatives_content_unique` UNIQUE(`documentId`,`derivativeKind`,`contentHash`)
);
--> statement-breakpoint
CREATE INDEX `documentDerivatives_document` ON `documentDerivatives` (`documentId`);
--> statement-breakpoint
CREATE INDEX `documentDerivatives_source` ON `documentDerivatives` (`bookScopeKey`,`sourceContentHash`);
--> statement-breakpoint
CREATE TRIGGER `documentDerivatives_never_overwritten` BEFORE UPDATE ON `documentDerivatives` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a derivative is never overwritten; a new derivation is a new row';
--> statement-breakpoint
CREATE TRIGGER `commercialDocuments_original_immutable` BEFORE UPDATE ON `commercialDocuments` FOR EACH ROW
BEGIN
  IF OLD.`evidenceRecordId` IS NOT NULL AND (NOT (NEW.`contentHash` <=> OLD.`contentHash`) OR NOT (NEW.`evidenceRecordId` <=> OLD.`evidenceRecordId`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the bytes a captured document was registered with never change; a corrected scan is a new document';
  END IF;
END;
