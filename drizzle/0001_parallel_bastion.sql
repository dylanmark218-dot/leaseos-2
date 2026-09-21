CREATE TABLE `checklistItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`title` varchar(220) NOT NULL,
	`completed` boolean NOT NULL DEFAULT false,
	`completedAt` timestamp,
	`completedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `checklistItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `evidenceRecords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`title` varchar(220) NOT NULL,
	`category` varchar(80) NOT NULL,
	`storageKey` varchar(512),
	`storageUrl` varchar(1024),
	`mimeType` varchar(120),
	`capturedAt` timestamp NOT NULL,
	`capturedBy` int,
	`latitude` double,
	`longitude` double,
	`status` enum('needs_review','verified','unverified') NOT NULL DEFAULT 'needs_review',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `evidenceRecords_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobCode` varchar(32) NOT NULL,
	`type` varchar(120) NOT NULL,
	`mode` enum('general','hydrovac','recovery','transport') NOT NULL DEFAULT 'general',
	`customer` varchar(160) NOT NULL,
	`location` varchar(220) NOT NULL,
	`vehicle` varchar(120),
	`driver` varchar(120),
	`status` enum('dispatched','in_transit','loading','on_site','awaiting_docs','complete') NOT NULL DEFAULT 'dispatched',
	`progress` int NOT NULL DEFAULT 0,
	`eta` varchar(32),
	`latitude` double,
	`longitude` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_jobCode_unique` UNIQUE(`jobCode`)
);
--> statement-breakpoint
CREATE TABLE `safetyEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int,
	`eventType` varchar(80) NOT NULL,
	`severity` enum('info','warning','critical') NOT NULL DEFAULT 'info',
	`title` varchar(220) NOT NULL,
	`detail` text,
	`occurredAt` timestamp NOT NULL,
	`status` enum('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `safetyEvents_id` PRIMARY KEY(`id`)
);
