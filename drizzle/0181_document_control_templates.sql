-- 0181 — Document Control, Checkpoint D: template families and immutable released revisions.
--
-- Slot: 0178–0180 are Checkpoints A–C on this branch; 0181 is the next number free on main and on
-- every open branch at the same scan (docs/architecture/MIGRATION_COLLISION_REGISTER.md).
--
-- A template is one way of producing a document under a definition; it is never the record. A
-- family (`documentTemplates`) belongs to a definition and a source — LeaseOS standard, the
-- business's own, a customer's, or an external/regulatory form LeaseOS may fill without owning.
-- A revision (`documentTemplateRevisions`) is what a document is rendered from: its layout hash,
-- its field-mapping hash, the renderer and version, and one release manifest over all of them.
-- A PDF and a DOCX of one form are two artifacts of one revision (`documentTemplateArtifacts`),
-- never two definitions and never two templates.
--
-- RELEASED IS IMMUTABLE. The trigger below refuses any change to a released revision's layout,
-- mapping, renderer or manifest; the only moves left are released → retired and the retirement
-- columns. A changed mapping is a new revision. A record issued under revision 3 stays on
-- revision 3 after revision 4 is released, because nothing about revision 3 can move.
CREATE TABLE `documentTemplates` (
  `id` int AUTO_INCREMENT NOT NULL,
  `templateRef` varchar(40) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `templateKey` varchar(80) NOT NULL,
  `definitionKey` varchar(40) NOT NULL,
  `sourceKind` enum('leaseos_standard','organization_custom','customer_supplied','external_form') NOT NULL,
  `ownerKind` enum('leaseos','tenant','customer','regulator','facility','other_third_party') NOT NULL,
  `ownerOrgRef` varchar(64) NULL,
  `ownerName` varchar(220) NULL,
  `name` varchar(200) NOT NULL,
  `sourcePackageKey` varchar(80) NULL,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `retiredByUserId` int NULL,
  `retiredAt` timestamp NULL,
  CONSTRAINT `documentTemplates_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentTemplates_templateRef_unique` UNIQUE(`templateRef`),
  CONSTRAINT `documentTemplates_scope_key_unique` UNIQUE(`scopeKey`,`templateKey`)
);
--> statement-breakpoint
CREATE INDEX `documentTemplates_definition` ON `documentTemplates` (`definitionKey`,`status`);
--> statement-breakpoint
CREATE TABLE `documentTemplateRevisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `revisionRef` varchar(40) NOT NULL,
  `templateId` int NOT NULL,
  `revision` int NOT NULL,
  `status` enum('draft','released','retired') NOT NULL DEFAULT 'draft',
  `layoutKind` enum('leaseos_layout','markdown_text','pdf_overlay','docx_source','html_layout') NOT NULL,
  `layoutArtifactId` int NULL,
  `layoutStorageKey` varchar(512) NULL,
  `layoutContentHash` varchar(64) NOT NULL,
  `fieldMappingJson` text NOT NULL,
  `fieldMappingHash` varchar(64) NOT NULL,
  `rendererKey` varchar(40) NOT NULL,
  `rendererVersion` varchar(20) NOT NULL,
  `releaseManifestHash` varchar(64) NULL,
  `notes` varchar(500) NULL,
  `supersedesRevisionId` int NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `releasedByUserId` int NULL,
  `releasedAt` timestamp NULL,
  `retiredByUserId` int NULL,
  `retiredAt` timestamp NULL,
  CONSTRAINT `documentTemplateRevisions_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentTemplateRevisions_revisionRef_unique` UNIQUE(`revisionRef`),
  CONSTRAINT `documentTemplateRevisions_template_revision_unique` UNIQUE(`templateId`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `documentTemplateArtifacts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `revisionId` int NOT NULL,
  `artifactId` int NOT NULL,
  `role` enum('printable','printable_alternate','editable_source','render_source','reference') NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentTemplateArtifacts_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentTemplateArtifacts_unique` UNIQUE(`revisionId`,`artifactId`)
);
--> statement-breakpoint
CREATE TRIGGER `documentTemplateRevisions_released_immutable` BEFORE UPDATE ON `documentTemplateRevisions` FOR EACH ROW
BEGIN
  IF OLD.`status` = 'released' THEN
    IF NOT (NEW.`layoutContentHash` <=> OLD.`layoutContentHash`) OR NOT (NEW.`fieldMappingJson` <=> OLD.`fieldMappingJson`) OR NOT (NEW.`fieldMappingHash` <=> OLD.`fieldMappingHash`)
       OR NOT (NEW.`rendererKey` <=> OLD.`rendererKey`) OR NOT (NEW.`rendererVersion` <=> OLD.`rendererVersion`) OR NOT (NEW.`releaseManifestHash` <=> OLD.`releaseManifestHash`)
       OR NOT (NEW.`layoutKind` <=> OLD.`layoutKind`) OR NOT (NEW.`layoutArtifactId` <=> OLD.`layoutArtifactId`) OR NOT (NEW.`layoutStorageKey` <=> OLD.`layoutStorageKey`)
       OR NOT (NEW.`templateId` <=> OLD.`templateId`) OR NOT (NEW.`revision` <=> OLD.`revision`) OR NOT (NEW.`releasedByUserId` <=> OLD.`releasedByUserId`) OR NOT (NEW.`releasedAt` <=> OLD.`releasedAt`)
       OR NEW.`status` NOT IN ('released','retired') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a released template revision is immutable; a change is a new revision';
    END IF;
  END IF;
  IF OLD.`status` = 'retired' AND NOT (NEW.`status` <=> 'retired') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a retired template revision stays retired';
  END IF;
END;
