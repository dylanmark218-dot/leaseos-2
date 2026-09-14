-- v22.20 — 0105: a real question is proved, not claimed.
--
-- `origin` arrived from the request. A curator could type a question while
-- reading the passage, label it `real_question`, and the grade would treat it
-- as evidence of how people actually ask — which is the one thing the field
-- exists to establish. The same shape as a caller asserting its own authority,
-- and it was sitting in the instrument meant to decide whether to buy a
-- semantic retriever.
--
-- Now a real-question probe is built from a recorded ask: the server copies the
-- question somebody actually typed and records which ask it came from. Nobody
-- can hand-write one.

ALTER TABLE `retrievalProbes`
  ADD COLUMN `originQueryRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `retrievalProbes_origin_query` ON `retrievalProbes` (`originQueryRef`);
