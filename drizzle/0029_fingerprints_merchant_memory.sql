-- v20.16 — Document fingerprints and merchant memory.
--
-- The same receipt photographed twice must become one expense, not two. The
-- same facility ticket scanned by the driver and again by the office must be
-- one disposal record. A fingerprint is how a second capture recognizes the
-- first: a hash of the bytes for exact duplicates, and a structured key —
-- vendor, date, total; facility, ticket number, load — for the near ones where
-- the photo differs but the document does not.
--
-- Merchant memory is what lets the tenth receipt from the same cardlock skip
-- the classification question. It earns confidence from confirmed filings,
-- never from sightings.

CREATE TABLE `documentFingerprints` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fingerprintRef` varchar(64) NOT NULL,
  `documentType` varchar(60) NOT NULL,
  -- SHA-256 of the captured bytes. Exact-duplicate detection.
  `contentSha256` varchar(64),
  -- SHA-256 of the canonical structured key. Near-duplicate detection.
  `structuredKeyHash` varchar(64) NOT NULL,
  `structuredKey` varchar(400) NOT NULL,
  `evidenceRecordId` int,
  `extractionRef` varchar(64),
  `targetType` varchar(40),
  `targetRecordId` int,
  `capturedByUserId` int,
  `capturedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `documentFingerprints_id` PRIMARY KEY(`id`),
  CONSTRAINT `documentFingerprints_fingerprintRef_unique` UNIQUE(`fingerprintRef`)
);
--> statement-breakpoint
CREATE INDEX `documentFingerprints_content_idx` ON `documentFingerprints` (`contentSha256`);
--> statement-breakpoint
CREATE INDEX `documentFingerprints_structured_idx` ON `documentFingerprints` (`structuredKeyHash`);
--> statement-breakpoint

CREATE TABLE `merchantMemory` (
  `id` int AUTO_INCREMENT NOT NULL,
  `vendorNormalized` varchar(200) NOT NULL,
  `vendorDisplay` varchar(220),
  `documentType` varchar(60) NOT NULL,
  `categoryKey` varchar(60),
  `seenCount` int NOT NULL DEFAULT 0,
  `confirmedCount` int NOT NULL DEFAULT 0,
  `rejectedCount` int NOT NULL DEFAULT 0,
  `lastSeenAt` timestamp,
  `lastConfirmedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `merchantMemory_id` PRIMARY KEY(`id`),
  CONSTRAINT `merchantMemory_vendor_type_unique` UNIQUE(`vendorNormalized`,`documentType`)
);
