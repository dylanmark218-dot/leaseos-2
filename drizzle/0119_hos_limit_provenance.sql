-- v22.21 — 0119 (recovered from chat 4 checkpoint 0090): where a regulatory figure came from.
--
-- `hosRuleLimits` already records that somebody verified a limit and when. It
-- does not record *what they read*. `sourceSection` is free text, so "s. 12" on
-- its own does not say which instrument, which version, or which jurisdiction's
-- s. 12 — and a figure whose origin cannot be produced is a figure that cannot
-- be defended in an audit.
--
-- Two nullable columns, because every existing row predates them and none can
-- be backfilled honestly. A null here means the same thing it means everywhere
-- else in LeaseOS: nobody has established this, rather than there being nothing
-- to establish.
--
-- Deliberately NOT a foreign key to knowledgeVersions. A limit may be verified
-- by a person reading the official statute directly, which is the ordinary case
-- and the one the 511 assessment points at: build the deterministic rules from
-- the underlying legislation rather than from a course that cannot be copied.
-- Requiring an ingested document would force ingestion that is not permitted.

ALTER TABLE `hosRuleLimits` ADD COLUMN `establishedByVersionRef` varchar(64);
ALTER TABLE `hosRuleLimits` ADD COLUMN `citationUrl` varchar(1000);
