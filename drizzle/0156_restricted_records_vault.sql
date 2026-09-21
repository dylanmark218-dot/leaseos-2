-- v22.71 — 0156 (P8.5): the incident fan-out spine, the investigation proposal, and break-glass.
--
-- The spec's own prerequisite (§0) said this subsystem stays in design until four things were true.
-- Checked before writing a line, not assumed: the B20 authorization engine is on this branch and
-- reconciled; the B12 engines survived it; migration `0021` replaced `0020`'s broken
-- UNIQUE(userId, role, scopeRef, revokedAt) — which does not constrain anything in MySQL, since
-- NULLs are distinct in a unique index — with a generated column that is NULL when revoked; and
-- B20.3 is finished, 0 bare protectedProcedure against 633 role procedures. The gate is open.
--
-- `incidentReports` is already the root record. The spine attaches to it rather than introducing a
-- rival incident table, per §2's explicit non-duplication warning.

-- §4.2 — a thin spine registering every derived matter. Type-specific lifecycles live elsewhere;
-- this keeps the fan-out queryable without forcing unrelated lifecycles into one shape.
CREATE TABLE `incidentMatters` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,                       -- NULL = historical single tenant (0132 rule)
  `incidentReportId` int NOT NULL,                 -- the root. Facts are referenced, never copied.
  `matterType` enum('INSURANCE_CLAIM','WCB_CLAIM','REGULATORY_REPORT','POLICE_FILE','CLIENT_NOTICE','THIRD_PARTY_CLAIM','INTERNAL_INVESTIGATION','LITIGATION') NOT NULL,
  -- Book 17 PRV-CLS-001. Stored, never inferred at read time: a tier computed on the way out is a
  -- tier that changes when the query does.
  `sensitivityTier` enum('INTERNAL','CONFIDENTIAL','RESTRICTED','HIGHLY_RESTRICTED') NOT NULL,
  -- §12 — category-neutral. A number that spells out INV or WCB leaks the category to anyone who
  -- sees the number, which is the one thing the restricted sector exists to prevent.
  `trackingNumber` varchar(40) NOT NULL,
  `status` enum('PROPOSED','OPEN','SUBMITTED','IN_REVIEW','CLOSED','DECLINED','UNKNOWN') NOT NULL DEFAULT 'PROPOSED',
  `openedAt` timestamp NULL,
  `closedAt` timestamp NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `matter_incident` (`orgRef`, `incidentReportId`),
  KEY `matter_type_status` (`orgRef`, `matterType`, `status`),
  UNIQUE KEY `matter_tracking` (`orgRef`, `trackingNumber`)
);
--> statement-breakpoint
-- §5 — the proposal, and what a decline records. A declined proposal creates NO investigation row:
-- the trace is that a decision was made, never its content.
CREATE TABLE `investigationProposals` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,
  `incidentReportId` int NOT NULL,
  -- Which rule fired. A rule, not a model's judgement: the system proposes from stated conditions
  -- so the proposal can be explained and argued with.
  `triggerRule` varchar(80) NOT NULL,
  `triggerPolicy` varchar(80) NULL,
  `proposedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `disposition` enum('PENDING','OPENED','HANDLED_INTERNALLY','NOT_WARRANTED','DEFERRED') NOT NULL DEFAULT 'PENDING',
  `decidedByUserId` int NULL,
  `decidedByRole` varchar(40) NULL,
  `decidedAt` timestamp NULL,
  -- Optional by owner decision. A company that handles a matter in-house owes the system no essay.
  `decisionReason` varchar(500) NULL,
  -- Set only when the disposition is OPENED.
  `matterId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `proposal_incident` (`orgRef`, `incidentReportId`),
  KEY `proposal_disposition` (`orgRef`, `disposition`)
);
--> statement-breakpoint
-- §6.2 — a grant opens ONE record, not the sector, and expires.
CREATE TABLE `restrictedAccessGrants` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,
  `userId` int NOT NULL,                           -- bound to the person, not the session or device
  `recordType` varchar(40) NOT NULL,
  `recordId` int NOT NULL,
  -- Stored verbatim. A dropdown alone is not a purpose: "audit" explains nothing a year later.
  `purpose` varchar(500) NOT NULL,
  `grantedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiresAt` timestamp NOT NULL,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `grant_lookup` (`userId`, `recordType`, `recordId`, `revokedAt`)
);
--> statement-breakpoint
-- §6.1 — the audit event, written BEFORE content is served. If this write fails, access fails.
-- An access log that can be outrun by the read it describes is not an access log.
CREATE TABLE `restrictedAccessEvents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,
  `grantId` int NULL,                              -- null for a denial: there was no grant
  `userId` int NOT NULL,
  `recordType` varchar(40) NOT NULL,
  `recordId` int NOT NULL,
  `action` enum('READ','EXPORT','PRINT','GRANT_CREATED','GRANT_REVOKED','DENIED') NOT NULL,
  `purpose` varchar(500) NULL,
  -- The structured denial shape from Book 12: code, and a reason a person can act on.
  `decisionCode` varchar(60) NULL,
  `decisionReason` varchar(500) NULL,
  `occurredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `access_record` (`orgRef`, `recordType`, `recordId`, `occurredAt`),
  KEY `access_user` (`userId`, `occurredAt`)
);
