-- v22.22 — 0123 (realizes Chat 5's PENDING-4): s.6.2 topic coverage on course versions.
--
-- Until this migration the aspects printed on a TDG certificate under
-- s.6.3(1)(d) arrived as free text from the client. That is the one path a
-- certificate must not permit: it lets an issuer write scope the training never
-- covered. Aspects are now DERIVED from what the course version's modules
-- actually teach, and issuance refuses until that coverage is approved.
--
-- Authored truth is per module (`academyModules.tdgTopicCodesJson`). The version
-- carries a declaration that must reconcile against the union of its modules.
-- Approval binds to a fingerprint of the exact mapping, not to a status flag:
-- edit the mapping after approval and `tdgTopicCoverageHash` no longer equals
-- `tdgTopicReviewedHash`, so issuance refuses with TDG_TOPIC_REVIEW_STALE rather
-- than silently carrying a stale approval forward.
--
-- Nothing is pre-mapped. A human reading the actual course material establishes
-- the mapping; until then every TDG issuance path refuses with
-- TDG_TOPIC_COVERAGE_UNMAPPED.

ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgMode` enum('road','rail','vessel','air') NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicCodesJson` text NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicReviewStatus` enum('unmapped','draft','in_review','approved') NOT NULL DEFAULT 'unmapped';
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicCoverageHash` char(16) NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicReviewedHash` char(16) NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicAuthoredByUserId` int NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicReviewedByUserId` int NULL;
ALTER TABLE `academyCourseVersions` ADD COLUMN `tdgTopicReviewedAt` timestamp NULL;
ALTER TABLE `academyModules` ADD COLUMN `tdgTopicCodesJson` text NULL;
