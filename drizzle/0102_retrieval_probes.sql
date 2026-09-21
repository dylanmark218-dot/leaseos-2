-- v22.20 — 0102: labelled probes, so recall is a record rather than a script.
--
-- A probe is somebody who knows the corpus writing down a question and the
-- passages that ought to answer it. Keeping them in the database rather than in
-- a test fixture matters: the corpus changes, the probes must be re-run against
-- it, and a measurement nobody can reproduce next quarter is not a measurement.
--
-- `authoredByUserId` because a probe is a claim like any other — "these
-- passages answer this question" is a person's judgement and should carry their
-- name.

CREATE TABLE `retrievalProbes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `probeRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `question` varchar(1000) NOT NULL,
  `expectedPassageRefsJson` text NOT NULL,
  `authoredByUserId` int NOT NULL,
  `retiredAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `retrievalProbes_id` PRIMARY KEY(`id`),
  CONSTRAINT `retrievalProbes_ref_unique` UNIQUE(`probeRef`)
);
--> statement-breakpoint
CREATE INDEX `retrievalProbes_tenant` ON `retrievalProbes` (`tenantId`, `retiredAt`);
