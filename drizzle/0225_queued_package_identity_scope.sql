-- 0225 — a queued package reference stops being an installation-wide namespace.
--
-- `syncPackages.packageRef` is a string the CLIENT picks: the device sends it to
-- `sync.receivePackage`, and `records.evidence.queueSend` takes it as
-- `z.string().min(4).max(64)`. Backed by a GLOBAL unique index, it was a
-- namespace one company could exhaust, and — because `createSyncPackage` used it
-- alone as an idempotency key — a rule that answered one organization's queued
-- package to another. The second caller was told their send had already been
-- queued, handed the first one's item count, and had their own package dropped
-- unwritten. The same defect as 0224, reached through a different door.
--
-- Correct identity is relative to the SENDER, and the two writers record the
-- sender differently, each from a value the server resolved rather than one the
-- caller supplied:
--
--   * `records.evidence.queueSend` -> `operatorId`, resolved from the
--     authenticated user. `deviceId` sits in the same request as `packageRef`
--     and is just as unvalidated, so it is no boundary.
--   * `sync.receivePackage` -> `fieldDeviceId`, resolved by a device lookup that
--     is already organization-scoped. It leaves `operatorId` null.
--
-- Generated columns rather than a plain composite, because MySQL/MariaDB treat
-- NULLs as DISTINCT inside a unique index: a composite over the nullable owner
-- columns would place no constraint at all on exactly the rows that carry no
-- owner. COALESCE to a sentinel no real id can take.
--
-- This index is deliberately LOOSER than the one it replaces — that is the
-- point: two senders may now each hold `PKG-1`. Nothing depended on the global
-- rule. The only read keyed on `packageRef` is `createSyncPackage`'s own
-- idempotency lookup, scoped in the same change; replay protection for device
-- pushes is `deviceSyncNonces`, not this index; every other reference to a
-- package is by `syncPackages.id`.
--
-- No ownership is assigned and nothing is backfilled. Both owner columns are
-- existing columns with existing values; rows carrying neither share the
-- `(-1, -1)` bucket, where the old global rule already held them.

ALTER TABLE `syncPackages` DROP INDEX `syncPackages_packageRef_unique`;
--> statement-breakpoint
ALTER TABLE `syncPackages`
  ADD COLUMN `packageOperatorKey` INT AS (COALESCE(`operatorId`, -1)) STORED;
--> statement-breakpoint
ALTER TABLE `syncPackages`
  ADD COLUMN `packageDeviceKey` INT AS (COALESCE(`fieldDeviceId`, -1)) STORED;
--> statement-breakpoint
CREATE UNIQUE INDEX `syncPackages_sender_packageRef_uq`
  ON `syncPackages` (`packageOperatorKey`, `packageDeviceKey`, `packageRef`);
