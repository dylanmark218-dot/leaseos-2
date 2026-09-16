-- v22.23 (planned) — 0125: renumbered from B28h sql/0089_widget_dashboards.sql; NOT in drizzle/ until the B28 reconciliation checkpoint applies it.

-- B24 — 0089: boards a person arranged.
--
-- MIGRATION SLOT: 0089 is the next free number as of the `v22_16-to-0088`
-- worktree diff, the newest artifact available off-branch. Confirm against the
-- real `drizzle/` directory before applying; if it is taken this is a file
-- rename and a journal entry, nothing else. Do not renumber anything existing.
--
-- Three tables were dropped in B23 (definitions, role permissions, preferences);
-- the reasoning is in LEASEOS_B23_WIDGET_ENGINE.md. What changed in B24 is the
-- key structure, because the B23 version had a cross-user takeover in it:
--
--   `layoutRef` was globally unique and `saveLayout` did an
--   INSERT ... ON DUPLICATE KEY UPDATE against it with no ownership check. Any
--   authenticated user supplying another user's `layoutRef` would update that
--   row's name and default flag, delete every item under it, and insert their
--   own. The pure validator compared `actingUserId` to the request body, which
--   is a different question and did not help.
--
-- Two structural changes close it, so the fix does not rest on remembering to
-- write a WHERE clause:
--
--   1. `layoutRef` is unique per (orgRef, userId), not globally. Supplying
--      somebody else's reference now names a row in your own namespace.
--   2. Items hang off the internal `layoutId`, never the external reference,
--      so "delete the items for this ref" is not expressible. Ownership has to
--      be resolved to an id first, and that query has to include the owner.

CREATE TABLE `widgetLayouts` (
  `id` int AUTO_INCREMENT NOT NULL,
  -- External reference. Server-assigned; clients never choose one.
  `layoutRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  -- Part of a layout's identity, not a filter over it: an account that drives
  -- and dispatches arranges two boards, and the driver board must not inherit
  -- dispatcher tiles.
  `roleKey` varchar(64) NOT NULL,
  `deviceClass` enum('phone','tablet','desktop') NOT NULL DEFAULT 'phone',
  `name` varchar(120) NOT NULL,
  `isDefault` boolean NOT NULL DEFAULT false,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `widgetLayouts_id` PRIMARY KEY(`id`),
  -- Scoped, not global. A reference collision across owners is not a collision.
  CONSTRAINT `widgetLayouts_owner_ref` UNIQUE(`orgRef`,`userId`,`layoutRef`)
);
--> statement-breakpoint
CREATE INDEX `widgetLayouts_owner` ON `widgetLayouts` (`orgRef`,`userId`,`roleKey`,`deviceClass`);
--> statement-breakpoint
CREATE TABLE `widgetLayoutItems` (
  `id` int AUTO_INCREMENT NOT NULL,
  -- Internal parent key. Deliberately not `layoutRef`: an item set addressable
  -- by a client-supplied string is an item set deletable by one.
  `layoutId` int NOT NULL,
  `instanceRef` varchar(64) NOT NULL,
  -- Plain varchar, no enum, no FK. A saved layout outlives a registration, and
  -- a widget retired next checkpoint would otherwise block the migration or
  -- vanish silently. `planBoard` validates on read and resolves an
  -- unregistered key to `failed` with the key named.
  `widgetKey` varchar(64) NOT NULL,
  `variant` varchar(32) NOT NULL,
  -- Null means "whatever the caller's current one is", resolved per read.
  `subjectRef` varchar(120),
  `position` int NOT NULL,
  `spanColumns` int NOT NULL DEFAULT 1,
  `spanRows` int NOT NULL DEFAULT 1,
  -- Per-instance settings, validated against the widget's declared
  -- `optionsSchema` on save. JSON because the shape belongs to the widget.
  `options` json,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `widgetLayoutItems_id` PRIMARY KEY(`id`),
  -- Per layout, not global: two boards may both hold a tile called "WI-1".
  CONSTRAINT `widgetLayoutItems_layout_instance` UNIQUE(`layoutId`,`instanceRef`),
  CONSTRAINT `widgetLayoutItems_layout_fk` FOREIGN KEY (`layoutId`)
    REFERENCES `widgetLayouts`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `widgetLayoutItems_layout` ON `widgetLayoutItems` (`layoutId`,`position`);
