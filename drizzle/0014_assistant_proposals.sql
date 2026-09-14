CREATE TABLE `formDefinitions` (
  `id` int AUTO_INCREMENT NOT NULL, `formKey` varchar(60) NOT NULL,
  `version` int NOT NULL DEFAULT 1, `title` varchar(180) NOT NULL,
  `fieldsJson` text NOT NULL, `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `formDefinitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `formDefinitions_key_version_idx` ON `formDefinitions` (`formKey`,`version`);
--> statement-breakpoint
CREATE TABLE `assistantProposals` (
  `id` int AUTO_INCREMENT NOT NULL, `proposalId` varchar(40) NOT NULL,
  `formKey` varchar(60) NOT NULL, `formVersion` int NOT NULL DEFAULT 1,
  `title` varchar(180) NOT NULL, `targetRef` varchar(180) NOT NULL,
  `jobId` int, `tripId` int, `unitId` int, `operatorId` int, `createdByUserId` int,
  `transcript` text, `notes` text, `readBack` text,
  `readBackAcknowledged` boolean NOT NULL DEFAULT false,
  `commitState` enum('drafting','awaiting_answers','awaiting_readback','committed','rejected') NOT NULL DEFAULT 'drafting',
  `overreachFlags` text, `capturedOffline` boolean NOT NULL DEFAULT false,
  `committedAt` timestamp, `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `assistantProposals_id` PRIMARY KEY(`id`),
  CONSTRAINT `assistantProposals_proposalId_unique` UNIQUE(`proposalId`)
);
--> statement-breakpoint
CREATE INDEX `assistantProposals_state_idx` ON `assistantProposals` (`commitState`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `assistantProposals_trip_idx` ON `assistantProposals` (`tripId`);
--> statement-breakpoint
CREATE TABLE `proposalFields` (
  `id` int AUTO_INCREMENT NOT NULL, `proposalId` varchar(40) NOT NULL,
  `fieldKey` varchar(60) NOT NULL, `label` varchar(180) NOT NULL, `fieldValue` text,
  `precision` enum('exact','approximate') NOT NULL DEFAULT 'approximate',
  `source` enum('driver_voice','driver_typed','gps','photo_ocr','system_inferred','imported','human_corrected') NOT NULL,
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `status` enum('proposed','confirmed','rejected','corrected') NOT NULL DEFAULT 'proposed',
  `sourceUtterance` varchar(400), `correctedFrom` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `proposalFields_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposalFields_lookup_idx` ON `proposalFields` (`proposalId`,`fieldKey`);
