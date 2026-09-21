CREATE TABLE `complianceDocuments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerType` enum('operator','unit','job') NOT NULL,
	`ownerId` int NOT NULL,
	`docType` varchar(100) NOT NULL,
	`title` varchar(220) NOT NULL,
	`storageKey` varchar(512),
	`storageUrl` varchar(1024),
	`capturedAt` timestamp NOT NULL,
	`expiresAt` timestamp,
	`verificationStatus` enum('needs_review','verified','rejected') NOT NULL DEFAULT 'needs_review',
	`source` varchar(220),
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `complianceDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`recipientRole` varchar(80) NOT NULL,
	`recipient` varchar(220) NOT NULL,
	`status` enum('queued','delivered','failed') NOT NULL DEFAULT 'queued',
	`deliveredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `facilities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(220) NOT NULL,
	`status` enum('unknown','open','closed') NOT NULL DEFAULT 'unknown',
	`operatingHours` varchar(120),
	`acceptedMaterials` text,
	`restrictions` text,
	`phone` varchar(60),
	`emergencyPhone` varchar(60),
	`gateInstructions` text,
	`requiredDocuments` text,
	`lastVerifiedAt` timestamp,
	`latitude` double,
	`longitude` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `facilities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inspections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`unitId` int NOT NULL,
	`type` enum('training','pre_trip','post_trip') NOT NULL,
	`status` enum('pass','fail','needs_maintenance','not_applicable') NOT NULL DEFAULT 'pass',
	`checklist` text,
	`resultSummary` text,
	`observedAt` timestamp NOT NULL,
	`authenticatedOperatorId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inspections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobUnits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`unitId` int NOT NULL,
	`operatorId` int,
	`role` varchar(100) NOT NULL,
	`joinedAt` timestamp NOT NULL,
	`departedAt` timestamp,
	`hours` int,
	`mileage` int,
	`workPerformed` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `jobUnits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `loadProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`material` varchar(220) NOT NULL,
	`isWaste` boolean NOT NULL DEFAULT false,
	`composition` text,
	`sdsStorageKey` varchar(512),
	`sdsStorageUrl` varchar(1024),
	`unNumber` varchar(40),
	`properShippingName` varchar(220),
	`dgClass` varchar(40),
	`packingGroup` varchar(40),
	`quantity` varchar(80),
	`transportMode` varchar(80),
	`jurisdiction` varchar(120),
	`classificationStatus` enum('needs_verification','verified','blocked') NOT NULL DEFAULT 'needs_verification',
	`source` varchar(220),
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'low',
	`verifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `loadProfiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `maintenanceDefects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`unitId` int NOT NULL,
	`title` varchar(220) NOT NULL,
	`severity` enum('advisory','inspection_required','critical') NOT NULL DEFAULT 'advisory',
	`status` enum('open','in_progress','resolved') NOT NULL DEFAULT 'open',
	`detail` text,
	`storageKey` varchar(512),
	`storageUrl` varchar(1024),
	`reportedAt` timestamp NOT NULL,
	`reportedBy` int,
	`workOrderNumber` varchar(80),
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `maintenanceDefects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `operators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`name` varchar(180) NOT NULL,
	`company` varchar(180),
	`licenseNumber` varchar(100),
	`licenseClass` varchar(40),
	`licenseExpiresAt` timestamp,
	`restrictions` text,
	`trainingStatus` varchar(120),
	`certifications` text,
	`insurance` text,
	`emergencyContact` varchar(220),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `operators_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `signatureAudits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`signerName` varchar(180) NOT NULL,
	`authMethod` varchar(120) NOT NULL,
	`signedAt` timestamp NOT NULL,
	`documentHash` varchar(180),
	`status` enum('pending','authenticated','invalidated') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `signatureAudits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` int AUTO_INCREMENT NOT NULL,
	`unitNumber` varchar(40) NOT NULL,
	`vin` varchar(80),
	`plate` varchar(40),
	`vehicleType` varchar(120) NOT NULL,
	`company` varchar(180),
	`weightKg` int,
	`axles` int,
	`dimensions` varchar(160),
	`equipment` text,
	`inspectionStatus` enum('current','due','blocked') NOT NULL DEFAULT 'current',
	`maintenanceStatus` enum('clear','review','blocked') NOT NULL DEFAULT 'clear',
	`qrTag` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `units_id` PRIMARY KEY(`id`),
	CONSTRAINT `units_unitNumber_unique` UNIQUE(`unitNumber`)
);
