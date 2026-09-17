-- v22.38 — 0144 (P7.7): the commercial document registry, over the records vault.
--
-- A commercial document — invoice, credit note, statement, manifest, field ticket, disposal
-- ticket, vendor bill, purchase order, remittance, audit package — is registered once with its
-- content hash and a pointer to where the bytes live (an evidence record in the vault, a
-- generated field-ticket document, or a storage key). Its content is never rewritten: a change
-- is a new version that supersedes the old row, with a reason; a withdrawal keeps the row and
-- says why. One document links to many records (the invoice, the job, the trip, the load, the
-- organization); deliveries are logged with what was sent to whom and what came back; the
-- retention class is a person's assignment from retentionPolicies, and unknown until then.

CREATE TABLE `commercialDocuments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `documentType` varchar(40) NOT NULL,
  `title` varchar(300) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `supersedesDocumentId` int NULL,
  `supersededByDocumentId` int NULL,
  `contentHash` char(64) NOT NULL,
  `sourceSnapshotHash` char(64) NULL,
  `byteLength` int NULL,
  `mimeType` varchar(120) NULL,
  `evidenceRecordId` int NULL,
  `fieldTicketDocumentId` int NULL,
  `storageKey` varchar(512) NULL,
  `counterpartyOrgRef` varchar(64) NULL,
  `issuedAt` timestamp NULL,
  `retentionPolicyId` int NULL,
  `retentionClass` varchar(80) NULL,
  `retentionAssignedByUserId` int NULL,
  `status` enum('current','superseded','withdrawn') NOT NULL DEFAULT 'current',
  `statusReason` varchar(500) NULL,
  `registeredByUserId` int NOT NULL,
  `registeredAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialDocuments_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialDocuments_ref` UNIQUE(`documentRef`)
);
--> statement-breakpoint
CREATE INDEX `commercialDocuments_hash` ON `commercialDocuments` (`contentHash`);
--> statement-breakpoint
CREATE INDEX `commercialDocuments_type` ON `commercialDocuments` (`bookOrgRef`,`documentType`,`status`);
--> statement-breakpoint
CREATE TABLE `commercialDocumentLinks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentId` int NOT NULL,
  `recordType` varchar(40) NOT NULL,
  `recordRef` varchar(80) NOT NULL,
  `linkedByUserId` int NOT NULL,
  `linkedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialDocumentLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialDocumentLinks_key` UNIQUE(`documentId`,`recordType`,`recordRef`)
);
--> statement-breakpoint
CREATE INDEX `commercialDocumentLinks_record` ON `commercialDocumentLinks` (`recordType`,`recordRef`);
--> statement-breakpoint
CREATE TABLE `commercialDocumentDeliveries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deliveryRef` varchar(40) NOT NULL,
  `documentId` int NOT NULL,
  `channel` enum('email','portal','print','api','courier','other') NOT NULL,
  `recipientOrgRef` varchar(64) NULL,
  `recipientAddress` varchar(300) NULL,
  `status` enum('queued','sent','delivered','failed','bounced','acknowledged') NOT NULL DEFAULT 'queued',
  `sentAt` timestamp NULL,
  `sentByUserId` int NULL,
  `deliveredAt` timestamp NULL,
  `deliveryEvidence` varchar(300) NULL,
  `failureReason` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialDocumentDeliveries_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialDocumentDeliveries_ref` UNIQUE(`deliveryRef`)
);
--> statement-breakpoint
CREATE INDEX `commercialDocumentDeliveries_document` ON `commercialDocumentDeliveries` (`documentId`,`status`);
--> statement-breakpoint
-- The canonical document kinds LeaseOS itself produces or receives, as built-in types; a business adds its own.
INSERT INTO `commercialCategoryTypes` (`bookOrgRef`,`kind`,`categoryKey`,`label`,`builtIn`,`source`) VALUES
  (NULL,'document_type','invoice','Invoice',true,'leaseos_canonical_document'),
  (NULL,'document_type','credit_note','Credit note',true,'leaseos_canonical_document'),
  (NULL,'document_type','statement','Statement of account',true,'leaseos_canonical_document'),
  (NULL,'document_type','manifest','Manifest / chain of custody',true,'leaseos_canonical_document'),
  (NULL,'document_type','field_ticket','Field ticket',true,'leaseos_canonical_document'),
  (NULL,'document_type','disposal_ticket','Disposal / facility ticket',true,'leaseos_canonical_document'),
  (NULL,'document_type','vendor_bill','Vendor bill',true,'leaseos_canonical_document'),
  (NULL,'document_type','purchase_order','Purchase order',true,'leaseos_canonical_document'),
  (NULL,'document_type','remittance','Remittance advice',true,'leaseos_canonical_document'),
  (NULL,'document_type','audit_package','Audit package',true,'leaseos_canonical_document');
