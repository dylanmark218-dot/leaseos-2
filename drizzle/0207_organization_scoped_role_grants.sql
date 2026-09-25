-- RENUMBERED 0170 -> 0207 when main was merged into this branch (2026-09-25): main had taken 0170
-- (0170_dispatch_role_types, #9). 0207 was the first slot free on main and on every open branch
-- (docs/architecture/MIGRATION_COLLISION_REGISTER.md). The notes below explain the original choice.
-- B23.1 — organization-scoped role grants.
--
-- MIGRATION SLOT. The head on this branch is 0168. 0169 is NOT free: it is
-- occupied by two DIFFERENT migrations in other lineages of this repository —
-- `0169_defect_resolution.sql` (feature/dispatcher-detail-assignment,
-- feature/dispatcher-readiness-panel, readiness-defect-repair) and
-- `0169_print_audit.sql` (claude/mobile-hardware-scanner-mzp1e1-v2327), which
-- also carries a conflicting `0168_movement_permits.sql`. Slot 0157 is already
-- duplicated on THIS branch for the same reason. 0170 is free in every lineage
-- checked, so 0170 it is.
--
-- ============================================================
-- THE BUG
-- ============================================================
--
-- `scopeType` was `('global','branch')` and carried no organization, so an
-- account that drives for one company and wrenches for another held both roles
-- as account-wide facts. `records.roles.grant` writes `global` whenever no
-- branch is named, which is almost always, so in practice every business role
-- this system has ever issued claimed authority in every organization.
--
-- Membership and the tenant-scoped queries already isolated the DATA. The
-- AUTHORITY was not isolated at all: acting for company A, a role granted only
-- by company B still satisfied `authorize()`, because there was no
-- organization axis for it to fail on.
--
-- ============================================================
-- WHAT `global` MEANT, AND WHAT IT MEANS NOW
-- ============================================================
--
-- It meant "everywhere", but only because there was nowhere else to write. It
-- now means what it says — deliberate platform-wide authority spanning every
-- organization — and the backfill below grants it to NOBODY. Every existing
-- business grant becomes organization-scoped or is quarantined. Converting
-- working accounts into platform administrators is precisely the accident this
-- migration exists to avoid.
--
-- ============================================================
-- BACKFILL: DETERMINISTIC, OR REFUSED
-- ============================================================
--
-- Each ACTIVE grant is classified by how many live organization memberships
-- its holder has. Live means the same thing it means in `resolveActingScope`:
-- membership active, inside its term, and the organization itself active.
--
--   exactly one  -> attribute the grant to that organization. Deterministic.
--   zero         -> attribute to 'default', the historical single tenant this
--                   deployment already acts as for such users. If they later
--                   join a real organization, this grant stops matching and
--                   must be re-granted — which is the correct behaviour, not a
--                   regression.
--   more than one-> QUARANTINE as 'unscoped_legacy'. This is the case the
--                   checkpoint brief singles out: picking one of a dual-employed
--                   driver's companies would hand real authority to whichever
--                   one the migration guessed. The row is preserved in full, it
--                   authorizes nothing anywhere, and an administrator re-grants
--                   it per organization. Detectable by query, not silent.
--   malformed    -> a `branch` grant with no branch. Today `authorize()` reads
--                   a NULL scopeRef as unconfined, so these currently authorize
--                   everywhere. Quarantined too.
--
-- REVOKED rows are history and are left exactly as written. Nothing reads them
-- for authorization — `revokedAt IS NULL` is on every live query — and
-- rewriting a historical record to a vocabulary that did not exist when it was
-- written would make "what could this person reach in March" unanswerable.
--
-- Nothing is dropped, reset, recreated or deleted. The only column removed is
-- `activeGrantKey`, which is DERIVED: the database recomputes it from the row.

ALTER TABLE `userRoleAssignments`
  MODIFY COLUMN `scopeType`
    enum('global','organization','branch','unscoped_legacy')
    NOT NULL DEFAULT 'global';
--> statement-breakpoint

ALTER TABLE `userRoleAssignments`
  ADD COLUMN `orgRef` varchar(40) NULL AFTER `scopeType`;
--> statement-breakpoint

-- One grant per (user, role, organization, branch) rather than per (user, role,
-- branch).
--
-- This is load-bearing for the whole checkpoint: 0021's key is
-- CONCAT(userId, role, scopeRef), so `driver @ ABC` and `driver @ XYZ` collide
-- on it and the second insert fails. The multi-organization case B23.1 exists
-- to support was, until this line, prevented by a uniqueness constraint.
--
-- Dropped and re-added rather than modified in place, following 0021's own
-- precedent. The column is generated, so there is no data to lose.
DROP INDEX `userRoleAssignments_activeGrantKey_unique` ON `userRoleAssignments`;
--> statement-breakpoint

ALTER TABLE `userRoleAssignments` DROP COLUMN `activeGrantKey`;
--> statement-breakpoint

ALTER TABLE `userRoleAssignments`
  ADD COLUMN `activeGrantKey` varchar(220)
    AS (CASE WHEN `revokedAt` IS NULL
             THEN CONCAT(`userId`, ':', `role`, ':', COALESCE(`orgRef`, '*'), ':', COALESCE(`scopeRef`, '*'))
             ELSE NULL END) PERSISTENT;
--> statement-breakpoint

CREATE UNIQUE INDEX `userRoleAssignments_activeGrantKey_unique`
  ON `userRoleAssignments` (`activeGrantKey`);
--> statement-breakpoint

-- The scoped read: "which grants does this user hold in this organization".
CREATE INDEX `userRoleAssignments_user_org_idx`
  ON `userRoleAssignments` (`userId`, `orgRef`);
--> statement-breakpoint

-- ---- Backfill, in dependency order -------------------------------------

-- 1. Quarantine first, so a later statement cannot attribute one of these.
--    More than one live membership: no organization can be inferred without
--    guessing which company's authority to hand over.
UPDATE `userRoleAssignments` ra
SET ra.`scopeType` = 'unscoped_legacy', ra.`orgRef` = NULL
WHERE ra.`revokedAt` IS NULL
  AND (
    SELECT COUNT(DISTINCT om.`orgRef`)
    FROM `organizationMemberships` om
    JOIN `organizations` o ON o.`orgRef` = om.`orgRef`
    WHERE om.`userId` = ra.`userId`
      AND om.`status` = 'active'
      AND o.`status` = 'active'
      AND om.`effectiveFrom` <= NOW()
      AND (om.`effectiveTo` IS NULL OR om.`effectiveTo` > NOW())
  ) > 1;
--> statement-breakpoint

-- 2. Malformed: a branch grant naming no branch. Reads as unconfined today.
UPDATE `userRoleAssignments`
SET `scopeType` = 'unscoped_legacy', `orgRef` = NULL
WHERE `revokedAt` IS NULL
  AND `scopeType` = 'branch'
  AND `scopeRef` IS NULL;
--> statement-breakpoint

-- 3. Exactly one live membership: deterministic attribution.
UPDATE `userRoleAssignments` ra
SET ra.`orgRef` = (
      SELECT MIN(om.`orgRef`)
      FROM `organizationMemberships` om
      JOIN `organizations` o ON o.`orgRef` = om.`orgRef`
      WHERE om.`userId` = ra.`userId`
        AND om.`status` = 'active'
        AND o.`status` = 'active'
        AND om.`effectiveFrom` <= NOW()
        AND (om.`effectiveTo` IS NULL OR om.`effectiveTo` > NOW())
    ),
    ra.`scopeType` = CASE WHEN ra.`scopeType` = 'branch' THEN 'branch' ELSE 'organization' END
WHERE ra.`revokedAt` IS NULL
  AND ra.`scopeType` IN ('global', 'branch')
  AND (
    SELECT COUNT(DISTINCT om.`orgRef`)
    FROM `organizationMemberships` om
    JOIN `organizations` o ON o.`orgRef` = om.`orgRef`
    WHERE om.`userId` = ra.`userId`
      AND om.`status` = 'active'
      AND o.`status` = 'active'
      AND om.`effectiveFrom` <= NOW()
      AND (om.`effectiveTo` IS NULL OR om.`effectiveTo` > NOW())
  ) = 1;
--> statement-breakpoint

-- 4. No live membership: the historical single tenant, which is what
--    `resolveActingScope` already resolves these callers to. Matches
--    SINGLE_TENANT_ID in server/_core/actingScope.ts.
UPDATE `userRoleAssignments`
SET `orgRef` = 'default',
    `scopeType` = CASE WHEN `scopeType` = 'branch' THEN 'branch' ELSE 'organization' END
WHERE `revokedAt` IS NULL
  AND `scopeType` IN ('global', 'branch')
  AND `orgRef` IS NULL;
--> statement-breakpoint

-- ---- Make the invalid states hard to represent -------------------------
--
-- Live rows only. A revoked row was written under the old vocabulary and is
-- not re-interpreted, so the invariant is stated for the rows that can still
-- authorize anything.
ALTER TABLE `userRoleAssignments`
  ADD CONSTRAINT `userRoleAssignments_scope_shape`
  CHECK (
    `revokedAt` IS NOT NULL
    OR (`scopeType` = 'global'          AND `orgRef` IS NULL     AND `scopeRef` IS NULL)
    OR (`scopeType` = 'organization'    AND `orgRef` IS NOT NULL AND `scopeRef` IS NULL)
    OR (`scopeType` = 'branch'          AND `orgRef` IS NOT NULL AND `scopeRef` IS NOT NULL)
    OR (`scopeType` = 'unscoped_legacy' AND `orgRef` IS NULL)
  );
