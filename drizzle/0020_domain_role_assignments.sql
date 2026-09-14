-- B20.2 — Domain role assignments.
--
-- `users.role` is only ('user','admin'), and nothing else in the schema carried
-- a permission. `dispatchRoles` is a job-posting concept, not a user grant. So
-- every operational procedure ran on "is this someone logged in", and a shop
-- account and an office account were indistinguishable to the server.
--
-- Grants are revoked rather than deleted so an access question a year from now
-- can be answered as of the date it was asked.

CREATE TABLE `userRoleAssignments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `role` enum('driver','dispatcher','mechanic','shop_lead','safety','office','management','hr','legal','auditor') NOT NULL,
  `scopeType` enum('global','branch') NOT NULL DEFAULT 'global',
  `scopeRef` varchar(64),
  `grantedByUserId` int NOT NULL,
  `grantedAt` timestamp NOT NULL,
  `revokedByUserId` int,
  `revokedAt` timestamp,
  `revokeReason` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `userRoleAssignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `userRoleAssignments_user_idx` ON `userRoleAssignments` (`userId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `userRoleAssignments_active_unique` ON `userRoleAssignments` (`userId`, `role`, `scopeRef`, `revokedAt`);
--> statement-breakpoint

-- Every authorization decision that mattered, recorded. Denials are recorded
-- too — a refused attempt to open an incident investigation is exactly the
-- event an audit wants and the one a permissive system never captures.
CREATE TABLE `authorizationDecisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `actorUserId` int,
  `procedureName` varchar(120) NOT NULL,
  `permission` varchar(80) NOT NULL,
  `rolesHeld` varchar(300),
  `outcome` enum('allowed','denied_no_role','denied_permission','denied_scope','denied_unauthenticated') NOT NULL,
  `subjectType` varchar(60), `subjectId` varchar(64),
  `detail` varchar(400),
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `authorizationDecisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `authorizationDecisions_actor_idx` ON `authorizationDecisions` (`actorUserId`);
--> statement-breakpoint
CREATE INDEX `authorizationDecisions_outcome_idx` ON `authorizationDecisions` (`outcome`);
