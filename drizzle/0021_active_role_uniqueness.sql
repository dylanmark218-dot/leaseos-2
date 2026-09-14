-- B20.3 — Active role uniqueness, enforced by the database.
--
-- 0020 used UNIQUE(userId, role, scopeRef, revokedAt) to mean "one active
-- grant". It does not. MySQL and MariaDB permit unlimited NULLs in a unique
-- index, and an active grant is exactly the row where revokedAt IS NULL — so
-- the constraint was inert for precisely the rows it was written to protect.
-- Demonstrated before fixing: two identical active mechanic grants inserted
-- without complaint.
--
-- Replaced with a persistent generated column that is NULL for revoked rows and
-- carries a collision key for active ones. Uniqueness is then enforced on the
-- key rather than on a tuple containing a NULL. Application-level duplicate
-- checks are not a substitute — two concurrent grants would both pass a
-- read-then-write check.

DROP INDEX `userRoleAssignments_active_unique` ON `userRoleAssignments`;
--> statement-breakpoint

ALTER TABLE `userRoleAssignments`
  ADD COLUMN `activeGrantKey` varchar(180)
    AS (CASE WHEN `revokedAt` IS NULL
             THEN CONCAT(`userId`, ':', `role`, ':', COALESCE(`scopeRef`, '*'))
             ELSE NULL END) PERSISTENT;
--> statement-breakpoint

CREATE UNIQUE INDEX `userRoleAssignments_activeGrantKey_unique`
  ON `userRoleAssignments` (`activeGrantKey`);
--> statement-breakpoint

-- Bootstrap is a one-time transition and must be recorded as an event, not
-- inferred from the absence of a management grant.
CREATE TABLE `roleBootstrapEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `targetUserId` int NOT NULL,
  `performedByUserId` int NOT NULL,
  `reason` text NOT NULL,
  `activeManagementCountBefore` int NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roleBootstrapEvents_id` PRIMARY KEY(`id`)
);
