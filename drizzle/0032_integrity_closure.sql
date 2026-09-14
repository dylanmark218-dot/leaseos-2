-- v20.17 — P3 integrity closure.
--
-- Three forward changes and one new table, all serving the rule that a
-- fingerprint check is something the commit service DOES, not something a
-- caller remembers to run.

-- A person may override a possible duplicate. The override is a recorded act
-- with a name and a reason, not a flag a client flips.
ALTER TABLE `assistantProposals`
  ADD COLUMN `duplicateOverride` boolean NOT NULL DEFAULT false AFTER `facilityId`,
  ADD COLUMN `duplicateOverrideByUserId` int NULL AFTER `duplicateOverride`,
  ADD COLUMN `duplicateOverrideReason` varchar(400) NULL AFTER `duplicateOverrideByUserId`;
--> statement-breakpoint

-- Exact-duplicate detection needs the bytes' hash at extraction time.
ALTER TABLE `documentExtractions`
  ADD COLUMN `contentSha256` varchar(64) NULL AFTER `rawTextHash`;
--> statement-breakpoint

-- A fingerprint is written at commit, from a proposal. It should say which.
ALTER TABLE `documentFingerprints`
  ADD COLUMN `proposalId` varchar(64) NULL AFTER `extractionRef`;
--> statement-breakpoint
CREATE INDEX `documentFingerprints_proposal_idx` ON `documentFingerprints` (`proposalId`);
--> statement-breakpoint

-- One receipt belongs to a worker, an expense, a job, a unit and a tax year
-- without duplicating its bytes. The relationship table already does this;
-- it just did not know about the financial entities yet.
ALTER TABLE `evidenceRelationships`
  MODIFY COLUMN `entityType` enum('operator','unit','trailer','equipment','job','trip','load','manifest','disposalTicket','fieldTicket','workOrder','incident','nearMiss','safetyMeeting','invoice','customer','facility','dailyLog','inspection','expenseRecord','financialEntity','taxYear','user') NOT NULL;
--> statement-breakpoint

-- Home-base distance as EVIDENCE. Never a tax determination: the column that
-- would hold one does not exist, and the engine's type says `not_determined`
-- as a literal, so nothing downstream can read a conclusion that was never made.
CREATE TABLE `remoteWorkEvidence` (
  `id` int AUTO_INCREMENT NOT NULL,
  `evidenceRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `homeBaseRef` varchar(120) NOT NULL,
  `workLocationRef` varchar(120) NOT NULL,
  `occurredOn` varchar(10) NOT NULL,
  `distanceKm` double,
  `distanceSource` enum('route_engine','geodesic','operator_confirmed','unknown') NOT NULL DEFAULT 'unknown',
  `homeLatitude` double, `homeLongitude` double,
  `workLatitude` double, `workLongitude` double,
  `nightsAway` int,
  `conclusion` enum('evidence_available','insufficient_evidence') NOT NULL,
  `insufficiencyReason` varchar(300),
  `sourceRecordType` varchar(40),
  `sourceRecordId` int,
  `recordedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `remoteWorkEvidence_id` PRIMARY KEY(`id`),
  CONSTRAINT `remoteWorkEvidence_evidenceRef_unique` UNIQUE(`evidenceRef`)
);
--> statement-breakpoint
CREATE INDEX `remoteWorkEvidence_user_idx` ON `remoteWorkEvidence` (`userId`, `occurredOn`);
