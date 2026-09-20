-- v23.25 — 0168: a permit becomes a record, so the gate that checks it has something to read.
--
-- `dispatchReadiness` has handled permits correctly since it was written. Three-valued, and the
-- unknown branch refuses rather than passes:
--
--     if (input.job.permitRequired) {
--       if (permitOnFile === false) -> permit_missing, blocking
--       else if (permitOnFile === null) -> permit_unknown, unknown
--     }
--
-- The gate was never the problem. `readinessComposer.ts:401` supplies its input, and the line reads
-- `permitRequired: false` — a literal, sitting between two fields that are computed properly.
-- `destinationAcceptanceVerified` comes from a real query over facility assessments;
-- `tdgDocumentPrepared` is `dangerousGoods ? null : true`, which is the honest idiom. Permits got
-- neither. Every job asserts no permit is required, so the entire block above is dead code and an
-- oversize movement passes the permit check in silence.
--
-- That is wrong in the permissive direction, which is the direction that matters. `false` is not a
-- cautious default for "nobody has looked" — it is the answer that lets the truck go.
--
-- This table is the thing the composer can read instead. Columns follow the specialized freight
-- build plan's `movement_permits`: authority, permit number, effective period, conditions,
-- route/version, document. Provenance is carried per the standing rule — a permit entered by a
-- dispatcher and a permit confirmed against the issuing authority's system are not the same fact,
-- and the difference has to survive into the gate.
CREATE TABLE `movementPermits` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `organizationId` bigint unsigned NOT NULL,
  `permitRef` varchar(64) NOT NULL,

  -- what it authorizes
  `jobId` bigint unsigned NULL,
  `tripId` bigint unsigned NULL,
  `unitId` bigint unsigned NULL,

  -- who issued it. `authority` is the issuing body, `jurisdiction` the area it governs; an Alberta
  -- permit issued by a municipality is not the province's, and a route crossing both needs both.
  `authority` varchar(160) NOT NULL,
  `jurisdiction` varchar(32) NOT NULL,
  `permitNumber` varchar(120) NOT NULL,
  `permitType` enum('oversize','overweight','oversize_overweight','dangerous_goods','seasonal','municipal','other') NOT NULL,

  -- when it is good for. Both nullable: a permit whose window nobody recorded is not a permit that
  -- runs forever, and the resolver reads a null window as unknown rather than as open.
  `effectiveFrom` datetime NULL,
  `effectiveTo` datetime NULL,

  -- the conditions text as issued. Stored verbatim and never parsed into a pass: the freight plan is
  -- explicit that permit conditions override generic guidance, and an interpretation of a condition
  -- is not the condition.
  `conditionsText` text NULL,
  `routeRef` varchar(120) NULL,
  `routeVersion` varchar(64) NULL,
  `documentId` bigint unsigned NULL,

  -- provenance
  `source` enum('dispatcher_entered','authority_portal','document_extraction','imported','customer_supplied') NOT NULL,
  `verificationStatus` enum('unverified','verified','rejected','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedAt` datetime NULL,
  `verifiedBy` bigint unsigned NULL,
  `supersededBy` bigint unsigned NULL,

  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdBy` bigint unsigned NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mp_ref` (`permitRef`)
);
--> statement-breakpoint
CREATE INDEX `mp_job` ON `movementPermits` (`organizationId`, `jobId`);
--> statement-breakpoint
CREATE INDEX `mp_trip` ON `movementPermits` (`organizationId`, `tripId`);
--> statement-breakpoint
CREATE INDEX `mp_window` ON `movementPermits` (`organizationId`, `effectiveTo`);
--> statement-breakpoint
-- Whether a movement needs a permit at all is a separate determination from whether one is on file,
-- and it is the one the composer was faking. It cannot be derived here: the thresholds are
-- regulatory data — Alberta's dimensional limits, a municipality's truck-route bylaw — and none of
-- them are loaded. Inventing them is the failure mode the standing rule names outright.
--
-- So the determination is recorded rather than computed, by whoever actually made it, and stays
-- unknown until somebody does. A job with no row here reads as UNKNOWN, not as exempt.
CREATE TABLE `movementPermitDeterminations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `organizationId` bigint unsigned NOT NULL,
  `jobId` bigint unsigned NOT NULL,
  `permitRequired` tinyint(1) NOT NULL,
  -- why. A determination with no stated basis is an opinion, and the audit asks for the basis first.
  `basis` enum('within_legal_limits','dimensions_exceed_limit','weight_exceeds_limit','dangerous_goods_route','municipal_restriction','authority_advised','other') NOT NULL,
  `basisNote` text NULL,
  `ruleSourceKey` varchar(120) NULL,
  `ruleSourceVersion` varchar(64) NULL,
  `determinedBy` bigint unsigned NOT NULL,
  `determinedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `supersededAt` datetime NULL,
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE INDEX `mpd_job` ON `movementPermitDeterminations` (`organizationId`, `jobId`, `supersededAt`);
