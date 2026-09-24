-- The dispatch role-type catalog, and the role column staffing always assumed.
--
-- `dispatchRoles.roleCode` needs a vocabulary. An enum would mean a migration every time LeaseOS
-- supports another trucking role; free text is what `jobUnits.role` already is — varchar(100),
-- unvalidated, read by nothing on the server, and meaningless as a result. A catalog table is rows,
-- so it extends without a migration and still refuses a code nobody defined.
--
-- UNIQUENESS. `UNIQUE(orgRef, roleCode)` would NOT protect the global catalog. MariaDB permits
-- unlimited NULLs in a unique index, composite ones included, so three global `LEAD` rows coexist
-- without complaint — demonstrated before this was written, exactly as 0021 demonstrated it for
-- role grants. That migration's fix is reused here verbatim in shape: a PERSISTENT generated column
-- carrying a collision key with COALESCE(orgRef, '*'), and uniqueness on the key rather than on a
-- tuple containing a NULL. Its comment still applies — application-level duplicate checks are not a
-- substitute, because two concurrent writers both pass a read-then-write check.
--
-- The key gives all four properties the catalog needs:
--   global LEAD + global LEAD   → '*:LEAD' twice      → refused
--   ORG-A LEAD + ORG-A LEAD     → 'ORG-A:LEAD' twice  → refused
--   ORG-A LEAD + ORG-B LEAD     → different keys      → allowed
--   global LEAD + ORG-A LEAD    → different keys      → allowed, so tenant-first resolution works
--
-- NULL orgRef. Everywhere else in LeaseOS a NULL orgRef marks the historical single tenant's row.
-- Here it means "every tenant may use this", because a catalog is shared vocabulary rather than an
-- owned record. The consequence is that this table must NOT be read with `orgScopeWhere`, which for
-- a real tenant emits `orgRef = :tenant` and would hide every seeded row; the read is
-- `orgRef IS NULL OR orgRef = :tenant`. server/_core/dispatchRoleCatalog.ts carries the same note.

CREATE TABLE `dispatchRoleTypes` (
	`id` int AUTO_INCREMENT NOT NULL,
	-- NULL = available to every tenant. Non-null = that organization's own definition.
	`orgRef` varchar(64),
	`roleCode` varchar(60) NOT NULL,
	`displayName` varchar(120) NOT NULL,
	`description` varchar(500),
	-- Defaults a new slot copies. Never a live pointer: editing the catalog must not restate what
	-- an existing posting requires.
	`defaultEquipmentClass` varchar(60),
	`defaultTrailerClass` varchar(60),
	`active` boolean NOT NULL DEFAULT true,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dispatchRoleTypes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- Persistent generated column: the collision key. Never written by the application.
ALTER TABLE `dispatchRoleTypes`
  ADD COLUMN `roleTypeKey` varchar(140)
    AS (CONCAT(COALESCE(`orgRef`, '*'), ':', `roleCode`)) PERSISTENT;
--> statement-breakpoint

CREATE UNIQUE INDEX `dispatchRoleTypes_roleTypeKey_unique`
  ON `dispatchRoleTypes` (`roleTypeKey`);
--> statement-breakpoint

CREATE INDEX `dispatchRoleTypes_org_idx` ON `dispatchRoleTypes` (`orgRef`, `active`);
--> statement-breakpoint

-- Staffing already treats every role as required: _core/dispatchTransaction.ts passes
-- `required: true` for every row because the data could not say otherwise, while
-- `assessStaffing` has always distinguished required from optional. DEFAULT true therefore
-- preserves today's behaviour exactly, and no optional history is inferred for existing rows.
ALTER TABLE `dispatchRoles`
  ADD COLUMN `required` boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- Seeded from what the repository evidences, and nothing more. Five from the rig-move sentence
-- above `dispatchRoles` in schema.ts; three from the crew panel the showcase actually renders.
-- VAC_TRUCK, WATER_TRUCK and the rest of the industry are one INSERT each by whoever runs the
-- operation — which is the whole point of a catalog rather than an enum.
INSERT INTO `dispatchRoleTypes` (`orgRef`, `roleCode`, `displayName`, `description`, `createdByUserId`) VALUES
	(NULL, 'LEAD',          'Lead',           'Lead unit on a multi-unit move',      1),
	(NULL, 'WINCH_TRACTOR', 'Winch tractor',  NULL,                                  1),
	(NULL, 'BED_TRUCK',     'Bed truck',      NULL,                                  1),
	(NULL, 'PICKER',        'Picker',         NULL,                                  1),
	(NULL, 'PILOT_VEHICLE', 'Pilot vehicle',  NULL,                                  1),
	(NULL, 'PRIMARY_UNIT',  'Primary unit',   'The unit the job is dispatched on',   1),
	(NULL, 'SUPPORT_UNIT',  'Support unit',   NULL,                                  1),
	(NULL, 'STANDBY',       'Standby',        NULL,                                  1);
