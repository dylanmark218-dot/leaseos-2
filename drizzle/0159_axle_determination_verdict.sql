-- v22.84 — 0159 (P4.2): the snapshot keeps the determination it was given.
--
-- Everything the verdict rests on is already frozen on the snapshot — source, stability,
-- calibration model, measured-at — except one thing: a calibration model can be invalidated later.
-- Re-deriving the verdict at read time would therefore answer with today's view of that
-- calibration, and a reading that was a legal determination in March would silently stop having
-- been one in June.
--
-- Both facts matter and they are different questions. "Was this a legal determination when it was
-- taken?" is answered by the stored verdict. "Is the calibration behind it still trusted?" is
-- answered by sweeping `calibrationModelId` when a model is invalidated — the same shape as
-- sweeping `authorizedByAssessmentId` when a licence is revoked (0150) and the capability picture
-- on a dispatch check (0152).
ALTER TABLE `loadSenseWeightSnapshots`
  ADD COLUMN `legalDetermination` tinyint(1) NULL,
  ADD COLUMN `legalDeterminationCode` varchar(40) NULL,
  ADD COLUMN `legalDeterminationReason` varchar(500) NULL;
