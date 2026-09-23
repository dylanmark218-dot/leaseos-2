-- Compound bodies: this file contains trigger DDL and nothing else.
--
-- 0175 — a decided source is history.
--
-- Once a source version is reviewed (trusted), rejected or superseded, the facts a
-- reviewer looked at — authority, title, jurisdiction, edition, URL, tier and both
-- fingerprints — cannot change. A new edition of a government guide is a new source
-- row that supersedes this one; it is never an edit of this one. A reviewed source may
-- only move to superseded (naming its successor); rejected and superseded are final.
-- Notes and the redistribution confirmation may still be appended.

CREATE TRIGGER `academySourceRecords_history_guard`
BEFORE UPDATE ON `academySourceRecords`
FOR EACH ROW
BEGIN
  IF OLD.`reviewStatus` IN ('reviewed', 'rejected', 'superseded') THEN
    IF NOT (NEW.`authority` <=> OLD.`authority`) OR NOT (NEW.`title` <=> OLD.`title`) OR NOT (NEW.`jurisdiction` <=> OLD.`jurisdiction`)
       OR NOT (NEW.`edition` <=> OLD.`edition`) OR NOT (NEW.`sourceUrl` <=> OLD.`sourceUrl`) OR NOT (NEW.`sourceTier` <=> OLD.`sourceTier`)
       OR NOT (NEW.`snapshotHash` <=> OLD.`snapshotHash`) OR NOT (NEW.`contentHash` <=> OLD.`contentHash`) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a decided source version is immutable; record a new version that supersedes it';
    END IF;
  END IF;
  IF OLD.`reviewStatus` = 'reviewed' AND NEW.`reviewStatus` NOT IN ('reviewed', 'superseded') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a reviewed source may only be superseded';
  END IF;
  IF OLD.`reviewStatus` = 'reviewed' AND NEW.`reviewStatus` = 'superseded' AND NEW.`supersededBySourceRef` IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'superseding a reviewed source requires the source version that replaces it';
  END IF;
  IF OLD.`reviewStatus` IN ('rejected', 'superseded') AND NOT (NEW.`reviewStatus` <=> OLD.`reviewStatus`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a rejected or superseded source is final';
  END IF;
END;

CREATE TRIGGER `academySourceRecords_delete_guard`
BEFORE DELETE ON `academySourceRecords`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a source record is history and cannot be deleted';
END;
