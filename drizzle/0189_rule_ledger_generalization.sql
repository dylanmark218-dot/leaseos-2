-- 0189 — C1b-1: the HOS promotion ledger becomes the one rule ledger (D-03, C1b-Q1: in place, additive).
--
-- Slot: main ends at 0179 (the 0169 reconciliation, #17). Open branches claim every number from 0175
-- to 0188 (scan of 2026-09-24, docs/architecture/MIGRATION_COLLISION_REGISTER.md). This takes 0189, the
-- first number no branch holds, rather than renumbering anyone else's work.
--
-- `hosRuleLimitHistory` already has what a regulatory rule ledger needs: an immutable row per promotion,
-- four dates, a named verifier, a supersession chain, corrections that never edit what they correct.
-- Rather than build a second ledger and copy legal history into it, the table learns to hold other rule
-- families. It keeps its name: renaming a table that holds legal history is not worth the risk.
--
-- Nothing existing is rewritten except the backfill `ruleFamily = 'hos_limit'`, `domain = 'hos'`, and
-- the `ruleRef` derived from the columns every existing row already carries. `believedOn` for HOS reads
-- the same rows and returns the same answers (promotionLedger.db.test.ts / ruleLedger.db.test.ts).
--
-- `profileKey`, `limitKey` and `value` become nullable because a non-HOS rule (a document requirement,
-- a permit condition) has none of them. The HOS path still always writes all three.
ALTER TABLE `hosRuleLimitHistory`
  ADD COLUMN `ruleFamily` varchar(40) NOT NULL DEFAULT 'hos_limit',
  ADD COLUMN `ruleRef` varchar(160) NULL,
  ADD COLUMN `domain` varchar(40) NULL,
  ADD COLUMN `authorityTier` varchar(40) NULL,
  ADD COLUMN `dispatchEffect` varchar(16) NULL,
  ADD COLUMN `sourceRevisionRef` varchar(64) NULL,
  ADD COLUMN `sourceHash` varchar(64) NULL,
  ADD COLUMN `proposedByUserId` int NULL,
  ADD COLUMN `secondVerifierUserId` int NULL,
  ADD COLUMN `secondVerifiedAt` timestamp NULL,
  ADD COLUMN `payloadJson` text NULL,
  MODIFY COLUMN `profileKey` varchar(60) NULL,
  MODIFY COLUMN `limitKey` varchar(60) NULL,
  MODIFY COLUMN `value` double NULL;
--> statement-breakpoint
UPDATE `hosRuleLimitHistory`
  SET `ruleRef` = CONCAT(`profileKey`, '.', `limitKey`), `domain` = 'hos'
  WHERE `ruleFamily` = 'hos_limit' AND `ruleRef` IS NULL;
--> statement-breakpoint
-- Tier of the existing rows, by the design's mapping table (§4), not by judgement: `law` is statute,
-- `official_guidance` is statute flagged guidance (the flag is `authorityType` itself), and a standard or
-- a manufacturer figure not adopted by a program version is best practice.
UPDATE `hosRuleLimitHistory`
  SET `authorityTier` = CASE `authorityType`
    WHEN 'law' THEN 'statute_regulation'
    WHEN 'official_guidance' THEN 'statute_regulation'
    ELSE 'best_practice' END
  WHERE `authorityTier` IS NULL;
--> statement-breakpoint
CREATE INDEX `hosRuleLimitHistory_family_rule_idx` ON `hosRuleLimitHistory` (`ruleFamily`, `ruleRef`);
--> statement-breakpoint
CREATE INDEX `hosRuleLimitHistory_family_status_idx` ON `hosRuleLimitHistory` (`ruleFamily`, `status`);
--> statement-breakpoint
CREATE INDEX `hosRuleLimitHistory_source_revision_idx` ON `hosRuleLimitHistory` (`sourceRevisionRef`);
--> statement-breakpoint
-- The source half. A rule revision cannot be verified without a verified source revision whose hash it
-- records, so the revision needs to say what it is a revision of and whether a person has checked it.
-- `status` is backfilled from the one fact the table already had: a version with a verifier is verified.
ALTER TABLE `knowledgeVersions`
  ADD COLUMN `citation` varchar(400) NULL,
  ADD COLUMN `section` varchar(200) NULL,
  ADD COLUMN `publicationDate` date NULL,
  ADD COLUMN `retrievedAt` timestamp NULL,
  ADD COLUMN `repealedAt` timestamp NULL,
  ADD COLUMN `status` varchar(16) NOT NULL DEFAULT 'candidate';
--> statement-breakpoint
UPDATE `knowledgeVersions` SET `status` = 'verified' WHERE `verifiedByUserId` IS NOT NULL;
--> statement-breakpoint
UPDATE `knowledgeVersions` SET `status` = 'superseded' WHERE `supersededByVersionRef` IS NOT NULL;
