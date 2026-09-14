-- v22.20 — 0104: what corpus a measurement actually describes.
--
-- 0103 recorded the passage count and the newest passage date, and the comment
-- there claimed those identified the corpus. They do not. Superseding a passage
-- or correcting its text changes what retrieval returns while leaving both
-- numbers exactly where they were, so a measurement taken before the change
-- would still look like it described the corpus being searched.
--
-- The hash covers everything retrieval and grounding actually consult: the
-- passage, its text, its revision, its window and its jurisdiction. Two corpora
-- with the same hash return the same answers; two with different hashes are
-- different questions, and a recall figure from one says nothing about the
-- other.

ALTER TABLE `retrievalMeasurements`
  ADD COLUMN `corpusHash` varchar(64) NOT NULL DEFAULT '';
