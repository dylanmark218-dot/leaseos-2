-- 0178 — Document Control, Checkpoint A: the definition registry and the catalog's provenance.
--
-- Slot: main ends at 0174. Claims on open branches at this checkpoint (2026-09-23, scanned with the
-- collision register's command): 0170 (eld, auth-workspace, work-calendar), 0172–0175 (training-academy),
-- 0175–0177 (driver-portfolio ×2). 0178 is the first number no branch holds.
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- A document DEFINITION says how a class of controlled record behaves — whether LeaseOS mints a number
-- for it, whether it may arrive as a scan with no template, who owns the facts it carries, what it may
-- be linked to, how it is represented. It is not the document (that is the 0144 register, extended in
-- 0179) and not the visual template (0181). Every enforced policy is a column. `scopeKey` is
-- COALESCE(orgRef, 'platform'), maintained by the write path, so the unique index can see the
-- platform/tenant split that a NULL orgRef would hide from it.
--
-- `retentionPolicyId` NULL means UNCONFIGURED: retained indefinitely, never disposition-eligible,
-- surfaced as a finding. No default period is applied anywhere; retention is a person's assignment
-- from `retentionPolicies` and nothing here invents a duration.
--
-- The rows inserted below are LeaseOS's own definitions: the ten document kinds 0144 seeded as
-- categories, the received-document kinds the extraction engine already classifies, and the home of
-- anything that arrives unrecognised. They are generated from SYSTEM_DEFINITIONS in
-- server/_core/documentDefinitions.ts; the seeder re-asserts the same rows and a test holds the two
-- in step. The 46-family supplied catalog is imported by the seeder, not by this migration, so a
-- re-run is a no-op rather than a duplicate.
CREATE TABLE `documentDefinitions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `definitionRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `definitionKey` varchar(40) NOT NULL,
  `definitionVersion` int NOT NULL DEFAULT 1,
  `status` enum('draft','active','retired') NOT NULL DEFAULT 'active',
  `supersedesDefinitionId` int NULL,
  `documentClass` enum('operational_form','controlled_credential','financial_commercial','regulated_record','reference_document','incident_evidence','unclassified') NOT NULL,
  `displayName` varchar(200) NOT NULL,
  `description` text NULL,
  `primaryDomainOwner` varchar(40) NOT NULL,
  `allowedOriginsJson` text NOT NULL,
  `numberingPolicy` enum('leaseos_series','leaseos_series_optional','domain_managed','external_only','archival_only') NOT NULL,
  `numberSeriesType` varchar(24) NULL,
  `externalReferencePolicy` enum('forbidden','optional','required') NOT NULL DEFAULT 'optional',
  `allowedExternalReferenceTypesJson` text NOT NULL,
  `leaseosTemplateAvailable` boolean NOT NULL DEFAULT false,
  `customTemplateAllowed` boolean NOT NULL DEFAULT true,
  `importAllowed` boolean NOT NULL DEFAULT true,
  `requiredFieldsJson` text NOT NULL,
  `optionalFieldsJson` text NOT NULL,
  `allowedLinkKindsJson` text NOT NULL,
  `signaturePolicy` enum('none','optional','required_single','required_multi','domain_managed') NOT NULL DEFAULT 'optional',
  `revisionPolicy` enum('immutable_supersede','amend_with_reason','domain_managed','reference_versioned') NOT NULL DEFAULT 'immutable_supersede',
  `printPolicy` enum('not_printable','printable','controlled_copy') NOT NULL DEFAULT 'printable',
  `extractionProfileKey` varchar(40) NULL,
  `retentionPolicyId` int NULL,
  `workflowKey` varchar(40) NULL,
  `readCategory` varchar(40) NOT NULL,
  `sensitivityTier` enum('INTERNAL','CONFIDENTIAL','RESTRICTED','HIGHLY_RESTRICTED') NOT NULL DEFAULT 'INTERNAL',
  `jurisdictionsJson` text NOT NULL,
  `jurisdictionPolicy` enum('universal','configurable_verify_by_jurisdiction') NOT NULL DEFAULT 'universal',
  `regulatoryBasis` enum('not_inferred_from_template','verified_source_cited') NOT NULL DEFAULT 'not_inferred_from_template',
  `representationPolicy` enum('internal_record','official_external_record','attach_official_record_required') NOT NULL DEFAULT 'internal_record',
  `representationNotice` varchar(300) NULL,
  `industriesJson` text NOT NULL,
  `packKey` varchar(24) NULL,
  `sourcePackageKey` varchar(80) NULL,
  `source` varchar(160) NOT NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `activatedAt` timestamp NULL,
  `retiredAt` timestamp NULL,
  `retiredByUserId` int NULL,
  CONSTRAINT `documentDefinitions_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentDefinitions_definitionRef_unique` UNIQUE(`definitionRef`),
  CONSTRAINT `documentDefinitions_scope_key_version` UNIQUE(`scopeKey`,`definitionKey`,`definitionVersion`)
);
--> statement-breakpoint
CREATE INDEX `documentDefinitions_key_status` ON `documentDefinitions` (`definitionKey`,`status`);
--> statement-breakpoint
-- Every artifact the supplied catalog carried, by SHA-256: where it came from, what it is for, and the
-- family it belongs to. A PDF and a DOCX of one form are two artifacts of one family, never two
-- definitions. The bytes live under data/document-control/ (repositoryPath) and the seeder recomputes
-- the hash from there before it marks the row verified.
CREATE TABLE `documentSourceArtifacts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `artifactRef` varchar(40) NOT NULL,
  `sha256` varchar(64) NOT NULL,
  `sourceCollection` varchar(120) NOT NULL,
  `sourcePath` varchar(512) NOT NULL,
  `fileName` varchar(220) NOT NULL,
  `extension` varchar(10) NOT NULL,
  `byteLength` int NOT NULL,
  `role` enum('printable_template','editable_template_source','render_template_source','engine_definition_or_reference','reference') NOT NULL,
  `titleCandidate` varchar(220) NULL,
  `templateCodeDetected` varchar(40) NULL,
  `revisionDetected` varchar(20) NULL,
  `pages` int NULL,
  `definitionKey` varchar(40) NULL,
  `sourcePackageKey` varchar(80) NULL,
  `variantNo` int NULL,
  `repositoryPath` varchar(512) NULL,
  `storageKey` varchar(512) NULL,
  `hashVerifiedAt` timestamp NULL,
  `importBatchRef` varchar(40) NOT NULL,
  `importedByUserId` int NULL,
  `importedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentSourceArtifacts_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentSourceArtifacts_artifactRef_unique` UNIQUE(`artifactRef`),
  CONSTRAINT `documentSourceArtifacts_sha256_unique` UNIQUE(`sha256`)
);
--> statement-breakpoint
CREATE INDEX `documentSourceArtifacts_family` ON `documentSourceArtifacts` (`definitionKey`,`variantNo`);
--> statement-breakpoint
INSERT INTO `documentDefinitions` (`definitionRef`,`scopeKey`,`definitionKey`,`documentClass`,`displayName`,`description`,`primaryDomainOwner`,`allowedOriginsJson`,`numberingPolicy`,`numberSeriesType`,`externalReferencePolicy`,`allowedExternalReferenceTypesJson`,`leaseosTemplateAvailable`,`customTemplateAllowed`,`importAllowed`,`requiredFieldsJson`,`optionalFieldsJson`,`allowedLinkKindsJson`,`signaturePolicy`,`revisionPolicy`,`printPolicy`,`extractionProfileKey`,`readCategory`,`sensitivityTier`,`jurisdictionsJson`,`jurisdictionPolicy`,`regulatoryBasis`,`representationPolicy`,`representationNotice`,`industriesJson`,`packKey`,`sourcePackageKey`,`source`,`activatedAt`) VALUES
  ('DEF-P-invoice-v1','platform','invoice','financial_commercial','Invoice','The tenant''s invoice to a customer, rendered from the frozen billing snapshot. Numbered by invoicing.','billing','["system_rendered","leaseos_generated","organization_template"]','domain_managed','INV','optional','["customer_po","afe","customer_job_number"]',false,true,false,'[]','[]','["job","invoice","customer","customer_account","billing_book","field_ticket","load","disposal_ticket"]','domain_managed','domain_managed','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-credit_note-v1','platform','credit_note','financial_commercial','Credit note',NULL,'billing','["system_rendered","leaseos_generated"]','domain_managed','CR','optional','["customer_po"]',false,true,false,'[]','[]','["invoice","customer","customer_account","job"]','domain_managed','domain_managed','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-statement-v1','platform','statement','financial_commercial','Statement of account',NULL,'billing','["system_rendered"]','archival_only',NULL,'forbidden','[]',false,true,false,'[]','[]','["customer","customer_account","financial_entity"]','none','immutable_supersede','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-manifest-v1','platform','manifest','regulated_record','Manifest / chain of custody','The custody record. Sealed by departure; changed only by a two-person amendment.','custody','["leaseos_generated","organization_template","customer_template","external_form_rendered","system_rendered","external_scanned","external_digital_import"]','domain_managed','MRO','optional','["manifest_number","regulatory_identifier","generator_id","transporter_id"]',false,true,true,'[]','[]','["job","trip","load","manifest","unit","operator","facility","customer"]','domain_managed','domain_managed','controlled_copy',NULL,'job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-field_ticket-v1','platform','field_ticket','operational_form','Field ticket','The customer-signed service record. Revisions are frozen snapshots owned by closeout.','closeout','["system_rendered","leaseos_generated","organization_template","customer_template","external_scanned"]','domain_managed','FT','optional','["customer_po","afe","customer_job_number"]',false,true,true,'[]','[]','["job","trip","load","field_ticket","unit","operator","customer","customer_account","billing_book","invoice"]','domain_managed','domain_managed','printable',NULL,'job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-disposal_ticket-v1','platform','disposal_ticket','operational_form','Disposal / facility ticket','LeaseOS''s record of a disposal. The facility''s own paper is a separate external_disposal_receipt linked to it.','disposal','["leaseos_generated","organization_template","customer_template","external_form_rendered","system_rendered","external_scanned","external_digital_import"]','domain_managed','DSP','optional','["facility_ticket_number","scale_ticket_number","manifest_number"]',false,true,true,'[]','[]','["job","trip","load","disposal_ticket","manifest","unit","operator","facility","customer","billing_book"]','optional','domain_managed','printable','disposal_ticket','job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-vendor_bill-v1','platform','vendor_bill','financial_commercial','Vendor bill','A supplier''s invoice to the tenant. The supplier''s number is the number.','billing','["external_scanned","external_digital_import"]','external_only',NULL,'required','["supplier_invoice_number","customer_po"]',false,true,true,'[]','[]','["vendor","organization","financial_entity","work_order","purchase_order","unit","job"]','none','immutable_supersede','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-purchase_order-v1','platform','purchase_order','financial_commercial','Purchase order',NULL,'billing','["system_rendered","leaseos_generated","organization_template"]','domain_managed','PO','optional','["other"]',false,true,false,'[]','[]','["vendor","organization","financial_entity","unit","job","purchase_order"]','optional','immutable_supersede','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-remittance-v1','platform','remittance','financial_commercial','Remittance advice',NULL,'billing','["system_rendered","external_digital_import","external_scanned"]','archival_only',NULL,'optional','["other"]',false,true,true,'[]','[]','["customer","customer_account","invoice","vendor","financial_entity"]','none','immutable_supersede','printable',NULL,'commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-audit_package-v1','platform','audit_package','reference_document','Audit package','A released package asserts nothing new; it names and hashes what the chain holds.','document_control','["system_rendered"]','archival_only',NULL,'forbidden','[]',false,true,false,'[]','[]','["job","unit","operator","customer","incident","vendor","financial_entity"]','none','immutable_supersede','controlled_copy',NULL,'legal','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-external_disposal_receipt-v1','platform','external_disposal_receipt','operational_form','External disposal receipt (facility-issued)','The facility''s own ticket, as handed to the driver. Its number is the facility''s; LeaseOS never mints one for it.','disposal','["external_scanned","external_digital_import"]','external_only',NULL,'required','["facility_ticket_number","scale_ticket_number","manifest_number"]',false,true,true,'[]','[]','["job","trip","load","disposal_ticket","manifest","unit","operator","facility"]','none','amend_with_reason','printable','disposal_ticket','job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-scale_ticket-v1','platform','scale_ticket','operational_form','Scale ticket (externally issued)',NULL,'disposal','["external_scanned","external_digital_import"]','external_only',NULL,'required','["scale_ticket_number","facility_ticket_number"]',false,true,true,'[]','[]','["job","trip","load","disposal_ticket","unit","operator","facility"]','none','amend_with_reason','printable','disposal_ticket','job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-fuel_receipt-v1','platform','fuel_receipt','financial_commercial','Fuel receipt','A vendor''s slip. The fuel transaction it evidences is the fact; the receipt is not a deduction.','expense','["external_scanned","external_digital_import"]','archival_only',NULL,'optional','["receipt_number"]',false,true,true,'[]','[]','["fuel_transaction","expense_record","unit","operator","trip","job","financial_entity"]','none','immutable_supersede','printable','fuel_receipt','commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-expense_receipt-v1','platform','expense_receipt','financial_commercial','Expense receipt',NULL,'expense','["external_scanned","external_digital_import"]','archival_only',NULL,'optional','["receipt_number"]',false,true,true,'[]','[]','["expense_record","operator","user","trip","job","financial_entity"]','none','immutable_supersede','printable','expense_receipt','commercial','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now()),
  ('DEF-P-unclassified_external_document-v1','platform','unclassified_external_document','unclassified','Unclassified external document','Where a scan or upload lives until a person says what it is. Never dropped for failing to match a template.','document_control','["external_scanned","external_digital_import"]','archival_only',NULL,'optional','["other"]',false,true,true,'[]','[]','["job","trip","load","unit","operator","facility","customer"]','none','immutable_supersede','printable',NULL,'job_operational','INTERNAL','["*"]','universal','not_inferred_from_template','internal_record',NULL,'[]','core',NULL,'leaseos_system_definition (0178)',now());
--> statement-breakpoint
-- The received-document kinds and the unclassified home become document types in the 0144 register's
-- category catalog, so `commercialOffice.documents.register` accepts them without a second validation path.
INSERT INTO `commercialCategoryTypes` (`bookOrgRef`,`kind`,`categoryKey`,`label`,`builtIn`,`source`) VALUES
  (NULL,'document_type','external_disposal_receipt','External disposal receipt (facility-issued)',true,'leaseos_system_definition (0178)'),
  (NULL,'document_type','scale_ticket','Scale ticket (externally issued)',true,'leaseos_system_definition (0178)'),
  (NULL,'document_type','fuel_receipt','Fuel receipt',true,'leaseos_system_definition (0178)'),
  (NULL,'document_type','expense_receipt','Expense receipt',true,'leaseos_system_definition (0178)'),
  (NULL,'document_type','unclassified_external_document','Unclassified external document',true,'leaseos_system_definition (0178)');
