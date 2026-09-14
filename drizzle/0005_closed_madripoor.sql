CREATE TABLE `complianceArtifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trackingNumber` varchar(40) NOT NULL,
	`artifactType` varchar(40) NOT NULL,
	`jobId` int,
	`locationId` int,
	`manifestId` int,
	`status` enum('active','completed','archived','legal_hold') NOT NULL DEFAULT 'active',
	`jurisdiction` varchar(100),
	`regulatoryProfile` varchar(180),
	`regulatoryVersion` varchar(100),
	`retentionUntil` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `complianceArtifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `complianceArtifacts_trackingNumber_unique` UNIQUE(`trackingNumber`)
);
--> statement-breakpoint
CREATE TABLE `tailgateMeetings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trackingNumber` varchar(40) NOT NULL,
	`jobId` int,
	`locationId` int,
	`supervisor` varchar(180),
	`operators` text,
	`units` text,
	`hazards` text,
	`ppe` text,
	`controls` text,
	`voiceTranscript` text,
	`reviewStatus` enum('needs_review','approved') NOT NULL DEFAULT 'needs_review',
	`startedAt` timestamp,
	`endedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tailgateMeetings_id` PRIMARY KEY(`id`),
	CONSTRAINT `tailgateMeetings_trackingNumber_unique` UNIQUE(`trackingNumber`)
);
--> statement-breakpoint
CREATE TABLE `transferAcknowledgements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trackingNumber` varchar(40) NOT NULL,
	`channel` enum('email','portal','api','download') NOT NULL,
	`recipient` varchar(220) NOT NULL,
	`deliveryStatus` enum('pending','confirmed','failed','opened') NOT NULL DEFAULT 'pending',
	`messageId` varchar(180),
	`attachmentCount` int NOT NULL DEFAULT 0,
	`acknowledgedBy` varchar(180),
	`acknowledgedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transferAcknowledgements_id` PRIMARY KEY(`id`)
);
