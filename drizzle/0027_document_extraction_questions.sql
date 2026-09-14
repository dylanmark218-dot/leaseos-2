-- v20.15 — Document extraction and the persistent question queue.
--
-- A photographed receipt or ticket becomes proposed fields through OCR, the
-- same way a voice note becomes proposed fields through transcription. Both
-- arrive as proposals carrying provenance and confidence; neither becomes a
-- fact until a person confirms it. The question queue is what makes "I'll deal
-- with it later" survive a phone restart: an unanswered question is a row, not
-- a modal.

CREATE TABLE `documentExtractions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `extractionRef` varchar(64) NOT NULL,
  `evidenceRecordId` int,
  `proposalId` varchar(64),
  `ocrEngine` varchar(80) NOT NULL,
  `ocrEngineVersion` varchar(40),
  `documentType` varchar(60) NOT NULL DEFAULT 'unknown',
  `classificationConfidence` double,
  `classificationSource` enum('ocr_model','merchant_memory','human') NOT NULL DEFAULT 'ocr_model',
  `rawTextHash` varchar(64),
  `fieldCount` int NOT NULL DEFAULT 0,
  `autoFiledCount` int NOT NULL DEFAULT 0,
  `reviewCount` int NOT NULL DEFAULT 0,
  `askedCount` int NOT NULL DEFAULT 0,
  `humanOnlyCount` int NOT NULL DEFAULT 0,
  `extractedAt` timestamp NOT NULL,
  `extractedByUserId` int,
  `status` enum('extracted','proposed','committed','rejected') NOT NULL DEFAULT 'extracted',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentExtractions_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentExtractions_extractionRef_unique` UNIQUE(`extractionRef`)
);
--> statement-breakpoint
CREATE INDEX `documentExtractions_evidence_idx` ON `documentExtractions` (`evidenceRecordId`);
--> statement-breakpoint

CREATE TABLE `assistantQuestions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `questionRef` varchar(64) NOT NULL,
  `proposalId` varchar(64) NOT NULL,
  `fieldKey` varchar(80) NOT NULL,
  `question` varchar(400) NOT NULL,
  `reason` enum('missing_required','low_confidence','precision_unresolved','sensitive_human_only','ambiguous_classification') NOT NULL,
  `optionsJson` text,
  `priority` int NOT NULL DEFAULT 50,
  `askedToUserId` int,
  `status` enum('pending','answered','skipped','superseded') NOT NULL DEFAULT 'pending',
  `answerValue` text,
  `answerSource` enum('typed','voice','selected'),
  `answeredByUserId` int,
  `answeredAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `assistantQuestions_id` PRIMARY KEY(`id`),
  CONSTRAINT `assistantQuestions_questionRef_unique` UNIQUE(`questionRef`)
);
--> statement-breakpoint
CREATE INDEX `assistantQuestions_proposal_idx` ON `assistantQuestions` (`proposalId`, `status`);
--> statement-breakpoint
CREATE INDEX `assistantQuestions_user_idx` ON `assistantQuestions` (`askedToUserId`, `status`);
