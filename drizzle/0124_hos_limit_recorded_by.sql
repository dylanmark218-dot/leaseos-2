-- v22.22 — 0124: who recorded a candidate figure, so a second person verifies it.
--
-- `profileVerify` already carries the rule "the person who recorded a profile
-- does not verify it — a second person does". `limitPromote` (0093, recovered
-- as 0120) had no equivalent: the same person could seed a candidate and then
-- promote it. Chat 4's 0093B checkpoint named the gap; this closes it.
--
-- Nullable, because every existing row predates it and the seeds are recorded by
-- the system rather than by a person. A null means "nobody in particular", and
-- the separation-of-duties check only bites when a named person recorded it.

ALTER TABLE `hosRuleLimits` ADD COLUMN `recordedByUserId` int NULL;
