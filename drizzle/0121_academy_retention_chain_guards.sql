-- Compound bodies: this file contains trigger DDL and nothing else.

CREATE TRIGGER `academyCourseVersions_retention_guard`
BEFORE DELETE ON `academyCourseVersions`
FOR EACH ROW
BEGIN
  DECLARE live INT DEFAULT 0;
  SELECT COUNT(*) INTO live FROM `academyCertificates`
   WHERE `courseVersionId` = OLD.`id`
     AND `retentionUntil` IS NOT NULL AND `retentionUntil` > CURRENT_TIMESTAMP;
  IF live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'course version is named by a certificate still within its retention period';
  END IF;
END;

CREATE TRIGGER `academyModules_retention_guard`
BEFORE DELETE ON `academyModules`
FOR EACH ROW
BEGIN
  DECLARE live INT DEFAULT 0;
  SELECT COUNT(*) INTO live FROM `academyCertificates`
   WHERE `courseVersionId` = OLD.`courseVersionId`
     AND `retentionUntil` IS NOT NULL AND `retentionUntil` > CURRENT_TIMESTAMP;
  IF live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'module belongs to a course version named by a certificate still within its retention period';
  END IF;
END;

-- Two hops: a content block is the training material itself, reached through its
-- module. This is what s.6.7's "description of the training material used" is
-- produced from.
CREATE TRIGGER `academyContentBlocks_retention_guard`
BEFORE DELETE ON `academyContentBlocks`
FOR EACH ROW
BEGIN
  DECLARE live INT DEFAULT 0;
  SELECT COUNT(*) INTO live
    FROM `academyModules` m
    JOIN `academyCertificates` c ON c.`courseVersionId` = m.`courseVersionId`
   WHERE m.`id` = OLD.`moduleId`
     AND c.`retentionUntil` IS NOT NULL AND c.`retentionUntil` > CURRENT_TIMESTAMP;
  IF live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'training material is required to answer an inspector request for a certificate still within its retention period';
  END IF;
END;

CREATE TRIGGER `academyAssessmentAttempts_retention_guard`
BEFORE DELETE ON `academyAssessmentAttempts`
FOR EACH ROW
BEGIN
  DECLARE live INT DEFAULT 0;
  SELECT COUNT(*) INTO live FROM `academyCertificates`
   WHERE `assignmentId` = OLD.`assignmentId`
     AND `retentionUntil` IS NOT NULL AND `retentionUntil` > CURRENT_TIMESTAMP;
  IF live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'assessment is the record of training for a certificate still within its retention period';
  END IF;
END;

CREATE TRIGGER `academyStatementsOfExperience_retention_guard`
BEFORE DELETE ON `academyStatementsOfExperience`
FOR EACH ROW
BEGIN
  DECLARE live INT DEFAULT 0;
  SELECT COUNT(*) INTO live FROM `academyCertificates`
   WHERE `statementOfExperienceId` = OLD.`id`
     AND `retentionUntil` IS NOT NULL AND `retentionUntil` > CURRENT_TIMESTAMP;
  IF live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'statement of experience supports a certificate still within its retention period';
  END IF;
END;
