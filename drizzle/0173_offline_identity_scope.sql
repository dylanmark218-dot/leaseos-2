-- 0173 — the two identifiers a DEVICE chooses stop being installation-wide.
--
-- 0172 made a minted number tenant-relative. These two are the same problem
-- arriving from the other direction: they are not minted by the server at all,
-- they are strings an offline client picks and sends, and they were each backed
-- by a global unique index. That made a namespace one company could exhaust,
-- and — because both are used as "is this the same thing I already have?" —
-- a rule that silently merged two companies' records when their devices
-- happened to agree on a string.
--
--   evidenceRecords.clientCaptureRef  the device's capture reference, used to
--                                     make an offline upload idempotent
--   syncPackages.packageRef           the device's package reference
--
-- The correct identity in both cases is relative to the DEVICE that chose it,
-- not to the installation and not even to the organization: two people in one
-- company carry two handsets, and each handset's counter is its own. The nonce
-- table has had this right since it was created — `(fieldDeviceId, nonce)` —
-- and this migration brings the other two into line with it.
--
-- Generated columns rather than plain composites, for the reason 0172 records:
-- MySQL treats NULLs as DISTINCT inside a unique index, so a composite over a
-- nullable owner column would place no constraint at all on the rows that
-- matter most. COALESCE to a sentinel no real id can take.
--
-- No backfill of ownership here, and none is needed: neither column is being
-- given an owner it did not already have. `capturedBy` and `fieldDeviceId` are
-- existing columns with existing values, and rows where they are NULL keep
-- their historical behaviour — they share the `-1` bucket, which is STRICTER
-- than the NULLs-are-distinct rule they had before, never looser.

-- 1. The offline capture reference: unique per capturing user, not per installation.
ALTER TABLE `evidenceRecords` DROP INDEX `evidenceRecords_clientCaptureRef_unique`;
--> statement-breakpoint
ALTER TABLE `evidenceRecords`
  ADD COLUMN `captureOwnerKey` INT AS (COALESCE(`capturedBy`, -1)) STORED;
--> statement-breakpoint
CREATE UNIQUE INDEX `evidenceRecords_captureOwner_clientCaptureRef_uq`
  ON `evidenceRecords` (`captureOwnerKey`, `clientCaptureRef`);
--> statement-breakpoint

-- 2. The sync package reference: unique per device, as the nonce already is.
ALTER TABLE `syncPackages` DROP INDEX `syncPackages_packageRef_unique`;
--> statement-breakpoint
ALTER TABLE `syncPackages`
  ADD COLUMN `deviceKey` INT AS (COALESCE(`fieldDeviceId`, -1)) STORED;
--> statement-breakpoint
CREATE UNIQUE INDEX `syncPackages_device_packageRef_uq`
  ON `syncPackages` (`deviceKey`, `packageRef`);
