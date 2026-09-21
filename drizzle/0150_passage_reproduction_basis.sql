-- v22.61 — 0150 (P4.4): a reproduced passage records its basis and the person who asserted it.
--
-- knowledgePassages holds text quoted back to a person by the assistant. The corpus tables
-- (knowledgeSources / knowledgeDocuments / knowledgeChunks) may only be written through
-- _core/knowledge/repository.ts, behind the source-licence gate, and every chunk already records
-- authorizedByAssessmentId so a revoked licence can find its rows. The passage library had neither:
-- no licence basis and no record of who put the text there. Nothing prevented a regulator's
-- directive or a copyrighted standard being pasted in through assistant.addPassage and quoted back,
-- with no way afterwards to find it or say who was accountable.
--
-- Two columns, both NOT NULL for new rows once backfilled:
--   reproductionBasis  'own_document' (the organization's own material) or 'licensed_source'
--   loadedByUserId     the person who asserted it; a passage with no accountable person is not a
--                      record, it is an anonymous copy
-- licenceAssessmentRef is required when the basis is a licensed source, and names the same
-- assessment id the corpus gate uses, so a revocation can sweep both tables by one key.
ALTER TABLE `knowledgePassages`
  ADD COLUMN `reproductionBasis` varchar(24) NULL,
  ADD COLUMN `licenceAssessmentRef` varchar(64) NULL,
  ADD COLUMN `loadedByUserId` int NULL;
--> statement-breakpoint
-- Existing rows predate the rule. They are marked as unstated rather than assumed to be the
-- organization's own: "unknown" stays unknown, and a sweep can find them.
UPDATE `knowledgePassages` SET `reproductionBasis` = 'unstated' WHERE `reproductionBasis` IS NULL;
--> statement-breakpoint
CREATE INDEX `passage_basis` ON `knowledgePassages` (`reproductionBasis`);
--> statement-breakpoint
CREATE INDEX `passage_licence` ON `knowledgePassages` (`licenceAssessmentRef`);
