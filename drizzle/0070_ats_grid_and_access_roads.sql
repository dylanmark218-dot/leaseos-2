-- v22.13 — The mapping foundation from open data.
--
-- Two fabrics, imported from the authoritative services and never invented:
--
-- `atsLegalSubdivisions`  — ATS v4.1 Legal Subdivision with Road Allowance
--   polygons from Alberta's Township System service (Open Government Licence
--   — Alberta). Each row carries the source layer, its retrieval time, the
--   polygon ring and a centroid computed from it. A road-allowance parcel
--   (RA = 'RW') is marked, because it is a road allowance, not land.
--
-- `accessRoadSegments` — Base Features Access Road lines from Alberta's
--   access_facility_roads service, the province's authoritative rural road
--   layer, carrying Alberta's own FEATURE_TYPE with its published label, the
--   road class, and the geometry source and date the province states.
--
-- `geoImportRuns` — every import: which source, which endpoint, what query,
--   what came back, who ran it. An import is evidence with a provenance, so
--   a later reader can tell what was fetched and when.

CREATE TABLE `atsLegalSubdivisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `pid` varchar(32) NOT NULL,
  `meridian` int NOT NULL,
  `rangeNumber` int NOT NULL,
  `township` int NOT NULL,
  `sectionNumber` int NOT NULL,
  `quarterSection` varchar(4),
  `legalSubdivision` int,
  `roadAllowance` varchar(8),
  `descriptor` varchar(120) NOT NULL,
  `centroidLatitude` double NOT NULL,
  `centroidLongitude` double NOT NULL,
  `minLatitude` double NOT NULL,
  `minLongitude` double NOT NULL,
  `maxLatitude` double NOT NULL,
  `maxLongitude` double NOT NULL,
  `ringJson` text NOT NULL,
  `areaSquareMetres` double,
  `sourceKey` varchar(120) NOT NULL,
  `sourceLayer` varchar(180) NOT NULL,
  `importRunRef` varchar(64) NOT NULL,
  `retrievedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `atsLegalSubdivisions_id` PRIMARY KEY(`id`),
  CONSTRAINT `atsLegalSubdivisions_pid_unique` UNIQUE(`pid`)
);
--> statement-breakpoint
CREATE INDEX `atsLegalSubdivisions_grid` ON `atsLegalSubdivisions` (`meridian`, `rangeNumber`, `township`, `sectionNumber`, `legalSubdivision`);
--> statement-breakpoint
CREATE INDEX `atsLegalSubdivisions_bbox` ON `atsLegalSubdivisions` (`minLatitude`, `minLongitude`, `maxLatitude`, `maxLongitude`);
--> statement-breakpoint

CREATE TABLE `accessRoadSegments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `objectId` int NOT NULL,
  `name` varchar(220),
  `highwayNumber` varchar(40),
  `roadClass` varchar(60),
  `featureType` int,
  `featureTypeLabel` varchar(80),
  `surfaceKind` enum('paved','gravel','dry_weather','winter','driveway','ramp','ferry','ford','other','unknown') NOT NULL DEFAULT 'unknown',
  `lanes` int,
  `lengthMetres` double,
  `minLatitude` double NOT NULL,
  `minLongitude` double NOT NULL,
  `maxLatitude` double NOT NULL,
  `maxLongitude` double NOT NULL,
  `pathJson` text NOT NULL,
  `geometrySource` varchar(40),
  `geometryDate` timestamp NULL,
  `providerUpdatedAt` timestamp NULL,
  `sourceKey` varchar(120) NOT NULL,
  `sourceLayer` varchar(180) NOT NULL,
  `importRunRef` varchar(64) NOT NULL,
  `retrievedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `accessRoadSegments_id` PRIMARY KEY(`id`),
  CONSTRAINT `accessRoadSegments_object_unique` UNIQUE(`objectId`)
);
--> statement-breakpoint
CREATE INDEX `accessRoadSegments_bbox` ON `accessRoadSegments` (`minLatitude`, `minLongitude`, `maxLatitude`, `maxLongitude`);
--> statement-breakpoint

CREATE TABLE `geoImportRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `sourceKey` varchar(120) NOT NULL,
  `dataset` enum('ats_lsd','access_roads') NOT NULL,
  `endpoint` varchar(600) NOT NULL,
  `queryJson` text NOT NULL,
  `featuresFetched` int NOT NULL DEFAULT 0,
  `rowsWritten` int NOT NULL DEFAULT 0,
  `rowsSkipped` int NOT NULL DEFAULT 0,
  `truncated` boolean NOT NULL DEFAULT false,
  `outcome` enum('running','complete','failed') NOT NULL DEFAULT 'running',
  `failureReason` varchar(600),
  `startedByUserId` int NOT NULL,
  `startedAt` timestamp NOT NULL DEFAULT (now()),
  `finishedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `geoImportRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `geoImportRuns_runRef_unique` UNIQUE(`runRef`)
);
