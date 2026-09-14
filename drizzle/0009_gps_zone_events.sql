CREATE TABLE `tripBreadcrumbs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tripId` int NOT NULL,
  `unitId` int,
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `accuracyMetres` double,
  `speedKmh` double,
  `headingDegrees` double,
  `source` enum('gps','dead_reckoning','manual') NOT NULL DEFAULT 'gps',
  `recordedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `tripBreadcrumbs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `tripBreadcrumbs_trip_recorded_idx` ON `tripBreadcrumbs` (`tripId`,`recordedAt`);
--> statement-breakpoint
CREATE TABLE `zoneEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tripId` int NOT NULL,
  `zoneId` int NOT NULL,
  `tripStopId` int,
  `eventType` enum('enter','exit') NOT NULL,
  `detectedAt` timestamp NOT NULL,
  `distanceMetres` double NOT NULL,
  `accuracyMetres` double,
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `status` enum('pending','confirmed','rejected','expired') NOT NULL DEFAULT 'pending',
  `confirmedAt` timestamp,
  `confirmedBy` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `zoneEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `zoneEvents_trip_detected_idx` ON `zoneEvents` (`tripId`,`detectedAt`);
--> statement-breakpoint
CREATE INDEX `zoneEvents_status_idx` ON `zoneEvents` (`status`);
