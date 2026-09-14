-- v21.2 — Dispatch enforcement on the legacy assignment path.
--
-- v21.1 made the B12 gate reachable and named `jobUnits.create` as the
-- remaining ungated way to put a unit and operator on a job. Gating it
-- unconditionally would refuse every assignment until a routing source and a
-- verified HOS rule exist (P0, P9). So enforcement is a setting:
--
--   off       the legacy path behaves as it always has
--   advisory  every assignment is evaluated; nothing is refused; an assignment
--             made without a readiness check, or against a blocked or unknown
--             one, is an exception the centre raises
--   enforced  an assignment needs a fresh, fact-valid check whose blockers are
--             resolved or overridden — the same rule as the award
--
-- The setting is append-only: WHEN enforcement was on is part of the audit
-- trail, and every assignment records the mode that was in force when it was
-- made, so no history has to be reconstructed later.

CREATE TABLE `dispatchEnforcementSettings` (
  `id` int AUTO_INCREMENT NOT NULL,
  -- NULL = global. A company-scoped row overrides the global one for that
  -- company once jobs carry an entity; today the legacy path reads global.
  `financialEntityId` int,
  `mode` enum('off','advisory','enforced') NOT NULL,
  `reason` varchar(400) NOT NULL,
  `setByUserId` int NOT NULL,
  `setAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchEnforcementSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchEnforcementSettings_scope_idx` ON `dispatchEnforcementSettings` (`financialEntityId`, `setAt`);
--> statement-breakpoint

-- A check may now be recorded for a direct job assignment, not only a posting.
ALTER TABLE `dispatchEligibilityChecks`
  MODIFY COLUMN `postingId` int NULL,
  ADD COLUMN `jobId` int NULL AFTER `postingId`;
--> statement-breakpoint

ALTER TABLE `jobUnits`
  ADD COLUMN `eligibilityCheckId` int NULL AFTER `operatorId`,
  ADD COLUMN `enforcementModeAtCreate` enum('off','advisory','enforced') NULL AFTER `eligibilityCheckId`;
