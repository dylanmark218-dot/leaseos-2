CREATE TABLE `billingRateCards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`unitType` varchar(100) NOT NULL,
	`hourlyRate` int NOT NULL DEFAULT 0,
	`dailyRate` int NOT NULL DEFAULT 0,
	`jumpHourRate` int NOT NULL DEFAULT 0,
	`disposalRate` int NOT NULL DEFAULT 0,
	`specialtyEquipmentRate` int NOT NULL DEFAULT 0,
	`currency` varchar(3) NOT NULL DEFAULT 'CAD',
	`active` int NOT NULL DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billingRateCards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobChargeLines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`description` varchar(220) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`unitRate` int NOT NULL DEFAULT 0,
	`amount` int NOT NULL DEFAULT 0,
	`source` varchar(80) NOT NULL DEFAULT 'rate_card',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `jobChargeLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unitSafetyPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`unitId` int,
	`unitLabel` varchar(120) NOT NULL,
	`hazardSummary` text,
	`shutdownProcedure` text,
	`requiredPpe` text,
	`sdsReferences` text,
	`emergencyContacts` text,
	`version` int NOT NULL DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `unitSafetyPlans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`category` varchar(100) NOT NULL,
	`contactName` varchar(160),
	`phone` varchar(40),
	`emergencyPhone` varchar(40),
	`email` varchar(220),
	`coverageArea` varchar(220),
	`availability` varchar(100),
	`notes` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `vendors_id` PRIMARY KEY(`id`)
);
