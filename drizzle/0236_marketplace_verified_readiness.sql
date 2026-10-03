-- 0236 — Marketplace checkpoint 4 (P10.3): verified bid readiness.
--
-- Bid readiness now reads LeaseOS's own registries — organizations, contractor profiles, the
-- financial entity as carrier subject, complianceDocuments (carrier), the insurance engine's
-- policies, owned units, worker qualification holdings, carrier out-of-service orders — through
-- the engines that already decide validity. No marketplace copy of a credential exists.
--
--   marketplaceBidRevisions.readinessFingerprint   the facts the submission picture read (MR-<sha256>);
--                                                  NULL on revisions submitted before this
--   marketplaceReadinessEvaluations                every evaluation that decided something, so the
--                                                  picture at submission and the picture now are two
--                                                  records, never one overwritten
--
-- marketplace bid readiness != dispatch readiness: the dispatch gate still decides every operator
-- and unit at assignment, after the award. Nothing here reaches it.
ALTER TABLE `marketplaceBidRevisions` ADD COLUMN `readinessFingerprint` varchar(80) NULL AFTER `readinessVerdict`;
--> statement-breakpoint
CREATE TABLE `marketplaceReadinessEvaluations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `evaluationRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `bidId` int NULL,
  `bidRevisionId` int NULL,
  `bidderOrgRef` varchar(40) NOT NULL,
  `purpose` enum('submission','submission_refused','award','award_refused') NOT NULL,
  `verdict` enum('submittable','blocked') NOT NULL,
  `dependencyFingerprint` varchar(80) NOT NULL,
  `readinessJson` text NOT NULL,
  `evaluatedByUserId` int NOT NULL,
  `evaluatedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceReadinessEvaluations_evaluationRef_unique` (`evaluationRef`),
  KEY `marketplaceReadinessEvaluations_bid_idx` (`bidId`,`evaluatedAt`),
  KEY `marketplaceReadinessEvaluations_posting_idx` (`postingId`,`evaluatedAt`)
);
