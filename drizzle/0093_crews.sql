-- v22.20 — 0093: crews, and the rotation each person works.
--
-- The forecast engine has had nothing to read. This gives it crews, members and
-- the pattern each member is on, so "who is short on the 23rd" becomes a
-- question about records rather than about arguments passed in by a caller.
--
-- The rotation lives on the member rather than the crew because people move
-- between patterns and crews outlive patterns. A crew of eight can hold two
-- 14/7 hitches and a day-shift supervisor, and modelling that on the crew would
-- force the exception into a comment.
--
-- `leftAt` ends a membership without removing the row, matching the channel
-- rule: deleting it would make somebody's messages authored by a person who was
-- never in the crew.

CREATE TABLE `crews` (
  `id` int AUTO_INCREMENT NOT NULL,
  `crewRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `name` varchar(220) NOT NULL,
  `type` enum('permanent','job','shift','site','unit','project','emergency') NOT NULL DEFAULT 'permanent',
  `supervisorUserId` int,
  `jobRef` varchar(64),
  `branchId` varchar(40),
  `state` enum('active','read_only','archived') NOT NULL DEFAULT 'active',
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `crews_id` PRIMARY KEY(`id`),
  CONSTRAINT `crews_ref_unique` UNIQUE(`crewRef`)
);
--> statement-breakpoint
CREATE INDEX `crews_tenant` ON `crews` (`tenantId`, `state`);
--> statement-breakpoint

CREATE TABLE `crewMembers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `crewRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `crewRole` enum('supervisor','driver','operator','labourer','mechanic','safety','dispatch','other') NOT NULL DEFAULT 'driver',
  `source` enum('manual','dispatch','job_assignment','shift_assignment') NOT NULL DEFAULT 'manual',
  -- The rotation this person works. Null means no pattern, which is not the
  -- same as never working.
  `rotationOnDays` int,
  `rotationOffDays` int,
  `rotationAnchor` timestamp NULL,
  `joinedAt` timestamp NOT NULL,
  `leftAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `crewMembers_id` PRIMARY KEY(`id`),
  CONSTRAINT `crewMembers_current_unique` UNIQUE(`crewRef`, `userId`, `joinedAt`)
);
--> statement-breakpoint
CREATE INDEX `crewMembers_crew` ON `crewMembers` (`crewRef`, `leftAt`);
