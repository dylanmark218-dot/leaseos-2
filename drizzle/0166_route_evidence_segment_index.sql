-- v23.14 — 0166: the index the approval refusal reads on.
--
-- `spatial.approveRoute` now consults stored evidence for a failing check before approving, which
-- filters `routeEvidenceEntries` by segment and result. The table had indexes on `routeProfileId`
-- and `tripId` only, so that query was a scan.
--
-- Irrelevant at the twelve rows a test database holds, and not irrelevant later: this table gains a
-- row per segment per check per evaluation, so it is one of the fastest-growing tables in the
-- system and the query sits in front of every route approval.
CREATE INDEX `ree_segment_result` ON `routeEvidenceEntries` (`segmentId`, `result`);
