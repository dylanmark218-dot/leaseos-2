-- v23.17 — 0167: an evaluation gets an identity, so an approval can say which one it approved.
--
-- `routeApprovals` stores what was known at approval time as a summary: coverage counts per axis,
-- the dependency fingerprint, the segment list. That satisfies "a later increase to 60% must not
-- rewrite what was known" at the level of the numbers.
--
-- What it cannot do is produce the evidence behind those numbers. `routeEvidenceEntries` carries
-- source, version, verifiedAt and confidence for every check on every segment — the actual answer
-- to "why was weight 13% verified" — and it is written at EVALUATION time, tagged only with
-- tripId, jobId and segment. A trip evaluated three times leaves three sets of rows that no column
-- distinguishes, so "the evidence this approval rests on" has no answer.
--
-- The fix is identity rather than policy: each evaluation mints an `evaluationRef`, every evidence
-- row it produces carries it, and an approval records the one it was made from. Re-evaluating
-- afterwards writes a new set under a new ref and leaves the approved set untouched — which is the
-- same reasoning as `0159` storing an axle determination instead of re-deriving it.
ALTER TABLE `routeEvidenceEntries`
  ADD COLUMN `evaluationRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `ree_evaluation` ON `routeEvidenceEntries` (`evaluationRef`);
--> statement-breakpoint
ALTER TABLE `routeApprovals`
  ADD COLUMN `evaluationRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `ra_evaluation` ON `routeApprovals` (`evaluationRef`);
