-- v22.20 — 0103: where a probe's question came from, and what corpus it measured.
--
-- A question written while looking at the passage inherits its vocabulary. A
-- set of those measures whether retrieval can find a passage from its own
-- words — nearly always yes, and not the thing anybody wanted to know. The
-- column exists so the grade can refuse to generalise from them.
--
-- The corpus fingerprint is recorded with each measurement because a recall
-- figure describes the corpus it ran against. Add fifty documents and the old
-- number is not stale in the sense of being out of date; it is about a
-- different thing.

ALTER TABLE `retrievalProbes`
  ADD COLUMN `origin` enum('authored_from_document','real_question') NOT NULL DEFAULT 'authored_from_document';
--> statement-breakpoint

CREATE TABLE `retrievalMeasurements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `measurementRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `k` int NOT NULL,
  `grade` enum('unmeasured','insufficient_sample','poor','adequate','good') NOT NULL,
  `probeCount` int NOT NULL,
  `realQuestionCount` int NOT NULL DEFAULT 0,
  `meanRecallBasisPoints` int,
  -- What corpus this describes. A later measurement over more passages is
  -- about a different corpus, not a newer view of the same one.
  `corpusPassageCount` int NOT NULL,
  `corpusNewestPassageAt` timestamp NULL,
  `measuredByUserId` int NOT NULL,
  `measuredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `retrievalMeasurements_id` PRIMARY KEY(`id`),
  CONSTRAINT `retrievalMeasurements_ref_unique` UNIQUE(`measurementRef`)
);
--> statement-breakpoint
CREATE INDEX `retrievalMeasurements_tenant` ON `retrievalMeasurements` (`tenantId`, `measuredAt`);
