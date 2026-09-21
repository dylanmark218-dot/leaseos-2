-- 0113 — authoritative tenant ownership for legacy core records.
-- Legacy units/operators/loads/financialEntities predate organizations. Rather than
-- guessing ownership from free-text company fields, attach one server-managed owner.
CREATE TABLE `coreRecordOwnership` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(40) NOT NULL,
  `recordType` enum('unit','operator','load','financial_entity') NOT NULL,
  `recordId` int NOT NULL,
  `assignedByUserId` int NOT NULL,
  `assignedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `coreRecordOwnership_record_unique` (`recordType`,`recordId`),
  KEY `coreRecordOwnership_org_record_idx` (`orgRef`,`recordType`,`recordId`)
);
