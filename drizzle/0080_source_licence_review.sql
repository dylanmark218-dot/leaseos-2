-- v22.20 — clearing a data source is an act, performed by a person.
--
-- Ten sources sit unverified. Until now the only ways to make one verified were
-- to seed it that way or to run UPDATE by hand, which meant a licence review
-- left no trace of who did it, when, or what they read. A source that governs
-- whether the company may commercially use a government dataset deserves the
-- same treatment as every other fact in this system: a named person, a
-- timestamp, and the evidence they relied on.
--
-- The attribution barrier stays and is now enforced in code rather than by
-- seeding convention: a source cannot be cleared while `attributionText` is
-- null, because somebody has to have recorded what the publisher requires shown.

ALTER TABLE `externalDataSources`
  ADD COLUMN `reviewedByUserId` int,
  ADD COLUMN `reviewedAt` timestamp NULL,
  ADD COLUMN `reviewNote` varchar(1000);
