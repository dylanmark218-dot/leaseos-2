-- 0214 — Sign & Attest, SA1: a signature is of a hash, and the hash has a home.
--
-- Slot: main ends at 0209. Every remote branch sharing history with main was scanned on 2026-10-01
-- with the register's command: 0182–0188, 0197, 0199–0201, 0205–0206 and 0210–0213 are held by open
-- branches (docs/architecture/MIGRATION_COLLISION_REGISTER.md, "State at the Sign & Attest SA1 claim").
-- 0214 is the first number no branch holds; 0215 and 0216 follow it on this branch.
--
-- What this fixes. `fieldTicketSignatures.signatureMethod = 'drawn'` stored no drawing: the write path
-- (closeoutRouter.recordSignature) set `signatureStorageKey` only for `paper_scan`, so a "drawn"
-- signature was a method, a hash and a name — the same label problem 0157 fixed one layer down and
-- 0158 one layer up. Three other stores (academy certificates, consents, approvals) each kept their own
-- idea of a signature with their own hash scheme.
--
-- The model (docs/sign-attest/SIGN_ATTEST_DESIGN.md §3). `attestDocumentRevisions` names ONE document
-- revision — a field-ticket revision, a sealed evidence record, a register row — and fixes its
-- fingerprint, recomputed by the server from the subject and never taken from input. Fields are placed
-- on that revision; signers are assigned to fields; a session is one act of signing by one signer and
-- carries the authentication that proved who they were; a mark is what they made, bound by a payload
-- hash to the revision hash whatever the method; an artifact is what finalization produced. Events
-- are 0215; the guards that make "finalized" and "append-only" the database's words are 0216.
--
-- Tenancy: `orgRef` NULL = the historical single tenant (0132). `orgScopeKey` = COALESCE(orgRef,'default'),
-- written by the service so the unique index on (scope, instance, revision) can see the split a NULL
-- would hide (the 0178/0179 pattern). `finalizedKey` is a PERSISTENT generated column — the instance
-- key while state = 'finalized', NULL otherwise — so two finalized revisions of one instance collide in
-- the database rather than in a read-then-write check (the 0021 `activeGrantKey` precedent).
--
-- No biometric material is stored anywhere here. Strokes are coordinates for rendering, sealed in the
-- evidence vault and referenced by id; the platform biometric unlocks a device key and never travels.

