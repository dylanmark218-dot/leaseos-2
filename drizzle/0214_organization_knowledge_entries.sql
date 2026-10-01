-- 0214 — AIL-1B: company intelligence as governed organization records.
--
-- Slot: on 2026-10-01 the remote branches hold every number from 0180 to 0213 except 0190 and 0204.
-- Those two are gaps inside another branch's own run (0189→0191, 0203→0205), so they are treated as
-- held. 0214 is the first number past every claim. docs/architecture/MIGRATION_COLLISION_REGISTER.md
-- records it.
--
-- What a company "knows" (its terminology and shorthand, SOP knowledge, facility and customer
-- conventions, approved preferences, known gaps and verified corrections) is a record here, never
-- model memory (owner ruling R-1). A row:
--
--   * belongs to exactly one organization: `tenantId` is stamped from the server's acting scope and
--     is NOT NULL. There is no GLOBAL row and no NULL-means-global row (R-2). Public naming stays in
--     facilityAliases;
--   * starts as `proposed` and has no effect until a DIFFERENT person approves it. The CHECKs make an
--     unreviewed approval, and a self-approval, impossible to store;
--   * says where it came from: a person's statement, a correction a person made on a committed
--     record, or one of the organization's own company documents. It never comes from a raw assistant
--     conversation, which stays private to the person who asked;
--   * is never deleted. Replacement supersedes it, withdrawal retires it, and both keep the row.
CREATE TABLE `organizationKnowledgeEntries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `entryRef` varchar(64) NOT NULL,
  `tenantId` varchar(40) NOT NULL,
  `tenantDerivedFrom` enum('membership','single_tenant_fallback') NOT NULL,
  `kind` enum('terminology','alias','sop','facility_convention','customer_convention','preference','knowledge_gap','verified_correction') NOT NULL,
  `term` varchar(220) NOT NULL,
  `termKey` varchar(220) NOT NULL,
  `meaning` text NOT NULL,
  `subjectType` enum('none','facility','customer','form_field') NOT NULL DEFAULT 'none',
  `subjectRef` varchar(160),
  `sourceKind` enum('person_statement','verified_correction','company_document') NOT NULL,
  `sourceRef` varchar(120),
  `state` enum('proposed','approved','rejected','superseded','retired') NOT NULL DEFAULT 'proposed',
  `proposedByUserId` int NOT NULL,
  `proposedAt` timestamp NOT NULL,
  `reviewedByUserId` int,
  `reviewedAt` timestamp NULL,
  `reviewNote` varchar(500),
  `supersededByEntryRef` varchar(64),
  `retiredByUserId` int,
  `retiredAt` timestamp NULL,
  `retireReason` varchar(500),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `organizationKnowledgeEntries_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationKnowledgeEntries_entryRef_unique` UNIQUE(`entryRef`),
  CONSTRAINT `organizationKnowledgeEntries_tenant_present` CHECK (`tenantId` <> ''),
  -- Proposed is exactly "nobody has reviewed it yet"; every other state was reviewed.
  CONSTRAINT `organizationKnowledgeEntries_review_shape` CHECK ((`state` = 'proposed') = (`reviewedByUserId` IS NULL)),
  CONSTRAINT `organizationKnowledgeEntries_two_people` CHECK (`reviewedByUserId` IS NULL OR `reviewedByUserId` <> `proposedByUserId`),
  CONSTRAINT `organizationKnowledgeEntries_subject_shape` CHECK ((`subjectType` = 'none') = (`subjectRef` IS NULL)),
  CONSTRAINT `organizationKnowledgeEntries_source_shape` CHECK (`sourceKind` = 'person_statement' OR `sourceRef` IS NOT NULL),
  CONSTRAINT `organizationKnowledgeEntries_correction_shape` CHECK ((`kind` = 'verified_correction') = (`sourceKind` = 'verified_correction') AND (`kind` <> 'verified_correction' OR `subjectType` = 'form_field')),
  CONSTRAINT `organizationKnowledgeEntries_superseded_shape` CHECK ((`state` = 'superseded') = (`supersededByEntryRef` IS NOT NULL)),
  CONSTRAINT `organizationKnowledgeEntries_retired_shape` CHECK ((`state` = 'retired') = (`retiredAt` IS NOT NULL AND `retiredByUserId` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `organizationKnowledgeEntries_lookup_idx` ON `organizationKnowledgeEntries` (`tenantId`, `termKey`, `state`);
--> statement-breakpoint
CREATE INDEX `organizationKnowledgeEntries_review_idx` ON `organizationKnowledgeEntries` (`tenantId`, `state`, `proposedAt`);
