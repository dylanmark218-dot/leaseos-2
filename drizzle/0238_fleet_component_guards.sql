-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- 0238 — a component relation is history: what was attached, when, by whom, never changes; it is
-- detached once, and a detached relation is never changed again; nothing is deleted. A unit's lifecycle
-- is written only by the portfolio's own act, which records who and why: a status that changes with no
-- actor is refused.

CREATE TRIGGER `unitComponents_installation_immutable`
BEFORE UPDATE ON `unitComponents`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`componentRef` <=> OLD.`componentRef`) OR NOT (NEW.`orgRef` <=> OLD.`orgRef`)
     OR NOT (NEW.`parentUnitId` <=> OLD.`parentUnitId`) OR NOT (NEW.`childUnitId` <=> OLD.`childUnitId`)
     OR NOT (NEW.`relationship` <=> OLD.`relationship`) OR NOT (NEW.`installedAt` <=> OLD.`installedAt`)
     OR NOT (NEW.`installedByUserId` <=> OLD.`installedByUserId`) OR NOT (NEW.`installWorkOrderId` <=> OLD.`installWorkOrderId`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a component installation is never edited: detach it and attach another';
  END IF;
  IF OLD.`removedAt` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a detached component relation is history and is never changed';
  END IF;
END;

CREATE TRIGGER `unitComponents_no_delete`
BEFORE DELETE ON `unitComponents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a component relation is detached, never deleted';
END;

CREATE TRIGGER `units_lifecycle_needs_actor`
BEFORE UPDATE ON `units`
FOR EACH ROW
BEGIN
  -- A change carries its own stamp: actor, time and reason present, and at least one of them new. A raw
  -- UPDATE of the status alone leaves all three as they were and is refused.
  IF NOT (NEW.`lifecycleStatus` <=> OLD.`lifecycleStatus`)
     AND (NEW.`lifecycleChangedByUserId` IS NULL OR NEW.`lifecycleChangedAt` IS NULL OR NEW.`lifecycleReason` IS NULL
          OR (NEW.`lifecycleChangedAt` <=> OLD.`lifecycleChangedAt` AND NEW.`lifecycleChangedByUserId` <=> OLD.`lifecycleChangedByUserId`
              AND NEW.`lifecycleReason` <=> OLD.`lifecycleReason`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a lifecycle change records who, when and why';
  END IF;
END;
