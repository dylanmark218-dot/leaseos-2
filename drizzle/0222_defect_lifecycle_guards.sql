-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- 0222 — what the defect lifecycle records cannot be rewritten, by the application or by hand.
--
-- maintenanceDefectEvents: append-only. workOrderTasks: never deleted, and a finished task (done or
-- not_required) is history — its outcome, findings and who finished it never change. inspections: a
-- return-to-service inspection is the second person's signature on the repair; it is never edited or
-- deleted, and no other inspection can be turned into one.

CREATE TRIGGER `maintenanceDefectEvents_no_update`
BEFORE UPDATE ON `maintenanceDefectEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'maintenanceDefectEvents is append-only';
END;

CREATE TRIGGER `maintenanceDefectEvents_no_delete`
BEFORE DELETE ON `maintenanceDefectEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'maintenanceDefectEvents is append-only';
END;

CREATE TRIGGER `workOrderTasks_finished_is_history`
BEFORE UPDATE ON `workOrderTasks`
FOR EACH ROW
BEGIN
  IF OLD.`status` IN ('done', 'not_required') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a finished work-order task is history';
  END IF;
  IF NOT (NEW.`workOrderId` <=> OLD.`workOrderId`) OR NOT (NEW.`unitId` <=> OLD.`unitId`) OR NOT (NEW.`taskRef` <=> OLD.`taskRef`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a work-order task never moves to another work order';
  END IF;
END;

CREATE TRIGGER `workOrderTasks_no_delete`
BEFORE DELETE ON `workOrderTasks`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a work-order task is never deleted';
END;

CREATE TRIGGER `inspections_return_to_service_immutable`
BEFORE UPDATE ON `inspections`
FOR EACH ROW
BEGIN
  IF OLD.`type` = 'return_to_service' OR NEW.`type` = 'return_to_service' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a return-to-service inspection is never edited';
  END IF;
END;

CREATE TRIGGER `inspections_return_to_service_no_delete`
BEFORE DELETE ON `inspections`
FOR EACH ROW
BEGIN
  IF OLD.`type` = 'return_to_service' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a return-to-service inspection is never deleted';
  END IF;
END;
