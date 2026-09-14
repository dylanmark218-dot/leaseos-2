-- v22.20 — 0106: what a recall figure is a figure about.
--
-- The corpus hash made a measurement identify its documents. It still did not
-- identify the thing being measured. When MATCH retrieval becomes hybrid
-- lexical-plus-embedding retrieval the corpus can stay byte-for-byte identical
-- while the retriever changes completely, and the old measurement would go on
-- looking applicable — certifying the new implementation with the old one's
-- recall.
--
-- Depth belongs to identity for the same reason: recall@20 is a real number
-- about a product that shows twenty. An answer showing eight cannot borrow it.
--
-- So applicability is corpus + implementation + depth, and any one of them
-- moving makes the figure about something else.

ALTER TABLE `retrievalMeasurements`
  ADD COLUMN `retrieverKey` varchar(60) NOT NULL DEFAULT 'unknown',
  ADD COLUMN `retrieverVersion` varchar(30) NOT NULL DEFAULT 'unknown';
--> statement-breakpoint

-- One active probe per recorded ask. Labelling the same question five times
-- produced five "real questions" from one person asking once, which weights the
-- calibration set toward whatever a curator happened to revisit.
CREATE UNIQUE INDEX `retrievalProbes_one_per_ask` ON `retrievalProbes` (`originQueryRef`);
