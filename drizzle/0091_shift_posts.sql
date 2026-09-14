-- v22.20 — 0091: open shifts, as records.
--
-- Persists the part `openShifts.ts` owns. Eligibility still composes other
-- engines; what this adds is the post itself and the fact that somebody said
-- they would take it.
--
-- `shiftInterests` is separate from any assignment table on purpose. Interest
-- and assignment are different facts with different authority, and one row
-- holding both would make "I would take this" and "you are on this" the same
-- record — which is exactly the conflation the engine exists to prevent.
--
-- There is no qualification store in this schema: operators carry licence class
-- and expiry inline and nothing else. Eligibility therefore reports
-- qualification checks as unknown rather than as satisfied, and a post that
-- requires one cannot be filled from stored data alone. That is recorded here
-- rather than worked around.

CREATE TABLE `shiftPosts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `postRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `title` varchar(220) NOT NULL,
  `kind` enum('open','assigned') NOT NULL DEFAULT 'open',
  `startsAt` timestamp NOT NULL,
  `endsAt` timestamp NOT NULL,
  `location` varchar(220),
  `requiredRole` varchar(60) NOT NULL,
  `requiredQualificationsJson` text NOT NULL,
  `seats` int NOT NULL DEFAULT 1,
  `status` enum('open','filled','cancelled','expired') NOT NULL DEFAULT 'open',
  `postedByUserId` int NOT NULL,
  `postedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `shiftPosts_id` PRIMARY KEY(`id`),
  CONSTRAINT `shiftPosts_ref_unique` UNIQUE(`postRef`)
);
--> statement-breakpoint
CREATE INDEX `shiftPosts_window` ON `shiftPosts` (`tenantId`, `status`, `startsAt`);
--> statement-breakpoint

CREATE TABLE `shiftInterests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `postRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `expressedAt` timestamp NOT NULL,
  `withdrawnAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `shiftInterests_id` PRIMARY KEY(`id`),
  -- One standing interest per person per post. Tapping twice is not two claims.
  CONSTRAINT `shiftInterests_unique` UNIQUE(`postRef`, `userId`)
);
