-- v22.35 — 0142: regulator-layer importers. The 2026-09-17 endpoint research confirmed two
-- licences and one endpoint: Saskatchewan's Petroleum facilities layer names its licence in the
-- item metadata ("This product contains information licensed under the Government of
-- Saskatchewan Standard Unrestricted Use Data License (Version 2.0)"), and the BC Energy
-- Regulator's own Open Data Licence permits commercial use with attribution. Every import is a
-- run with the layer, the licence, the field mapping a person chose, and the counts.

UPDATE `facilitySourceLicences`
   SET `name` = 'Government of Saskatchewan Standard Unrestricted Use Data Licence (Version 2.0)',
       `sourceUrl` = 'https://gisappl.saskatchewan.ca/Html5Ext/Resources/GOS_Standard_Unrestricted_Use_Data_Licence_v2.0.pdf',
       `cachePermitted` = true, `commercialUsePermitted` = true,
       `attributionText` = 'Contains information licensed under the Government of Saskatchewan Standard Unrestricted Use Data Licence (Version 2.0).',
       `notes` = 'Named in the Petroleum facilities item metadata (gis.saskatchewan.ca Economy/Petroleum/FeatureServer/17): "This product contains information licensed under the Government of Saskatchewan Standard Unrestricted Use Data License (Version 2.0)." Grant: "worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes"; as-is, no warranty. Retrieved 2026-09-17.',
       `status` = 'confirmed'
 WHERE `licenceKey` = 'sk_unrestricted_use_v2';
--> statement-breakpoint
UPDATE `facilitySourceLicences`
   SET `name` = 'BC Energy Regulator Open Data Licence',
       `sourceUrl` = 'https://www.bc-er.ca/files/gis/BCER-Open-Data-Licence.pdf',
       `attributionText` = 'Contains information licenced under the BC Energy Regulator Open Data Licence',
       `notes` = 'Based on OGL–BC v2.0: "worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes"; attribution required; as-is. Layers: PASR/PASR_FACILITY_PT/MapServer/0 (points, WKID 102190/3005) and OPERATIONAL/SUMP_LOCATIONS_PT/MapServer/0. Field schemas were not verifiable at research time — the importer reads the layer''s own field list and a person maps it. Retrieved 2026-09-17.'
 WHERE `licenceKey` = 'ogl_bcer';
--> statement-breakpoint
CREATE TABLE `facilityImportRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `importRef` varchar(40) NOT NULL,
  `source` varchar(40) NOT NULL,
  `layerUrl` varchar(1024) NOT NULL,
  `licenceKey` varchar(40) NOT NULL,
  `fieldMapping` json NOT NULL,
  `wkid` int NULL,
  `featureCount` int NOT NULL DEFAULT 0,
  `inserted` int NOT NULL DEFAULT 0,
  `updated` int NOT NULL DEFAULT 0,
  `skipped` int NOT NULL DEFAULT 0,
  `skipReasons` json NULL,
  `startedByUserId` int NOT NULL,
  `startedAt` timestamp NOT NULL DEFAULT (now()),
  `note` varchar(500) NULL,
  CONSTRAINT `facilityImportRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityImportRuns_ref` UNIQUE(`importRef`)
);
