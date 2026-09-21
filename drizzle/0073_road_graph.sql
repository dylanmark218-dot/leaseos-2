-- v22.16 — The first routing graph, built from imported Alberta road data.
--
-- Alberta's access-road layer is properly noded: across 293 segments in one
-- township, 440 endpoints meet another segment's endpoint exactly and one is
-- a T-junction. So the graph is endpoint-joined, with a snap tolerance for
-- the near-misses, and a build is a recorded artefact with its own reference
-- so a route can name the graph it was computed on — and a route approval's
-- fingerprint can go stale when the graph is rebuilt.

CREATE TABLE `roadGraphBuilds` (
  `id` int AUTO_INCREMENT NOT NULL,
  `buildRef` varchar(64) NOT NULL,
  `label` varchar(220) NOT NULL,
  `minLatitude` double NOT NULL,
  `minLongitude` double NOT NULL,
  `maxLatitude` double NOT NULL,
  `maxLongitude` double NOT NULL,
  `snapToleranceMetres` int NOT NULL,
  `segmentsConsidered` int NOT NULL DEFAULT 0,
  `nodeCount` int NOT NULL DEFAULT 0,
  `edgeCount` int NOT NULL DEFAULT 0,
  `componentCount` int NOT NULL DEFAULT 0,
  `largestComponentEdges` int NOT NULL DEFAULT 0,
  `isolatedEdges` int NOT NULL DEFAULT 0,
  `excludedSurfacesJson` text NOT NULL,
  `sourceRunRefsJson` text NOT NULL,
  `status` enum('building','current','superseded','failed') NOT NULL DEFAULT 'building',
  `failureReason` varchar(400),
  `builtByUserId` int NOT NULL,
  `builtAt` timestamp NOT NULL DEFAULT (now()),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadGraphBuilds_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadGraphBuilds_buildRef_unique` UNIQUE(`buildRef`)
);
--> statement-breakpoint

CREATE TABLE `roadGraphNodes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `buildRef` varchar(64) NOT NULL,
  `nodeKey` varchar(48) NOT NULL,
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `degree` int NOT NULL DEFAULT 0,
  `componentId` int NOT NULL DEFAULT 0,
  CONSTRAINT `roadGraphNodes_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadGraphNodes_build_node_unique` UNIQUE(`buildRef`, `nodeKey`)
);
--> statement-breakpoint
CREATE INDEX `roadGraphNodes_bbox` ON `roadGraphNodes` (`buildRef`, `latitude`, `longitude`);
--> statement-breakpoint

CREATE TABLE `roadGraphEdges` (
  `id` int AUTO_INCREMENT NOT NULL,
  `buildRef` varchar(64) NOT NULL,
  `segmentId` varchar(80) NOT NULL,
  `accessRoadObjectId` int NOT NULL,
  `label` varchar(220) NOT NULL,
  `fromNodeKey` varchar(48) NOT NULL,
  `toNodeKey` varchar(48) NOT NULL,
  `lengthMetres` double NOT NULL,
  `surfaceKind` varchar(20) NOT NULL,
  `featureTypeLabel` varchar(80),
  `componentId` int NOT NULL DEFAULT 0,
  CONSTRAINT `roadGraphEdges_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadGraphEdges_build_segment_unique` UNIQUE(`buildRef`, `segmentId`)
);
--> statement-breakpoint
CREATE INDEX `roadGraphEdges_from` ON `roadGraphEdges` (`buildRef`, `fromNodeKey`);
--> statement-breakpoint
CREATE INDEX `roadGraphEdges_to` ON `roadGraphEdges` (`buildRef`, `toNodeKey`);
