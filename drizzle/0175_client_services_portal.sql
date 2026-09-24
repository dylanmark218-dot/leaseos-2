-- 0175 — Client services: one-time job tracking links, customer document releases, the open-ticket
-- billing lifecycle on the field ticket, customer actions, and a hash-chained customer audit ledger.
--
-- Slot: main ends at 0174 (C1a). Open-branch claims at this branch's base (2026-09-23): 0172/0173 by
-- claude/training-academy-workforce-q3mdse; 0169/0170 by the driver-portfolio branch; 0170 by the
-- auth-workspace branch. 0175 is the first number no branch holds — docs/architecture/MIGRATION_COLLISION_REGISTER.md.
--
-- Principle: the customer-facing system is a controlled projection of the canonical records. Nothing
-- here copies a job, a load, a ticket line or a document. What is added is (1) the customer's authorized
-- relationship to those records, (2) the commercial lifecycle the field ticket already lived but never
-- stored, and (3) the evidence of what the customer saw and did.

-- (1) A job may name the customer account it is for. `customer` stays as the captured text and
-- `customerOrgRef` stays as the person-linked organization (0134); this is the billing identity the
-- dispatcher assigns so the portal can list the job before any field ticket exists on it.
ALTER TABLE `jobs` ADD COLUMN `customerAccountId` int NULL;
--> statement-breakpoint
CREATE INDEX `jobs_customer_account_idx` ON `jobs` (`customerAccountId`,`status`);
--> statement-breakpoint

-- The account-level default for what an authenticated portal identity may see of a unit's position.
-- `none` by default: raw driver GPS is never exposed unless a person turned it on.
ALTER TABLE `customerAccounts` ADD COLUMN `locationSharing` enum('none','approximate','live') NOT NULL DEFAULT 'none';
--> statement-breakpoint

-- (2) The open-ticket billing lifecycle, stored on the field ticket rather than on a second ticket.
-- The field ticket already accumulates lines and events while work happens, is presented under a
-- snapshot hash, signed (R1), supplemented (R2) and invoiced; what it never carried was an explicit,
-- auditable commercial state, a row version for concurrent line writes, or a customer-visible flag on
-- a line. `billingVersion` is bumped under a row lock on every line write; a writer that names the
-- version it read is refused when it moved. FINALIZED writes a `final` revision (a kind the enum has
-- carried since 0048 and nothing wrote) and freezes the lines; corrections after that are `amendment`
-- revisions, never edits.
ALTER TABLE `fieldTickets`
  ADD COLUMN `billingState` enum('DRAFT','OPEN','AWAITING_CUSTOMER_REVIEW','CUSTOMER_ACCEPTED','DISPUTED','FINALIZED','INVOICED','VOID') NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN `billingVersion` int NOT NULL DEFAULT 1,
  ADD COLUMN `customerPoNumber` varchar(80) NULL,
  ADD COLUMN `finalizedAt` timestamp NULL,
  ADD COLUMN `finalizedByUserId` int NULL,
  ADD COLUMN `finalRevisionId` int NULL,
  ADD COLUMN `voidedAt` timestamp NULL,
  ADD COLUMN `voidedByUserId` int NULL,
  ADD COLUMN `voidReason` varchar(400) NULL;
--> statement-breakpoint
CREATE INDEX `fieldTickets_billing_state_idx` ON `fieldTickets` (`customerAccountId`,`billingState`);
--> statement-breakpoint

-- A line may be internal-only (never projected to a customer), may name the load, disposal ticket,
-- unit or time period it bills, and may amend a frozen line (the amendment is a new row, the original
-- stands). `addedByUserId` is who recorded it.
ALTER TABLE `fieldTicketLines`
  ADD COLUMN `customerVisible` tinyint(1) NOT NULL DEFAULT 1,
  ADD COLUMN `loadId` int NULL,
  ADD COLUMN `disposalTicketId` int NULL,
  ADD COLUMN `unitId` int NULL,
  ADD COLUMN `periodStartAt` timestamp NULL,
  ADD COLUMN `periodEndAt` timestamp NULL,
  ADD COLUMN `addedByUserId` int NULL,
  ADD COLUMN `amendsLineId` int NULL;
--> statement-breakpoint

-- (3) One-time tracking links. The URL carries a random token; only its SHA-256 is stored. `orgRef` is
-- the acting organization of the creator, from the server's scope resolution, never from input, and
-- the resolver re-checks the job against it on every request. Scope is explicit per link; live
-- tracking and documents expire separately.
CREATE TABLE `jobTrackingLinks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `linkRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `jobId` int NOT NULL,
  `customerAccountId` int NULL,
  `tokenHash` varchar(64) NOT NULL,
  `label` varchar(120) NULL,
  `contactKind` enum('customer','consultant','lease_representative','site_supervisor','customer_contact','other') NULL,
  `contactName` varchar(180) NULL,
  `contactEmail` varchar(220) NULL,
  `contactPhone` varchar(60) NULL,
  `externalIdentityId` int NULL,
  `scopeJson` text NOT NULL,
  `locationMode` enum('none','approximate','live') NOT NULL DEFAULT 'none',
  `liveUntilRule` enum('until_completion','hours_after_completion','custom','manual') NOT NULL DEFAULT 'hours_after_completion',
  `liveGraceHours` int NULL,
  `liveExpiresAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `maxAccessCount` int NULL,
  `accessCount` int NOT NULL DEFAULT 0,
  `lastAccessedAt` timestamp NULL,
  `status` enum('active','revoked','disabled','superseded') NOT NULL DEFAULT 'active',
  `revokedAt` timestamp NULL,
  `revokedByUserId` int NULL,
  `revokedReason` varchar(300) NULL,
  `supersededByLinkId` int NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `jobTrackingLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `jobTrackingLinks_ref_unique` UNIQUE(`linkRef`),
  CONSTRAINT `jobTrackingLinks_token_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `jobTrackingLinks_job_idx` ON `jobTrackingLinks` (`jobId`,`status`);
--> statement-breakpoint
CREATE INDEX `jobTrackingLinks_org_idx` ON `jobTrackingLinks` (`orgRef`,`status`);
--> statement-breakpoint

-- Every use of a link, allowed or refused. The client address is stored only as a hash.
CREATE TABLE `jobTrackingLinkAccess` (
  `id` int AUTO_INCREMENT NOT NULL,
  `linkId` int NOT NULL,
  `action` varchar(40) NOT NULL,
  `outcome` enum('allowed','denied') NOT NULL,
  `detail` varchar(300) NULL,
  `ipHash` varchar(64) NULL,
  `userAgent` varchar(200) NULL,
  `at` timestamp NOT NULL,
  CONSTRAINT `jobTrackingLinkAccess_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `jobTrackingLinkAccess_link_idx` ON `jobTrackingLinkAccess` (`linkId`,`at`);
