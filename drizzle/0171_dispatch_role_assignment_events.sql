-- Assignment history for a dispatch role slot. Append-only.
--
-- `dispatchRoles` holds the current binding and is mutated; this table is how the change is
-- remembered. Two rules it exists to keep:
--
-- 1. HISTORY IS NOT THE CURRENT ROW. A slot's occupancy has one answer and mutating it is honest;
--    what a mutable row cannot do is say who changed it, from what, when and why. Every transition
--    writes exactly one row here, and nothing in production updates or deletes one.
--
-- 2. THIS IS NOT `dispatchAuditEvents`. That table's entire production vocabulary is
--    `assignment_approved` and `assignment_blocked`, and `assignment_approved` doubles as the
--    award transaction's idempotency record. Writing assignment history there would make an
--    assignment indistinguishable from an award to the award's own replay check — the exact
--    conflation this subsystem exists to end. An assignment writes here and nowhere else.
--
-- The before/after columns are carried in full rather than as a diff so a reader can reconstruct
-- any point in the slot's life from one row, without replaying the chain.

CREATE TABLE `dispatchRoleAssignmentEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventRef` varchar(64) NOT NULL,
	`roleId` int NOT NULL,
	-- Denormalised so history reads by posting or by job without joining back through the role,
	-- which matters because a role's posting never changes but the read paths differ.
	`postingId` int NOT NULL,
	`jobId` int NOT NULL,
	-- Provenance, in the repository's spelling. NULL orgRef = the historical single tenant, as
	-- everywhere except the role-type catalog.
	`orgRef` varchar(64),
	`eventType` enum('assignment_created','assignment_reassigned','assignment_unassigned') NOT NULL,
	`fromOperatorId` int,
	`fromUnitId` int,
	`fromTrailerId` int,
	`toOperatorId` int,
	`toUnitId` int,
	`toTrailerId` int,
	-- Required for reassignment and unassignment; optional for a first assignment, where there is
	-- no displaced binding to account for.
	`reason` varchar(500),
	`actorUserId` int NOT NULL,
	`actorRole` varchar(60) NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dispatchRoleAssignmentEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `dispatchRoleAssignmentEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint

-- The concurrency read: the head event for one role, taken under the role lock on every mutation.
CREATE INDEX `dispatchRoleAssignmentEvents_role_idx`
  ON `dispatchRoleAssignmentEvents` (`roleId`, `id`);
--> statement-breakpoint

-- The history panel: one job's assignment story, newest first.
CREATE INDEX `dispatchRoleAssignmentEvents_job_idx`
  ON `dispatchRoleAssignmentEvents` (`jobId`, `occurredAt`);
