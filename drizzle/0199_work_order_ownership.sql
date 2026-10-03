-- 0199 — Mechanic Portal + Fleet Maintenance, checkpoint 1: who owns a work order, and cancelling one.
-- Design: docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md.
--
-- Holds, meter readings and the unit's operational state are NOT here. They belong to the Fleet &
-- Equipment Portfolio's first slice (`unitHolds`, `unitMeterReadings`, docs/fleet/…), which the
-- mechanic portal is built on rather than beside.
--
-- Numbered 0199: drafted as 0175, then 0189, then 0198; it moved three times because each number was
-- taken first (0189 by C1b-1, 0198 by C1b-2b, both on main). 0199 is the first number above every claim
-- on main and on every branch (the collision register's scan, 2026-09-25); 0190 is unclaimed but sorts before main's 0191-0194.

-- Who owns a work order, as history. `workOrders.technician` was a free-text name nobody could log in
-- as; an assignment is a user holding a shop role, and the current assignee is the newest row here —
-- nothing updates one (the `dispatchRoleAssignmentEvents` shape, 0171).
CREATE TABLE `workOrderAssignments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `workOrderId` int NOT NULL,
  `unitId` int NOT NULL,
  `eventType` enum('assigned','reassigned','unassigned') NOT NULL,
  `fromUserId` int,
  `toUserId` int,
  `shopFacilityId` int,
  `expectedCompletionAt` timestamp NULL,
  `reason` varchar(400),
  `actorUserId` int NOT NULL,
  `actorRole` varchar(40) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workOrderAssignments_id` PRIMARY KEY(`id`),
  CONSTRAINT `workOrderAssignments_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `workOrderAssignments_wo` ON `workOrderAssignments` (`workOrderId`, `occurredAt`);
--> statement-breakpoint

-- A work order can be cancelled, and the row says by whom and why. Cancelling is not closing: a
-- cancelled work order produced no repair, so it can never evidence a release, and the defect it was
-- opened for stays open. Who opened it is recorded from here on; older rows read NULL, which means
-- "not recorded", not "nobody".
ALTER TABLE `workOrders`
  MODIFY COLUMN `status` enum('draft','open','in_progress','waiting_parts','ready_for_service','closed','cancelled') NOT NULL DEFAULT 'open',
  ADD COLUMN `openedByUserId` int NULL,
  ADD COLUMN `cancelledAt` timestamp NULL,
  ADD COLUMN `cancelledByUserId` int NULL,
  ADD COLUMN `cancelReason` varchar(400) NULL;
