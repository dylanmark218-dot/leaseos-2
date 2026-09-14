CREATE TABLE `locationIdentities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`surfaceLsd` varchar(80) NOT NULL,
	`downholeLsd` varchar(80),
	`uwi` varchar(120),
	`wellLicense` varchar(100),
	`operator` varchar(180),
	`lease` varchar(180),
	`field` varchar(160),
	`province` varchar(100),
	`accessRoad` varchar(220),
	`gate` varchar(180),
	`hazards` text,
	`emergencyInfo` text,
	`surfaceLatitude` double,
	`surfaceLongitude` double,
	`downholeLatitude` double,
	`downholeLongitude` double,
	`source` varchar(220),
	`lastVerifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `locationIdentities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `manifests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`manifestNumber` varchar(80) NOT NULL,
	`locationId` int,
	`jobId` int,
	`material` varchar(220),
	`unNumber` varchar(40),
	`unitId` int,
	`trailer` varchar(100),
	`driver` varchar(180),
	`route` varchar(220),
	`facility` varchar(220),
	`scaleTickets` text,
	`evidenceRefs` text,
	`signatureRefs` text,
	`status` enum('draft','verified','complete') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `manifests_id` PRIMARY KEY(`id`),
	CONSTRAINT `manifests_manifestNumber_unique` UNIQUE(`manifestNumber`)
);
--> statement-breakpoint
CREATE TABLE `scanAudits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`scanType` enum('qr','nfc') NOT NULL,
	`subjectType` enum('unit','location','manifest') NOT NULL,
	`subjectId` int NOT NULL,
	`accessRole` enum('inspection','driver','mechanic','dispatcher','admin') NOT NULL,
	`scannedAt` timestamp NOT NULL,
	`latitude` double,
	`longitude` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scanAudits_id` PRIMARY KEY(`id`)
);