--> statement-breakpoint

-- A release is a pointer into the catalogue the document already lives in, carrying that record's own
-- number. Nothing is copied and no second number is minted. A document not released is not served.
CREATE TABLE `customerDocumentReleases` (
  `id` int AUTO_INCREMENT NOT NULL,
  `releaseRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `jobId` int NOT NULL,
  `customerAccountId` int NULL,
  `sourceType` enum('fieldTicketDocument','evidenceRecord','commercialDocument') NOT NULL,
  `sourceId` int NOT NULL,
  `documentRef` varchar(80) NOT NULL,
  `kind` enum('job_ticket','load_ticket','disposal_ticket','scale_ticket','signed_field_ticket','work_order','service_report','proof_of_delivery','final_invoice','customer_receipt','other') NOT NULL,
  `title` varchar(220) NOT NULL,
  `contentHash` varchar(64) NULL,
  `releasedByUserId` int NOT NULL,
  `releasedAt` timestamp NOT NULL,
  `expiresAt` timestamp NULL,
  `withdrawnAt` timestamp NULL,
  `withdrawnByUserId` int NULL,
  `withdrawReason` varchar(300) NULL,
  `status` enum('released','withdrawn') NOT NULL DEFAULT 'released',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerDocumentReleases_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerDocumentReleases_ref_unique` UNIQUE(`releaseRef`),
  CONSTRAINT `customerDocumentReleases_source_unique` UNIQUE(`sourceType`,`sourceId`)
);
--> statement-breakpoint
CREATE INDEX `customerDocumentReleases_job_idx` ON `customerDocumentReleases` (`jobId`,`status`);
--> statement-breakpoint

-- What a customer did to a ticket: acknowledged, approved, disputed, commented, signed. Append-only.
-- The actor is a tracking link, a portal identity, or an office user recording a paper decision; the
-- snapshot hash is what they were shown. A page visit is never an action.
CREATE TABLE `customerTicketActions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `actionRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `jobId` int NOT NULL,
  `fieldTicketId` int NOT NULL,
  `customerAccountId` int NULL,
  `kind` enum('acknowledge','approve','dispute','comment','sign') NOT NULL,
  `actorKind` enum('tracking_link','portal_identity','internal_user') NOT NULL,
  `trackingLinkId` int NULL,
  `externalIdentityId` int NULL,
  `userId` int NULL,
  `representativeName` varchar(180) NULL,
  `representativeTitle` varchar(120) NULL,
  `customerPoNumber` varchar(80) NULL,
  `comment` text NULL,
  `snapshotHash` varchar(64) NULL,
  `revisionId` int NULL,
  `signatureName` varchar(180) NULL,
  `signaturePayloadHash` varchar(64) NULL,
  `ipHash` varchar(64) NULL,
  `userAgent` varchar(200) NULL,
  `at` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerTicketActions_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerTicketActions_ref_unique` UNIQUE(`actionRef`)
);
--> statement-breakpoint
CREATE INDEX `customerTicketActions_ticket_idx` ON `customerTicketActions` (`fieldTicketId`,`at`);
--> statement-breakpoint

-- The customer audit ledger: append-only, hash-chained per organization in the academyAuditEvents shape.
-- The chain tail is read under a row lock so two concurrent appends cannot fork it.
CREATE TABLE `customerAuditEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `eventType` varchar(80) NOT NULL,
  `jobId` int NULL,
  `fieldTicketId` int NULL,
  `trackingLinkId` int NULL,
  `externalIdentityId` int NULL,
  `actorUserId` int NULL,
  `subjectType` varchar(60) NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `eventJson` text NOT NULL,
  `ipHash` varchar(64) NULL,
  `previousHash` varchar(64) NULL,
  `eventHash` varchar(64) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerAuditEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerAuditEvents_ref_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `customerAuditEvents_org_idx` ON `customerAuditEvents` (`orgRef`,`id`);
--> statement-breakpoint
CREATE INDEX `customerAuditEvents_job_idx` ON `customerAuditEvents` (`jobId`,`occurredAt`);
--> statement-breakpoint

-- Customer-safe alert kinds the tracking and billing chain produces. Kinds only; delivery stays on the
-- existing queue.
ALTER TABLE `externalAlertPreferences` MODIFY COLUMN `eventKind` enum('arrival','work_start','delay','breakdown','incident_notice','load_complete','disposal_complete','signoff_ready','r1_available','r2_available','document_ready','dispute_update','billing_update','job_complete','tracking_link_created','dispatched','en_route','on_location','ticket_ready_for_review','invoice_issued') NOT NULL;