CREATE TABLE `attestDocumentRevisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`revisionRef` varchar(64) NOT NULL,
	`orgRef` varchar(64),
	`orgScopeKey` varchar(64) NOT NULL DEFAULT 'default',
	`instanceRef` varchar(120) NOT NULL,
	`revision` int NOT NULL,
	`subjectType` varchar(40) NOT NULL,
	`subjectRef` varchar(120) NOT NULL,
	`subjectId` int,
	`revisionHash` varchar(64) NOT NULL,
	`pageCount` int NOT NULL DEFAULT 1,
	`pageGeometryJson` text,
	`state` enum('open','completed','finalized','voided','superseded') NOT NULL DEFAULT 'open',
	`completionRule` varchar(40) NOT NULL DEFAULT 'all_required_fields',
	`finalizedAt` timestamp NULL,
	`finalizedByUserId` int,
	`artifactId` int,
	`receiptHash` varchar(64),
	`eventChainHead` varchar(64),
	`finalizedKey` varchar(200) AS (CASE WHEN `state` = 'finalized' THEN CONCAT(`orgScopeKey`, '|', `instanceRef`) ELSE NULL END) PERSISTENT,
	`supersedesRevisionId` int,
	`supersededByRevisionId` int,
	`voidedAt` timestamp NULL,
	`voidedByUserId` int,
	`voidReason` varchar(500),
	`openedByUserId` int,
	`openedByExternalIdentityId` int,
	`openedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestDocumentRevisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestDocumentRevisions_revisionRef_unique` UNIQUE(`revisionRef`),
	CONSTRAINT `attestDocumentRevisions_instance_revision_uq` UNIQUE(`orgScopeKey`,`instanceRef`,`revision`),
	CONSTRAINT `attestDocumentRevisions_finalized_uq` UNIQUE(`finalizedKey`)
);
--> statement-breakpoint
CREATE INDEX `attestDocumentRevisions_subject_idx` ON `attestDocumentRevisions` (`orgScopeKey`,`subjectType`,`subjectRef`);
--> statement-breakpoint
CREATE TABLE `attestFields` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fieldRef` varchar(64) NOT NULL,
	`revisionId` int NOT NULL,
	`orgRef` varchar(64),
	`fieldKey` varchar(80) NOT NULL,
	`fieldType` varchar(32) NOT NULL,
	`page` int NOT NULL DEFAULT 1,
	`xFrac` double NOT NULL,
	`yFrac` double NOT NULL,
	`widthFrac` double NOT NULL,
	`heightFrac` double NOT NULL,
	`signerRole` varchar(60) NOT NULL,
	`assignedSignerId` int,
	`required` boolean NOT NULL DEFAULT true,
	`signingOrder` int,
	`subjectLineRef` varchar(120),
	`groupKey` varchar(80),
	`layoutRef` varchar(64),
	`state` enum('pending','completed','declined','voided') NOT NULL DEFAULT 'pending',
	`completedMarkId` int,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestFields_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestFields_fieldRef_unique` UNIQUE(`fieldRef`),
	CONSTRAINT `attestFields_revision_key_uq` UNIQUE(`revisionId`,`fieldKey`),
	CONSTRAINT `attestFields_completed_mark_uq` UNIQUE(`completedMarkId`)
);
--> statement-breakpoint
CREATE TABLE `attestSigners` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signerRef` varchar(64) NOT NULL,
	`revisionId` int NOT NULL,
	`orgRef` varchar(64),
	`partyKind` enum('internal_user','external_identity','named_witnessed') NOT NULL,
	`userId` int,
	`externalIdentityId` int,
	`displayName` varchar(180) NOT NULL,
	`company` varchar(180),
	`signerRole` varchar(60) NOT NULL,
	`requiredAuth` varchar(40) NOT NULL DEFAULT 'session_login',
	`signingOrder` int,
	`state` enum('invited','active','completed','declined','revoked') NOT NULL DEFAULT 'active',
	`invitedByUserId` int,
	`invitedAt` timestamp NOT NULL,
	`completedAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestSigners_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestSigners_signerRef_unique` UNIQUE(`signerRef`)
);
--> statement-breakpoint
CREATE INDEX `attestSigners_revision_idx` ON `attestSigners` (`revisionId`);
--> statement-breakpoint
CREATE TABLE `attestSigningSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionRef` varchar(120) NOT NULL,
	`revisionId` int NOT NULL,
	`signerId` int NOT NULL,
	`orgRef` varchar(64),
	`revisionHashAtStart` varchar(64) NOT NULL,
	`authMethod` enum('session_login','device_auth','portal_link','witnessed','paper_scan') NOT NULL,
	`actorUserId` int,
	`actorExternalIdentityId` int,
	`witnessedByUserId` int,
	`deviceRef` varchar(64),
	`fieldDeviceId` int,
	`keyFingerprint` varchar(80),
	`deviceSignatureBase64` text,
	`deviceSignedAt` timestamp NULL,
	`capturedOffline` boolean NOT NULL DEFAULT false,
	`deviceClockAt` timestamp NULL,
	`clockSkewMs` int,
	`consentVersion` varchar(40) NOT NULL,
	`consentTextHash` varchar(64) NOT NULL,
	`capturedLatitude` double,
	`capturedLongitude` double,
	`state` enum('started','completed','declined','abandoned','rejected') NOT NULL,
	`rejectionCode` varchar(40),
	`rejectionReason` varchar(500),
	`syncPackageId` int,
	`startedAt` timestamp NOT NULL,
	`completedAt` timestamp NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestSigningSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestSigningSessions_sessionRef_unique` UNIQUE(`sessionRef`)
);
--> statement-breakpoint
CREATE INDEX `attestSigningSessions_revision_idx` ON `attestSigningSessions` (`revisionId`);
--> statement-breakpoint
CREATE INDEX `attestSigningSessions_signer_idx` ON `attestSigningSessions` (`signerId`);
--> statement-breakpoint
CREATE TABLE `attestMarks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`markRef` varchar(120) NOT NULL,
	`sessionId` int NOT NULL,
	`fieldId` int NOT NULL,
	`orgRef` varchar(64),
	`markKind` varchar(32) NOT NULL,
	`inputKind` varchar(16) NOT NULL,
	`strokeEvidenceRecordId` int,
	`strokeHash` varchar(64),
	`renderedEvidenceRecordId` int,
	`renderedHash` varchar(64),
	`canvasWidthPx` int,
	`canvasHeightPx` int,
	`devicePixelRatio` double,
	`orientation` varchar(16),
	`pointCount` int,
	`strokeCount` int,
	`durationMs` int,
	`pressureAvailable` boolean,
	`valueText` varchar(500),
	`payloadHash` varchar(64) NOT NULL,
	`savedMarkId` int,
	`completedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestMarks_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestMarks_markRef_unique` UNIQUE(`markRef`)
);
--> statement-breakpoint
CREATE INDEX `attestMarks_session_idx` ON `attestMarks` (`sessionId`);
--> statement-breakpoint
CREATE INDEX `attestMarks_field_idx` ON `attestMarks` (`fieldId`);
--> statement-breakpoint
CREATE TABLE `attestArtifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`artifactRef` varchar(64) NOT NULL,
	`revisionId` int NOT NULL,
	`orgRef` varchar(64),
	`kind` enum('finalized_pdf','audit_receipt','page_render') NOT NULL,
	`storageKey` varchar(512),
	`manifestJson` text,
	`mimeType` varchar(120) NOT NULL,
	`byteLength` int NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`sourceRevisionHash` varchar(64) NOT NULL,
	`eventChainHead` varchar(64) NOT NULL,
	`rendererKey` varchar(40) NOT NULL,
	`rendererVersion` varchar(20) NOT NULL,
	`evidenceRecordId` int,
	`registerDocumentId` int,
	`generatedByUserId` int NOT NULL,
	`generatedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestArtifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestArtifacts_artifactRef_unique` UNIQUE(`artifactRef`)
);
--> statement-breakpoint
CREATE INDEX `attestArtifacts_revision_idx` ON `attestArtifacts` (`revisionId`);
--> statement-breakpoint
-- The on-spine producer: a field-ticket signature row now points at the session that holds its mark
-- and its chain. NULL on every row written before this migration — "signed before Sign & Attest",
-- never a guess (the 0179 originKind rule).
ALTER TABLE `fieldTicketSignatures` ADD COLUMN `attestSessionRef` varchar(120) NULL;
--> statement-breakpoint
-- A stroke document, a rendered mark or a receipt is filed in the evidence vault against the signing
-- revision and the mark, through the vault's own relationship table rather than a parallel one. The
-- enum is restated in full: a MODIFY that omitted a value would silently drop it.
ALTER TABLE `evidenceRelationships` MODIFY COLUMN `entityType` enum('operator','unit','trailer','equipment','job','trip','load','manifest','disposalTicket','fieldTicket','workOrder','incident','nearMiss','safetyMeeting','invoice','customer','facility','dailyLog','inspection','expenseRecord','financialEntity','taxYear','user','fuelTransaction','attestRevision','attestMark') NOT NULL;
