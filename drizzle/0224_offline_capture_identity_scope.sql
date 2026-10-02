-- 0224 — the offline capture reference stops being an installation-wide namespace.
--
-- `evidenceRecords.clientCaptureRef` is a string the DEVICE picks (0043), and the
-- upload path uses it to decide "you already sent me this, here it is". Backed by
-- a GLOBAL unique index, that made a namespace one company could exhaust, and —
-- because it is a dedup rule — a rule that silently merged two companies' records
-- when their devices happened to agree on a string. On a collision the caller was
-- handed another organization's evidence id and storage key while their own
-- upload was discarded unstored.
--
-- The correct identity is relative to the CAPTURING USER, not the installation
-- and not even the organization: idempotency here means one handset retrying, and
-- two people in one company carry two handsets whose counters are unrelated. The
-- runtime contract already said as much — a capture reference is documented as
-- `${deviceRef}:${localId}` — but the server never enforced it, and a server must
-- not depend on clients being well behaved.
--
-- A generated column rather than a plain composite, because MySQL/MariaDB treat
-- NULLs as DISTINCT inside a unique index: a composite over the nullable
-- `capturedBy` would place no constraint at all on exactly the rows that carry no
-- user. COALESCE to a sentinel no real id can take.
--
-- No ownership is assigned and nothing is backfilled. `capturedBy` is an existing
-- column with existing values; rows where it is NULL share the `-1` bucket, which
-- is STRICTER than the NULLs-are-distinct rule they had before, never looser.

ALTER TABLE `evidenceRecords` DROP INDEX `evidenceRecords_clientCaptureRef_unique`;
--> statement-breakpoint
ALTER TABLE `evidenceRecords`
  ADD COLUMN `captureOwnerKey` INT AS (COALESCE(`capturedBy`, -1)) STORED;
--> statement-breakpoint
CREATE UNIQUE INDEX `evidenceRecords_captureOwner_clientCaptureRef_uq`
  ON `evidenceRecords` (`captureOwnerKey`, `clientCaptureRef`);
