-- v23.31 — 0224: an operator's designated duty day, recorded as history.
--
-- The HOS engine (ELD checkpoints 2a/2b) can only count rolling windows, because nothing in LeaseOS
-- says where an operator's duty day begins. `operators` has no timezone and no day start, and adding
-- two mutable columns to it would let one edit silently change every past day's clocks. So the
-- designation is its own append-only record: an IANA timezone, the local minute the day starts, the
-- moment from which it applies, who recorded it and why.
--
-- The designation in force at an instant is the row with the latest `effectiveFrom` at or before it
-- (ties to the latest id). A change of designation is a new row, never an edit, so the day the
-- engine counted last March is still the day it counts when an auditor asks about last March.
--
-- What this is NOT: a statement that any regime counts any limit over this day. The engine shows the
-- duty-day clocks and keeps every daily verdict UNKNOWN until such a rule is verified. `tzVersion`
-- records which IANA database the recording server ran, because the same zone name can mean different
-- offsets in different database versions (America/Edmonton stopped changing clocks in 2026c).
--
-- Tenant: `orgRef` NOT NULL, from the recording user's acting scope, and the operator must be owned by
-- that organization.

CREATE TABLE `eldDutyDayDesignations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `designationRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `operatorId` int NOT NULL,
  `timezone` varchar(64) NOT NULL,
  `dayStartMinutes` smallint NOT NULL,
  `effectiveFrom` timestamp(3) NOT NULL,
  `reason` varchar(300) NOT NULL,
  `tzVersion` varchar(16) NULL,
  `recordedByUserId` int NOT NULL,
  `recordedAt` timestamp(3) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `eldDutyDayDesignations_id` PRIMARY KEY(`id`),
  CONSTRAINT `eldDutyDayDesignations_ref_unique` UNIQUE(`designationRef`),
  CONSTRAINT `eldDutyDayDesignations_start_range` CHECK (`dayStartMinutes` BETWEEN 0 AND 1439)
);
--> statement-breakpoint
CREATE INDEX `eldDutyDayDesignations_operator_effective` ON `eldDutyDayDesignations` (`orgRef`, `operatorId`, `effectiveFrom`);
--> statement-breakpoint

CREATE TRIGGER `eldDutyDayDesignations_immutable_update` BEFORE UPDATE ON `eldDutyDayDesignations` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldDutyDayDesignations is history: a new designation is a new row';
--> statement-breakpoint
CREATE TRIGGER `eldDutyDayDesignations_immutable_delete` BEFORE DELETE ON `eldDutyDayDesignations` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldDutyDayDesignations is history and is never deleted';
