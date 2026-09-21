-- v22.32 — 0139: the disposal-facility directory, re-based from feature/facility-map-v7 onto this
-- lineage. That branch forked off the original base and carried its own 0012 with its own
-- `facilities` table; this lineage already has `facilities` (P3), linked to organizations by a
-- person (0134) and reconciled against facility statements (0135). So: ONE facilities table,
-- extended; operators are organizations; the v7 engines port unchanged; the seed runs on the
-- server; and every evidence row names the licence it was taken under, from a register built
-- from the 2026-09-17 registry research (docs/facility-map/REGISTRY_PROVENANCE_2026-09-17.md).
--
-- Invariants carried over from the v7 spec: a map pin is not disposal authorization; a
-- service area is not an entrance; unknown, approximate, expired or conflicting evidence
-- fails closed; coordinates always carry precision and provenance.

ALTER TABLE `facilities`
  ADD COLUMN `facilityKey` varchar(100) NULL,
  ADD COLUMN `province` char(2) NULL,
  ADD COLUMN `facilityType` varchar(100) NULL,
  ADD COLUMN `municipality` varchar(120) NULL,
  ADD COLUMN `legalLocation` varchar(80) NULL,
  ADD COLUMN `coordinatePrecision` enum('verified_entrance','verified_site','approximate_site','community_only','unknown') NOT NULL DEFAULT 'unknown',
  ADD COLUMN `coordinateSourceUrl` varchar(1024) NULL,
  ADD COLUMN `coordinateVerifiedAt` timestamp NULL,
  ADD COLUMN `coordinateVerifiedByUserId` int NULL,
  ADD COLUMN `disposition` enum('verified_facility','approximate_facility','service_location','ambiguous') NOT NULL DEFAULT 'ambiguous',
  ADD COLUMN `regulatorRef` varchar(80) NULL,
  ADD COLUMN `regulatorRefSourceUrl` varchar(1024) NULL,
  ADD COLUMN `operatorNameFromSource` varchar(220) NULL,
  ADD COLUMN `websiteUrl` varchar(1024) NULL,
  ADD COLUMN `accountRegistrationUrl` varchar(1024) NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `facilities_key` ON `facilities` (`facilityKey`);
