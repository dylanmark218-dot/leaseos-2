-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- 0201 — what the portfolio records cannot be rewritten, by the application or by hand.
--
-- fleetPortfolioEvents: append-only. unitMeterReadings: what was observed — unit, meter, value, time,
-- source, who entered it — never changes; only the verification decision may be written, once, from
-- unverified. unitHolds: a hold's placement never changes; it is released once, from active, and a
-- released hold is never reactivated. Nothing is deleted from any of the three.

CREATE TRIGGER `fleetPortfolioEvents_no_update`
BEFORE UPDATE ON `fleetPortfolioEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fleetPortfolioEvents is append-only';
END;

CREATE TRIGGER `fleetPortfolioEvents_no_delete`
BEFORE DELETE ON `fleetPortfolioEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fleetPortfolioEvents is append-only';
END;

CREATE TRIGGER `unitMeterReadings_observation_immutable`
BEFORE UPDATE ON `unitMeterReadings`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`readingRef` <=> OLD.`readingRef`) OR NOT (NEW.`unitId` <=> OLD.`unitId`)
     OR NOT (NEW.`meterType` <=> OLD.`meterType`) OR NOT (NEW.`reading` <=> OLD.`reading`)
     OR NOT (NEW.`recordedAt` <=> OLD.`recordedAt`) OR NOT (NEW.`source` <=> OLD.`source`)
     OR NOT (NEW.`sourceRef` <=> OLD.`sourceRef`) OR NOT (NEW.`enteredByUserId` <=> OLD.`enteredByUserId`)
     OR NOT (NEW.`orgRef` <=> OLD.`orgRef`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a meter reading is evidence: what was observed is never edited';
  END IF;
  IF NOT (NEW.`verificationStatus` <=> OLD.`verificationStatus`) AND OLD.`verificationStatus` <> 'unverified' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a meter reading is verified or rejected once';
  END IF;
END;

CREATE TRIGGER `unitMeterReadings_no_delete`
BEFORE DELETE ON `unitMeterReadings`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a meter reading is evidence and is never deleted';
END;

CREATE TRIGGER `unitHolds_placement_immutable`
BEFORE UPDATE ON `unitHolds`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`holdRef` <=> OLD.`holdRef`) OR NOT (NEW.`orgRef` <=> OLD.`orgRef`) OR NOT (NEW.`unitId` <=> OLD.`unitId`)
     OR NOT (NEW.`holdType` <=> OLD.`holdType`) OR NOT (NEW.`dispatchEffect` <=> OLD.`dispatchEffect`)
     OR NOT (NEW.`reason` <=> OLD.`reason`) OR NOT (NEW.`sourceKind` <=> OLD.`sourceKind`)
     OR NOT (NEW.`sourceRef` <=> OLD.`sourceRef`) OR NOT (NEW.`evidenceRecordId` <=> OLD.`evidenceRecordId`)
     OR NOT (NEW.`placedByUserId` <=> OLD.`placedByUserId`) OR NOT (NEW.`placedByRole` <=> OLD.`placedByRole`)
     OR NOT (NEW.`placedAt` <=> OLD.`placedAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a hold placement is never edited: release it and place another';
  END IF;
  IF OLD.`status` = 'released' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a released hold is history and is never changed';
  END IF;
END;

CREATE TRIGGER `unitHolds_no_delete`
BEFORE DELETE ON `unitHolds`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a hold is released, never deleted';
END;
