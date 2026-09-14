-- v22.20 — 0082: the roadside stop, as records.
--
-- Six tables, not forty. Work orders, defects, evidence, workflow notifications
-- and the domain event outbox already exist; this adds only what enforcement is
-- the source of truth for, and leans on the rest.
--
-- Two shapes here carry invariants the engine already proved.
--
-- `enforcementDocumentExtractions` is separate from `enforcementEvents` because
-- a scan is a proposal. An extraction can exist for hours with nothing else in
-- the system changing, and the office can be told a document was scanned
-- without anything having been decided.
--
-- `oosReleaseFindings` is a table rather than a boolean on the order. Whether
-- an order's own release condition is satisfied is a finding by a person, with
-- evidence and a role, and it is recorded even when the answer is "unknown" or
-- "not satisfied" — so "nobody has looked" and "somebody looked and said no"
-- stay different states, as they do everywhere else in this system.
--
-- There is no DELETE path for any of these in normal workflow. An order that
-- turned out not to apply is rescinded with a reason.

CREATE TABLE `enforcementDocumentExtractions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `extractionRef` varchar(64) NOT NULL,
  `documentKind` varchar(60) NOT NULL,
  `evidenceRecordId` int,
  `capturedByUserId` int NOT NULL,
  `capturedAt` timestamp NOT NULL,
  `latitude` double,
  `longitude` double,
  `fieldsJson` text NOT NULL,
  `extractedCount` int NOT NULL DEFAULT 0,
  `highlightedJson` text,
  `missingRequiredJson` text,
  -- Always true on insert. There is no writer that sets it false.
  `requiresConfirmation` boolean NOT NULL DEFAULT true,
  `status` enum('proposed','confirmed','discarded') NOT NULL DEFAULT 'proposed',
  `confirmedEventRef` varchar(64),
  `discardedReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `enforcementDocumentExtractions_id` PRIMARY KEY(`id`),
  CONSTRAINT `enforcementDocumentExtractions_ref_unique` UNIQUE(`extractionRef`)
);
--> statement-breakpoint

CREATE TABLE `enforcementEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `eventType` varchar(60) NOT NULL,
  `jurisdiction` varchar(40) NOT NULL,
  `agency` varchar(200) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `locationText` varchar(300),
  `latitude` double,
  `longitude` double,
  -- Separate identifiers on separate documents. Conflating them makes a later
  -- challenge impossible to file.
  `inspectionReportNumber` varchar(120),
  `inspectionLevel` varchar(20),
  `inspectionResult` enum('pass','requires_attention','out_of_service','unknown') NOT NULL DEFAULT 'unknown',
  `operatorId` int,
  `unitId` int,
  `trailerId` int,
  `jobId` int,
  `tripId` int,
  `extractionRef` varchar(64),
  `evidenceRecordId` int,
  `status` enum('confirmed','under_review','resolved','rescinded') NOT NULL DEFAULT 'confirmed',
  `confirmedByUserId` int NOT NULL,
  `confirmedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `enforcementEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `enforcementEvents_ref_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `enforcementEvents_subjects` ON `enforcementEvents` (`unitId`, `operatorId`, `occurredAt`);
--> statement-breakpoint

CREATE TABLE `enforcementViolations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `violationRef` varchar(64) NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `system` varchar(60) NOT NULL,
  -- LeaseOS's own identifier. There is deliberately no column for the wording
  -- of any separately licensed criteria this may reference.
  `ownCode` varchar(120) NOT NULL,
  `sourceReference` varchar(400),
  `description` varchar(1000),
  `citationIssued` boolean NOT NULL DEFAULT false,
  `outOfService` boolean NOT NULL DEFAULT false,
  `oosScope` enum('driver','vehicle','trailer','cargo','carrier'),
  `defectRequired` boolean NOT NULL DEFAULT false,
  `repairRequired` boolean NOT NULL DEFAULT false,
  `courtAction` boolean NOT NULL DEFAULT false,
  `defectId` int,
  `workOrderId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `enforcementViolations_id` PRIMARY KEY(`id`),
  CONSTRAINT `enforcementViolations_ref_unique` UNIQUE(`violationRef`)
);
--> statement-breakpoint
CREATE INDEX `enforcementViolations_event` ON `enforcementViolations` (`eventRef`);
--> statement-breakpoint

CREATE TABLE `enforcementCitations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `citationRef` varchar(64) NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `violationRef` varchar(64),
  `citationNumber` varchar(120),
  `offenceDescription` varchar(600),
  `fineAmountCents` int,
  `responseDueAt` timestamp NULL,
  `courtAt` timestamp NULL,
  -- A scanned allegation is not a conviction, and this enum will not let one
  -- become one without somebody recording the disposition.
  `status` enum('scanned','open','review_required','payable','disputed','court_pending','paid','withdrawn','dismissed','convicted','reduced','appealed','closed') NOT NULL DEFAULT 'scanned',
  `disposition` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `enforcementCitations_id` PRIMARY KEY(`id`),
  CONSTRAINT `enforcementCitations_ref_unique` UNIQUE(`citationRef`)
);
--> statement-breakpoint

CREATE TABLE `outOfServiceOrders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orderRef` varchar(64) NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `violationRef` varchar(64),
  `scope` enum('driver','vehicle','trailer','cargo','carrier') NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `issuedAt` timestamp NOT NULL,
  `issuingAgency` varchar(200),
  `releaseCondition` varchar(600) NOT NULL,
  `status` enum('active','released','rescinded') NOT NULL DEFAULT 'active',
  `releasedAt` timestamp NULL,
  `releasedByUserId` int,
  `releaseEvidenceRef` varchar(64),
  `rescindedAt` timestamp NULL,
  `rescindedByUserId` int,
  `rescissionReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `outOfServiceOrders_id` PRIMARY KEY(`id`),
  CONSTRAINT `outOfServiceOrders_ref_unique` UNIQUE(`orderRef`)
);
--> statement-breakpoint
CREATE INDEX `outOfServiceOrders_subject` ON `outOfServiceOrders` (`subjectRef`, `scope`, `status`);
--> statement-breakpoint

CREATE TABLE `oosReleaseFindings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `findingRef` varchar(64) NOT NULL,
  `orderRef` varchar(64) NOT NULL,
  `finding` enum('satisfied','not_satisfied','unknown') NOT NULL,
  `findingType` enum('repair_verification','reinspection','inspector_release','document_confirmation','waiting_period_complete','other') NOT NULL,
  `evidenceRef` varchar(64),
  `notes` varchar(1000),
  `recordedByUserId` int NOT NULL,
  `recordedByRole` varchar(60) NOT NULL,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `oosReleaseFindings_id` PRIMARY KEY(`id`),
  CONSTRAINT `oosReleaseFindings_ref_unique` UNIQUE(`findingRef`)
);
--> statement-breakpoint
CREATE INDEX `oosReleaseFindings_order` ON `oosReleaseFindings` (`orderRef`, `recordedAt`);
