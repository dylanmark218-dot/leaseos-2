-- v22.20 — 0101: passages, and the questions asked of them.
--
-- A passage is a piece of a document with enough identity to be cited: which
-- document, which revision, where in it, and when that revision was in force.
-- Without the revision window a citation is a claim about the past that reads
-- like a claim about now.
--
-- `assistantQueries` records what was asked, what was retrieved and what the
-- verdict was. That is not analytics — an assistant that answered "insufficient
-- evidence" and later turns out to have been right needs to be able to show
-- that it said so, and one that answered confidently from a superseded revision
-- needs to be findable.
--
-- No embedding column. Retrieval here is lexical, and pretending otherwise by
-- reserving a vector field would suggest a capability that does not exist.

CREATE TABLE `knowledgePassages` (
  `id` int AUTO_INCREMENT NOT NULL,
  `passageRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `documentRef` varchar(64) NOT NULL,
  `documentTitle` varchar(300) NOT NULL,
  `section` varchar(120),
  `page` int,
  `body` text NOT NULL,
  `revision` varchar(40) NOT NULL,
  `effectiveFrom` timestamp NULL,
  `supersededAt` timestamp NULL,
  -- Null means the document states none, which is not "all of them".
  `jurisdiction` varchar(20),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `knowledgePassages_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgePassages_ref_unique` UNIQUE(`passageRef`)
);
--> statement-breakpoint
CREATE INDEX `knowledgePassages_tenant` ON `knowledgePassages` (`tenantId`, `documentRef`);
--> statement-breakpoint
CREATE FULLTEXT INDEX `knowledgePassages_body` ON `knowledgePassages` (`body`);
--> statement-breakpoint

CREATE TABLE `assistantQueries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `queryRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `askedByUserId` int NOT NULL,
  `question` varchar(1000) NOT NULL,
  `jurisdiction` varchar(20),
  `verdict` enum('verified','partially_supported','insufficient_evidence','conflicting') NOT NULL,
  `passagesRetrieved` int NOT NULL DEFAULT 0,
  `passagesSupporting` int NOT NULL DEFAULT 0,
  `citedPassageRefsJson` text NOT NULL,
  `askedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `assistantQueries_id` PRIMARY KEY(`id`),
  CONSTRAINT `assistantQueries_ref_unique` UNIQUE(`queryRef`)
);
--> statement-breakpoint
CREATE INDEX `assistantQueries_tenant` ON `assistantQueries` (`tenantId`, `askedAt`);