--> statement-breakpoint
-- The licence register: what each source lets us do with what we took from it.
CREATE TABLE `facilitySourceLicences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `licenceKey` varchar(40) NOT NULL,
  `name` varchar(160) NOT NULL,
  `publisher` varchar(160) NOT NULL,
  `sourceUrl` varchar(1024) NOT NULL,
  `cachePermitted` boolean NOT NULL,
  `commercialUsePermitted` boolean NOT NULL,
  `attributionText` varchar(300) NULL,
  `notes` varchar(1000) NULL,
  `retrievedAt` date NOT NULL,
  `status` enum('confirmed','unconfirmed','permission_required') NOT NULL,
  CONSTRAINT `facilitySourceLicences_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilitySourceLicences_key` UNIQUE(`licenceKey`)
);
--> statement-breakpoint
INSERT INTO `facilitySourceLicences` (`licenceKey`,`name`,`publisher`,`sourceUrl`,`cachePermitted`,`commercialUsePermitted`,`attributionText`,`notes`,`retrievedAt`,`status`) VALUES
  ('aer_copyright','AER website copyright (ST107, directives, lists)','Alberta Energy Regulator','https://www.aer.ca/copyright-and-disclaimer',false,false,'Source: Alberta Energy Regulator','Reproduction for commercial redistribution is prohibited except with prior written permission of the AER. Store the WM approval number as the verification key and link out; do not cache the list (P6.8).','2026-09-17','permission_required'),
  ('ogl_alberta','Open Government Licence – Alberta','Government of Alberta','https://open.alberta.ca/licence',true,true,'Contains information licensed under the Open Government Licence – Alberta','Applies to open.alberta.ca and alberta.ca publications such as the hydrovac-accepting facilities list (2026-04-10) and the EPEA hazardous facilities contacts list.','2026-09-17','confirmed'),
  ('ogl_bc','Open Government Licence – British Columbia (v2.0)','Province of British Columbia','https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc',true,true,'Contains information licensed under the Open Government Licence – British Columbia','Applies only to B.C. Data Catalogue records that specify it. The catalogue''s hazardous-waste-facilities dataset is DEPRECATED; do not use it.','2026-09-17','confirmed'),
  ('ogl_bcer','Open Government Licence – BC Energy Regulator','BC Energy Regulator','https://data-bc-er.opendata.arcgis.com/',true,true,'Contains information licensed under the Open Government Licence – BC Energy Regulator','Facility index, disposal stations and sump locations via the Data Centre and GIS open-data portal.','2026-09-17','confirmed'),
  ('ogl_canada','Open Government Licence – Canada','Government of Canada','https://open.canada.ca/en/open-government-licence-canada',true,true,'Contains information licensed under the Open Government Licence – Canada','ECCC publishes no facility registry; authorized-facility status is provincial.','2026-09-17','confirmed'),
  ('sk_unrestricted_use_v2','Standard Unrestricted Use Data Licence v2.0','Government of Saskatchewan','https://www.saskatchewan.ca/',true,true,'Source: Government of Saskatchewan','Geospatial data only. No downloadable oilfield-waste facility directory was located; verification is by reference to IRIS (P6.9).','2026-09-17','unconfirmed'),
  ('mb_unconfirmed','Manitoba Petroleum Branch data (terms unconfirmed)','Government of Manitoba','https://www.gov.mb.ca/iem/petroleum/gis/index.html',false,false,'Source: Manitoba Petroleum Branch','No open licence identified for the GIS map gallery; view/reference only until permission is confirmed (P6.9).','2026-09-17','permission_required'),
  ('company_website','Operator''s own public website','(the operator)',' ',true,true,NULL,'Public contact information and service claims. Every claim taken here is a LEAD until a regulator or the facility confirms it.','2026-09-17','confirmed');
--> statement-breakpoint
CREATE TABLE `facilityCapabilities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityId` int NOT NULL,
  `wasteCode` varchar(60) NOT NULL,
  `handlingMethod` varchar(100) NULL,
  `acceptanceStatus` enum('verified','confirmation_required','not_accepted','unknown') NOT NULL DEFAULT 'unknown',
  `conditions` text NULL,
  `evidenceId` int NULL,
  `verifiedAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `setByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityCapabilities_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityCapabilities_key` UNIQUE(`facilityId`,`wasteCode`)
);
--> statement-breakpoint
CREATE TABLE `facilityEvidence` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityId` int NOT NULL,
  `publisher` varchar(220) NOT NULL,
  `title` varchar(300) NOT NULL,
  `sourceUrl` varchar(1024) NOT NULL,
  `licenceKey` varchar(40) NOT NULL,
  `claimType` varchar(80) NOT NULL,
  `claimValue` text NULL,
  `cachedContent` boolean NOT NULL DEFAULT false,
  `retrievedAt` timestamp NOT NULL,
  `effectiveAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'low',
  `reviewState` enum('lead','reviewed','rejected','conflicting') NOT NULL DEFAULT 'lead',
  `reviewedByUserId` int NULL,
  `reviewedAt` timestamp NULL,
  `reviewNote` varchar(500) NULL,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityEvidence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `facilityEvidence_facility` ON `facilityEvidence` (`facilityId`,`claimType`,`reviewState`);
