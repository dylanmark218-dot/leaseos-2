-- v22.20 — 0090: time off, as records.
--
-- The engine has existed for several checkpoints with no way to reach it. This
-- is the first of the calendar engines to be persisted, and the shape follows
-- the privacy rule rather than the convenience of a single row:
--
-- `privateNote` is its own column so that the scheduling read can simply not
-- select it. A filter applied in application code is a filter somebody
-- eventually forgets; a column absent from a SELECT cannot leak.
--
-- `status` distinguishes `recorded` from `approved`. A same-day call-off is a
-- fact somebody reported, not a request anybody approved, and collapsing the
-- two would put a supervisor's name against an illness.

CREATE TABLE `leaveRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requestRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `userId` int NOT NULL,
  `category` enum('vacation','sick','medical_appointment','personal','family_responsibility','bereavement','unpaid','statutory_holiday','training','certification_renewal','court_obligation','company_authorized','other') NOT NULL,
  `urgency` enum('planned','same_day') NOT NULL DEFAULT 'planned',
  `fromDate` timestamp NOT NULL,
  `toDate` timestamp NOT NULL,
  `partialFromTime` varchar(5),
  `partialToTime` varchar(5),
  -- Never selected by the scheduling read. See the note above.
  `privateNote` varchar(2000),
  `requestedAt` timestamp NOT NULL,
  `status` enum('requested','approved','declined','cancelled','recorded') NOT NULL DEFAULT 'requested',
  `decidedByUserId` int,
  `decidedAt` timestamp NULL,
  `decisionNote` varchar(600),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `leaveRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `leaveRequests_ref_unique` UNIQUE(`requestRef`)
);
--> statement-breakpoint
CREATE INDEX `leaveRequests_user` ON `leaveRequests` (`userId`, `status`, `fromDate`);
--> statement-breakpoint
CREATE INDEX `leaveRequests_window` ON `leaveRequests` (`tenantId`, `status`, `fromDate`, `toDate`);
