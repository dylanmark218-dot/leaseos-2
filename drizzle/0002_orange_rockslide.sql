CREATE TABLE `routeContexts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(180) NOT NULL,
	`source` varchar(220) NOT NULL,
	`effectiveAt` timestamp NOT NULL,
	`expiresAt` timestamp,
	`verifiedAt` timestamp,
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`restrictions` text,
	`snapshotKey` varchar(512),
	`snapshotUrl` varchar(1024),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `routeContexts_id` PRIMARY KEY(`id`)
);