--> statement-breakpoint
CREATE TABLE `facilityAliases` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityId` int NOT NULL,
  `alias` varchar(220) NOT NULL,
  `relationship` varchar(80) NULL,
  `sourceUrl` varchar(1024) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityAliases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Immutable: an assessment is written once with the engine version and input snapshot; a new decision is a new row.
CREATE TABLE `loadFacilityAssessments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `assessmentRef` varchar(40) NOT NULL,
  `loadId` int NOT NULL,
  `facilityId` int NOT NULL,
  `outcome` enum('compatible_verified','facility_confirmation_required','incompatible','insufficient_information') NOT NULL,
  `blocking` boolean NOT NULL,
  `reasonCodes` json NOT NULL,
  `evidenceIds` json NOT NULL,
  `inputSnapshot` json NOT NULL,
  `engineVersion` varchar(60) NOT NULL,
  `assessedAt` timestamp NOT NULL DEFAULT (now()),
  `assessedByUserId` int NOT NULL,
  CONSTRAINT `loadFacilityAssessments_id` PRIMARY KEY(`id`),
  CONSTRAINT `loadFacilityAssessments_ref` UNIQUE(`assessmentRef`)
);
--> statement-breakpoint
CREATE INDEX `loadFacilityAssessments_load` ON `loadFacilityAssessments` (`loadId`,`facilityId`,`assessedAt`);
--> statement-breakpoint
-- Waste-stream vocabulary: LeaseOS's internal codes against the regulators' terms. Every
-- regulator mapping is a CANDIDATE until a person verifies it against the directive text.
CREATE TABLE `wasteStreamVocabulary` (
  `id` int AUTO_INCREMENT NOT NULL,
  `internalCode` varchar(60) NOT NULL,
  `label` varchar(120) NOT NULL,
  `aerWasteCode` varchar(120) NULL,
  `albertaWcrClass` varchar(60) NULL,
  `sourceUrl` varchar(1024) NULL,
  `sourceVersion` varchar(240) NULL,
  `verificationStatus` enum('candidate','verified','not_applicable') NOT NULL DEFAULT 'candidate',
  `verifiedByUserId` int NULL,
  `verifiedAt` timestamp NULL,
  `verificationNote` varchar(500) NULL,
  CONSTRAINT `wasteStreamVocabulary_id` PRIMARY KEY(`id`),
  CONSTRAINT `wasteStreamVocabulary_code` UNIQUE(`internalCode`)
);
--> statement-breakpoint
INSERT INTO `wasteStreamVocabulary` (`internalCode`,`label`,`aerWasteCode`,`sourceUrl`,`sourceVersion`,`verificationStatus`) VALUES
  ('produced_water','Produced water','WATER: Water – Produced (including brine solutions)','https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04); code quoted from the 2026-09-17 registry research, unverified against the directive text','candidate'),
  ('flowback','Flowback / completion fluids',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('drilling_mud','Drilling mud',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('drill_cuttings','Drill cuttings',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('oily_water_emulsion','Oily water / emulsion',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('contaminated_soil','Contaminated soil',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('hazardous_solids','Hazardous solids',NULL,'https://www.alberta.ca/hazardous-facilities','Waste Control Regulation, Alta Reg 192/1996','candidate'),
  ('hydrovac_slurry','Hydrovac slurry',NULL,'https://www.alberta.ca/system/files/epa-facilities-list-hydrovac-waste.pdf','Code of Practice for Hydrovac Facilities; facilities list dated 2026-04-10','candidate'),
  ('domestic_septage','Domestic septage',NULL,NULL,NULL,'candidate'),
  ('portable_toilet_waste','Portable toilet waste',NULL,NULL,NULL,'candidate'),
  ('grease_trap_waste','Grease trap waste',NULL,NULL,NULL,'candidate'),
  ('asbestos','Asbestos',NULL,NULL,NULL,'candidate'),
  ('construction_demolition','Construction and demolition waste',NULL,NULL,NULL,'candidate'),
  ('commercial_msw','Commercial municipal solid waste',NULL,NULL,NULL,'candidate'),
  ('tires','Tires',NULL,NULL,NULL,'candidate'),
  ('scrap_metal','Scrap metal',NULL,NULL,NULL,'candidate'),
  ('clean_wood','Clean wood',NULL,NULL,NULL,'candidate');
