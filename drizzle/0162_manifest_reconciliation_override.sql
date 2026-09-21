-- v22.94 — 0162 (P3.1): overriding a reference-versus-print contradiction, append-only.
--
-- Owner decision: a real contradiction blocks sealing. It may be overridden only by management or
-- an explicitly delegated compliance authority — and never by the person who created the manifest,
-- because an override that the author can grant themselves is not a control, it is a second button.
--
-- The override records BOTH conflicting facts and changes NEITHER. That is the point: the manifest
-- keeps saying what it said, the record keeps saying what it says, and a third row says a named
-- person looked at the disagreement and accepted it anyway, with a reason. A repair would destroy
-- the thing an auditor came to see.
--
-- Append-only: no update, no delete. A withdrawn override is a second row, so the chain shows that
-- somebody granted it and somebody withdrew it, rather than showing that nothing ever happened.
CREATE TABLE `manifestReconciliationOverrides` (
  `id` int AUTO_INCREMENT NOT NULL,
  `overrideRef` varchar(64) NOT NULL,
  `manifestId` int NOT NULL,
  -- The manifest as it stood when the override was granted: an override of one revision is not an
  -- override of the next.
  `manifestRevisionHash` varchar(128) NULL,
  `amendmentCountAtOverride` int NOT NULL DEFAULT 0,
  `factKey` varchar(40) NOT NULL,
  -- Both facts, verbatim. Neither is corrected by this row.
  `canonicalValue` varchar(300) NULL,
  `printedValue` varchar(300) NULL,
  `referenceId` int NULL,
  `requestedByUserId` int NOT NULL,
  `authorizedByUserId` int NOT NULL,
  `authorityRole` varchar(80) NOT NULL,
  `reason` varchar(500) NOT NULL,
  `state` enum('granted','withdrawn') NOT NULL DEFAULT 'granted',
  `supersedesOverrideId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestReconciliationOverrides_id` PRIMARY KEY(`id`),
  CONSTRAINT `mro_ref` UNIQUE(`overrideRef`)
);
--> statement-breakpoint
CREATE INDEX `mro_manifest` ON `manifestReconciliationOverrides` (`manifestId`, `factKey`, `state`);
--> statement-breakpoint
-- 0162: a printed value filled in from the authoritative record before sealing is not the same as
-- one a person typed, and the manifest has to say which it was.
ALTER TABLE `manifests`
  ADD COLUMN `generatedFromReferenceJson` text NULL;
