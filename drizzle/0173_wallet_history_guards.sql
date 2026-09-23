-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- 0173 — a verified credential is history, not a draft.
--
-- Renewal supersedes; it never deletes or rewrites. Once a holding has been
-- verified, the facts somebody checked (who, which code, which dates, which
-- number, who verified it and when) are frozen. The only change allowed is the
-- one renewal makes: verified -> superseded, with the pointer to the holding
-- that replaced it. A rejected or superseded holding does not change at all.
-- Deleting any holding that was ever verified, rejected or superseded is
-- refused. A handoff is coordination history and is never deleted either.

CREATE TRIGGER `workerQualifications_history_update_guard`
BEFORE UPDATE ON `workerQualifications`
FOR EACH ROW
BEGIN
  IF OLD.`verificationState` IN ('rejected', 'superseded') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a rejected or superseded credential is history and cannot be changed';
  END IF;
  IF OLD.`verificationState` = 'verified' THEN
    IF NOT (NEW.`userId` <=> OLD.`userId`) OR NOT (NEW.`code` <=> OLD.`code`) OR NOT (NEW.`issuedAt` <=> OLD.`issuedAt`)
       OR NOT (NEW.`expiresAt` <=> OLD.`expiresAt`) OR NOT (NEW.`certificateNumber` <=> OLD.`certificateNumber`)
       OR NOT (NEW.`verifiedByUserId` <=> OLD.`verifiedByUserId`) OR NOT (NEW.`verifiedAt` <=> OLD.`verifiedAt`)
       OR NOT (NEW.`restrictionsJson` <=> OLD.`restrictionsJson`) OR NOT (NEW.`endorsementsJson` <=> OLD.`endorsementsJson`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verified credential facts are immutable; record a renewal that supersedes it';
    END IF;
    IF NEW.`verificationState` NOT IN ('verified', 'superseded') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a verified credential may only be superseded';
    END IF;
    IF NEW.`verificationState` = 'superseded' AND NEW.`supersededByHoldingRef` IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'superseding a credential requires the holding that replaces it';
    END IF;
  END IF;
END;

CREATE TRIGGER `workerQualifications_history_delete_guard`
BEFORE DELETE ON `workerQualifications`
FOR EACH ROW
BEGIN
  IF OLD.`verificationState` IN ('verified', 'rejected', 'superseded') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a credential that was verified, rejected or superseded is history and cannot be deleted';
  END IF;
END;

CREATE TRIGGER `externalTrainingHandoffs_delete_guard`
BEFORE DELETE ON `externalTrainingHandoffs`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a training handoff is coordination history and cannot be deleted; cancel it instead';
END;
