-- 0198 — C1b-2b: requirement verification through the rule ledger (owner decision C1b-Q2 = B).
--
-- Slot: main ends at 0194. Open branches claim 0195–0197 (scan of 2026-09-25,
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md). This takes 0198, the first number no branch holds.
--
-- A requirement revision is immutable. Whether LeaseOS trusts it, and how deeply, is no longer a
-- column the proposer sets: it is the append-only record of who proposed it, who verified it against
-- what, and when the ledger promoted it. Five levels — UNVERIFIED, CITATION_VERIFIED,
-- SOURCE_DOCUMENT_VERIFIED, SUPERSEDED, WITHDRAWN — are read from that record, never written over it.
--
-- `complianceRequirements.verificationStatus` stays for the rows written before this migration and is
-- not read as authority any more: the one-step path that let a controller set it to `verified` is gone.

-- The revision's citation and its authors. `sourceAuthority` (issuing authority), `sourceReference`
-- (section or equally precise citation) and `sourceUrl` (official URL) already exist.
ALTER TABLE `complianceRequirements`
  ADD COLUMN `orgRef` varchar(64) NULL,
  ADD COLUMN `proposedByUserId` int NULL,
  ADD COLUMN `instrumentTitle` varchar(400) NULL,
  ADD COLUMN `authorityType` varchar(40) NULL,
  ADD COLUMN `effectiveDateUnknown` boolean NOT NULL DEFAULT false,
  ADD COLUMN `citationHash` varchar(64) NULL;
--> statement-breakpoint
-- Revisions are immutable: C1b-2a stopped the only writer that updated one. The database now refuses
-- it too, so a later caller cannot quietly reintroduce in-place supersession or self-verification.
CREATE TRIGGER `complianceRequirements_immutable`
BEFORE UPDATE ON `complianceRequirements`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'requirement revisions are immutable; propose a new revision';
--> statement-breakpoint
CREATE TRIGGER `complianceRequirements_no_delete`
BEFORE DELETE ON `complianceRequirements`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'requirement revisions are never deleted; withdraw the revision';
--> statement-breakpoint
-- Every step in a revision's verification, in order, never edited. `targetLevel` is what an approval
-- or promotion is for (CITATION_VERIFIED or SOURCE_DOCUMENT_VERIFIED); `step` is 1 or 2 for an approval.
CREATE TABLE `requirementVerificationEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `requirementId` int NOT NULL,
  `requirementKey` varchar(120) NOT NULL,
  `version` int NOT NULL,
  `orgRef` varchar(64) NULL,
  `eventType` enum('proposed','approved','rejected','promoted','withdrawn') NOT NULL,
  `targetLevel` varchar(32) NULL,
  `step` tinyint NULL,
  `actorUserId` int NOT NULL,
  `reason` text NULL,
  `citationHash` varchar(64) NULL,
  `sourceRevisionRef` varchar(64) NULL,
  `sourceHash` varchar(64) NULL,
  `comparisonJson` text NULL,
  `promotionRef` varchar(64) NULL,
  `verifierUserIdsJson` text NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `requirementVerificationEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `requirementVerificationEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `requirementVerificationEvents_requirement_idx` ON `requirementVerificationEvents` (`requirementId`);
--> statement-breakpoint
CREATE INDEX `requirementVerificationEvents_key_idx` ON `requirementVerificationEvents` (`requirementKey`, `version`);
--> statement-breakpoint
CREATE TRIGGER `requirementVerificationEvents_append_only`
BEFORE UPDATE ON `requirementVerificationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verification events are append-only';
--> statement-breakpoint
CREATE TRIGGER `requirementVerificationEvents_no_delete`
BEFORE DELETE ON `requirementVerificationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verification events are never deleted';
--> statement-breakpoint
-- Governance policy: may a revision from this authority / domain / jurisdiction still be verified by
-- citation alone, or must it be bound to an admitted source document? A NULL scope field matches any
-- value; the most specific matching row wins, then the latest. A change is a new row, never an edit,
-- so which policy governed a past verification stays answerable.
CREATE TABLE `sourceVerificationPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `issuingAuthority` varchar(220) NULL,
  `domain` varchar(60) NULL,
  `jurisdiction` varchar(80) NULL,
  `mode` enum('CITATION_ALLOWED','SOURCE_DOCUMENT_REQUIRED') NOT NULL,
  `reason` text NOT NULL,
  `setByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `sourceVerificationPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `sourceVerificationPolicies_policyRef_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint
CREATE TRIGGER `sourceVerificationPolicies_append_only`
BEFORE UPDATE ON `sourceVerificationPolicies`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verification policy is append-only; record a new policy row';
--> statement-breakpoint
CREATE TRIGGER `sourceVerificationPolicies_no_delete`
BEFORE DELETE ON `sourceVerificationPolicies`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verification policy rows are never deleted';
--> statement-breakpoint
-- The ledger learns the citation method and records the depth of each promotion. HOS rows keep NULL:
-- their evidence model is unchanged.
ALTER TABLE `hosRuleLimitHistory`
  MODIFY COLUMN `verificationMethod` enum('OFFICIAL_WEB','OFFICIAL_PDF','OFFICIAL_PRINT','LEGAL_COUNSEL','REGULATOR_CONFIRMATION','OFFICIAL_CITATION') NOT NULL,
  ADD COLUMN `verificationLevel` varchar(32) NULL;
