-- v22.22 — 0126: the transcribe-once guard for 0125's sheet registry.
-- Compound bodies: this file contains trigger DDL and nothing else (the runner
-- wraps a file containing `^BEGIN$` in DELIMITER as a whole, so tables live in 0125).

-- A sheet that has been filed is filed once. The state machine in sheetSerial.ts
-- refuses a second scan; this refuses a second transcription even if it arrives
-- around the router.
CREATE TRIGGER `academyAssessmentSheets_transcribe_once`
BEFORE UPDATE ON `academyAssessmentSheets`
FOR EACH ROW
BEGIN
  IF OLD.`transcribedAt` IS NOT NULL AND (NEW.`transcribedAt` <> OLD.`transcribedAt` OR NEW.`transcriptionRef` <> OLD.`transcriptionRef`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This sheet was already transcribed; a physical sheet is filed exactly once';
  END IF;
END;
