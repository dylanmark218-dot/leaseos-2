-- v23.09 — 0164: a graph edge carries the source that produced it.
--
-- `roadGraphEdges` recorded geometry, topology and an `accessRoadObjectId`, and nothing about where
-- the road came from. So the conversion from a computed path to evaluator input had nothing to read
-- and wrote literals instead: every edge reached the evaluator labelled
-- `ats_road_allowance` / "Access and Facility Roads", whatever had produced it.
--
-- That was true while Alberta's access-road layer was the only source. With an OpenStreetMap
-- extract arriving it becomes a lie with consequences: OSM's surface claims would be presented to
-- the evaluator as provincial statements, and `roadAsSegment` stamped them `authority_confirmed` —
-- which is exactly what turns a REVIEW into a PASS on a road nobody verified.
--
-- Backfilled to the ATS values because that is what every existing edge actually is: the only
-- importer that has ever written this table is the Alberta access-roads import. This is a statement
-- of fact about the rows, not a default.
ALTER TABLE `roadGraphEdges`
  ADD COLUMN `sourceKey` varchar(64) NULL,
  ADD COLUMN `sourceLayer` varchar(160) NULL,
  ADD COLUMN `sourceFeatureId` varchar(96) NULL,
  ADD COLUMN `sourceVersion` varchar(96) NULL;
--> statement-breakpoint
UPDATE `roadGraphEdges`
   SET `sourceKey` = 'ats_road_allowance',
       `sourceLayer` = 'Access and Facility Roads',
       `sourceFeatureId` = CAST(`accessRoadObjectId` AS CHAR)
 WHERE `sourceKey` IS NULL;
--> statement-breakpoint
CREATE INDEX `rge_source` ON `roadGraphEdges` (`sourceKey`, `sourceFeatureId`);
