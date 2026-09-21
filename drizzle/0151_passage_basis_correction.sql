-- v22.62 — 0151 (P4.4, correcting 0150 after human review): the source and the assessment are two
-- different things, and an own-document claim is an assertion, not a proof.
--
-- 0150 stored one column, licenceAssessmentRef, and the router passed the *source id* into it —
-- so a row said "assessment LIC-…" while holding "gov-ab-511". Revocation works off the assessment
-- and correction works off the source, so a sweep needed both and had neither reliably.
--
--   sourceId               the named source, as the licence registry keys it (user-stated)
--   licenceAssessmentRef   the assessment that authorized it, stamped by the gate, never typed
--   rightsAssertion        for an own document: the statement the person actually made. Recording
--                          who clicked is not the same as recording what they claimed.
ALTER TABLE `knowledgePassages`
  ADD COLUMN `sourceId` varchar(64) NULL,
  ADD COLUMN `rightsAssertion` varchar(500) NULL;
--> statement-breakpoint
-- 0150 rows (if any) put a source id in the assessment column. Move it to the column that means it
-- and clear the one that does not, rather than leaving a row that misnames its own basis.
UPDATE `knowledgePassages`
   SET `sourceId` = `licenceAssessmentRef`, `licenceAssessmentRef` = NULL
 WHERE `reproductionBasis` = 'licensed_source' AND `licenceAssessmentRef` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `passage_source` ON `knowledgePassages` (`sourceId`);
