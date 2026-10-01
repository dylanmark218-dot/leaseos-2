-- 0216 — Sign & Attest, SA1: what "append-only" and "finalized" mean to the database.
-- Compound bodies: this file contains trigger DDL and nothing else (apply-migrations.sh wraps a file
-- whose lines include a bare BEGIN in a DELIMITER block).
--
-- Slot: follows 0215 on this branch (docs/architecture/MIGRATION_COLLISION_REGISTER.md).
--
-- A signature is evidence only if nobody can change what it was a signature of. The service never
-- updates or deletes an event and never edits a finalized revision; the database now refuses both
-- when a write arrives around the service. A finalized revision may still learn which revision
-- superseded it, and nothing else.

CREATE TRIGGER `attestEvents_no_update`
BEFORE UPDATE ON `attestEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Sign & Attest events are append-only';
END;
--> statement-breakpoint
CREATE TRIGGER `attestEvents_no_delete`
BEFORE DELETE ON `attestEvents`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Sign & Attest events are never deleted';
END;
--> statement-breakpoint
CREATE TRIGGER `attestDocumentRevisions_final_guard`
BEFORE UPDATE ON `attestDocumentRevisions`
FOR EACH ROW
BEGIN
  IF OLD.`state` = 'finalized' AND (
       NOT (NEW.`state` <=> OLD.`state`) AND NEW.`state` <> 'superseded'
    OR NOT (NEW.`revisionHash` <=> OLD.`revisionHash`) OR NOT (NEW.`instanceRef` <=> OLD.`instanceRef`)
    OR NOT (NEW.`subjectType` <=> OLD.`subjectType`) OR NOT (NEW.`subjectRef` <=> OLD.`subjectRef`)
    OR NOT (NEW.`revision` <=> OLD.`revision`) OR NOT (NEW.`orgRef` <=> OLD.`orgRef`) OR NOT (NEW.`orgScopeKey` <=> OLD.`orgScopeKey`)
    OR NOT (NEW.`pageCount` <=> OLD.`pageCount`) OR NOT (NEW.`pageGeometryJson` <=> OLD.`pageGeometryJson`)
    OR NOT (NEW.`finalizedAt` <=> OLD.`finalizedAt`) OR NOT (NEW.`finalizedByUserId` <=> OLD.`finalizedByUserId`)
    OR NOT (NEW.`artifactId` <=> OLD.`artifactId`) OR NOT (NEW.`receiptHash` <=> OLD.`receiptHash`) OR NOT (NEW.`eventChainHead` <=> OLD.`eventChainHead`)
    OR NOT (NEW.`supersedesRevisionId` <=> OLD.`supersedesRevisionId`)
    OR NOT (NEW.`openedByUserId` <=> OLD.`openedByUserId`) OR NOT (NEW.`openedByExternalIdentityId` <=> OLD.`openedByExternalIdentityId`) OR NOT (NEW.`openedAt` <=> OLD.`openedAt`)
    OR NOT (NEW.`voidedAt` <=> OLD.`voidedAt`) OR NOT (NEW.`voidedByUserId` <=> OLD.`voidedByUserId`) OR NOT (NEW.`voidReason` <=> OLD.`voidReason`)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A finalized signing revision is immutable; a correction is a superseding revision';
  END IF;
END;
