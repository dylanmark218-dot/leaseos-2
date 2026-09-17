-- v22.28 — 0135 (P7.3): disposal reconciliation. A disposal facility's statement is imported
-- as evidence and each line is matched to a LeaseOS disposal ticket. Outcomes are match,
-- match_with_variance, unmatched or ambiguous — never a silent correction of the ticket. A
-- person resolves each line that is not a clean match, with a note; resolving a line as
-- "ticket needs correction" records that fact and routes it to the existing correction path,
-- it does not edit the ticket here.

CREATE TABLE `facilityStatements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `statementRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `facilityId` int NOT NULL,
  `facilityOrgRef` varchar(64) NULL,
  `facilityStatementNumber` varchar(80) NULL,
  `periodStart` date NOT NULL,
  `periodEnd` date NOT NULL,
  `lineCount` int NOT NULL DEFAULT 0,
  `matchedCount` int NOT NULL DEFAULT 0,
  `varianceCount` int NOT NULL DEFAULT 0,
  `unmatchedCount` int NOT NULL DEFAULT 0,
  `ambiguousCount` int NOT NULL DEFAULT 0,
  `contentHash` varchar(64) NOT NULL,
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `importedByUserId` int NOT NULL,
  `importedAt` timestamp NOT NULL DEFAULT (now()),
  `closedByUserId` int NULL,
  `closedAt` timestamp NULL,
  CONSTRAINT `facilityStatements_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityStatements_ref` UNIQUE(`statementRef`),
  CONSTRAINT `facilityStatements_hash` UNIQUE(`facilityId`,`contentHash`)
);
--> statement-breakpoint
CREATE TABLE `facilityStatementLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityStatementId` int NOT NULL,
  `lineNo` int NOT NULL,
  `facilityTicketNumber` varchar(80) NULL,
  `receivedAt` timestamp NOT NULL,
  `material` varchar(120) NULL,
  `quantity` double NOT NULL,
  `quantityUnit` varchar(16) NOT NULL,
  `amountCents` int NULL,
  `unitHint` varchar(40) NULL,
  `manifestHint` varchar(60) NULL,
  `matchedDisposalTicketId` int NULL,
  `matchOutcome` enum('match','match_with_variance','unmatched','ambiguous') NOT NULL,
  `matchReason` varchar(300) NOT NULL,
  `variances` json NULL,
  `candidateTicketIds` json NULL,
  `resolution` enum('accepted','ticket_needs_correction','facility_error','disputed') NULL,
  `resolutionNote` varchar(500) NULL,
  `resolvedByUserId` int NULL,
  `resolvedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityStatementLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityStatementLines_line` UNIQUE(`facilityStatementId`,`lineNo`)
);
--> statement-breakpoint
CREATE INDEX `facilityStatementLines_outcome` ON `facilityStatementLines` (`facilityStatementId`,`matchOutcome`,`resolution`);
--> statement-breakpoint
CREATE INDEX `facilityStatementLines_ticket` ON `facilityStatementLines` (`matchedDisposalTicketId`);
