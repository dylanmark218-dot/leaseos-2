-- v22.24 — 0131 (P4.6, realizes the project-knowledge draft "0016 security
-- incidents + privacy breach assessments" in the tree's conventions).
--
-- A rollover and a cross-tenant data exposure are different incident domains
-- with different investigators, evidence and notification obligations, so this
-- does NOT merge into incidentReports. The technical incident, its append-only
-- timeline, the organizations it touched, the privacy conclusion, and the
-- notification obligations are five rows, not one.
--
-- The privacy conclusion is a person's. `notificationDecision` starts pending,
-- `uncertain` is a valid answer, and no code path moves it. Statutory clocks
-- (Alberta PIPA "without unreasonable delay", PIPEDA "as soon as feasible") are
-- not encoded as numbers here — an obligation records the basis a person cited
-- and the due date a person set, and the exception centre surfaces what is
-- required and unsent.

CREATE TABLE `securityIncidents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `incidentRef` varchar(64) NOT NULL,
  `incidentType` enum('account_compromise','unauthorized_access','data_exposure','malware','ransomware','credential_exposure','cross_tenant_access','lost_device','vendor_incident','availability','integrity','privacy','other') NOT NULL,
  `severity` enum('low','moderate','high','critical') NOT NULL DEFAULT 'moderate',
  `status` enum('open','triaging','contained','investigating','recovering','monitoring','closed') NOT NULL DEFAULT 'open',
  `title` varchar(220) NOT NULL,
  `summary` text NULL,
  `discoveredAt` timestamp NOT NULL,
  `occurredFrom` timestamp NULL,
  `occurredTo` timestamp NULL,
  `discoveredByUserId` int NOT NULL,
  `incidentOwnerUserId` int NULL,
  `personalInformationSuspected` boolean NOT NULL DEFAULT false,
  `customerDataSuspected` boolean NOT NULL DEFAULT false,
  `containedAt` timestamp NULL,
  `closedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `securityIncidents_id` PRIMARY KEY(`id`),
  CONSTRAINT `securityIncidents_ref_unique` UNIQUE(`incidentRef`)
);
--> statement-breakpoint
CREATE INDEX `securityIncidents_org_idx` ON `securityIncidents` (`orgRef`,`status`);
--> statement-breakpoint
CREATE TABLE `securityIncidentEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `securityIncidentId` int NOT NULL,
  `sequence` int NOT NULL,
  `eventType` enum('discovered','triage','evidence_added','contained','scope_changed','customer_identified','privacy_assessment','notification_decision','notification_sent','recovery','closed','reopened') NOT NULL,
  `actorUserId` int NOT NULL,
  `detail` text NULL,
  `evidenceRecordId` int NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `securityIncidentEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `securityIncidentEvents_seq_unique` UNIQUE(`securityIncidentId`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `securityIncidentOrganizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `securityIncidentId` int NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `affectedStatus` enum('suspected','confirmed','ruled_out') NOT NULL DEFAULT 'suspected',
  `dataCategoriesJson` text NULL,
  `identifiedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `securityIncidentOrganizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `securityIncidentOrganizations_unique` UNIQUE(`securityIncidentId`,`orgRef`)
);
--> statement-breakpoint
CREATE TABLE `privacyBreachAssessments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `securityIncidentId` int NOT NULL,
  `assessmentNo` int NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  `applicableLaw` varchar(180) NULL,
  `status` enum('draft','in_review','complete','superseded') NOT NULL DEFAULT 'draft',
  `sensitivity` enum('low','moderate','high','very_high','unknown') NOT NULL DEFAULT 'unknown',
  `misuseLikelihood` enum('low','moderate','high','unknown') NOT NULL DEFAULT 'unknown',
  `harmAssessmentJson` text NULL,
  `notificationDecision` enum('pending','not_required','required','uncertain') NOT NULL DEFAULT 'pending',
  `decisionReason` text NULL,
  `assessedByUserId` int NULL,
  `assessedAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `privacyBreachAssessments_id` PRIMARY KEY(`id`),
  CONSTRAINT `privacyBreachAssessments_no_unique` UNIQUE(`securityIncidentId`,`assessmentNo`)
);
--> statement-breakpoint
CREATE TABLE `incidentNotificationObligations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `securityIncidentId` int NOT NULL,
  `assessmentId` int NULL,
  `recipientType` enum('commissioner','individuals','customer_organization','law_enforcement','insurer','vendor','other') NOT NULL,
  `recipientRef` varchar(220) NULL,
  `basis` varchar(300) NOT NULL,
  `dueAt` timestamp NULL,
  `state` enum('required','sent','not_required','withdrawn') NOT NULL DEFAULT 'required',
  `sentAt` timestamp NULL,
  `sentByUserId` int NULL,
  `evidenceRecordId` int NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `incidentNotificationObligations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `incidentNotificationObligations_open_idx` ON `incidentNotificationObligations` (`state`,`dueAt`);
