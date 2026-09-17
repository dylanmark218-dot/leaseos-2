-- v22.24 — 0130 (P3.1): a sealed manifest is not silently rewritten.
-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- Once sealed (the truck departed origin), the parties, job, material and
-- facilities may change only through an amendment, which bumps
-- amendmentCount in the same statement that applies the change. A write that
-- alters any of them without bumping the count is a silent rewrite, and the
-- database refuses it even when it arrives around the router.

CREATE TRIGGER `manifests_seal_guard`
BEFORE UPDATE ON `manifests`
FOR EACH ROW
BEGIN
  IF OLD.`sealedAt` IS NOT NULL AND NEW.`amendmentCount` = OLD.`amendmentCount` AND (
       NOT (NEW.`operatorId` <=> OLD.`operatorId`) OR NOT (NEW.`unitId` <=> OLD.`unitId`) OR NOT (NEW.`trailerUnitId` <=> OLD.`trailerUnitId`)
    OR NOT (NEW.`jobId` <=> OLD.`jobId`) OR NOT (NEW.`tripId` <=> OLD.`tripId`) OR NOT (NEW.`loadId` <=> OLD.`loadId`)
    OR NOT (NEW.`material` <=> OLD.`material`) OR NOT (NEW.`unNumber` <=> OLD.`unNumber`)
    OR NOT (NEW.`originFacilityId` <=> OLD.`originFacilityId`) OR NOT (NEW.`destinationFacilityId` <=> OLD.`destinationFacilityId`)
    OR NOT (NEW.`driver` <=> OLD.`driver`) OR NOT (NEW.`trailer` <=> OLD.`trailer`) OR NOT (NEW.`route` <=> OLD.`route`) OR NOT (NEW.`facility` <=> OLD.`facility`)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Manifest is sealed; changes to its parties, job, material or facilities require an amendment';
  END IF;
END;
