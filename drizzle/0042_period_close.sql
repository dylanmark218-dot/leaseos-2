-- v21.5 — Period close.
--
-- A period is closed by an action, and the history of actions is the record:
-- who soft-closed it, who closed it, who reopened it and why. There is no
-- status column to flip. The readiness the closer saw is stored with the
-- action, so "what did we know when we closed August" is answerable.
--
-- Payroll keeps its own lock (`payPeriods`); this close covers the ledger
-- around it — vendor bills, fuel, distance, IFTA returns, expenses.

CREATE TABLE `periodCloses` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  -- YYYY-MM
  `period` varchar(7) NOT NULL,
  `action` enum('soft_close','close','reopen') NOT NULL,
  `reason` varchar(400) NOT NULL,
  `readinessJson` text,
  `byUserId` int NOT NULL,
  `at` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `periodCloses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `periodCloses_entity_period_idx` ON `periodCloses` (`financialEntityId`, `period`, `at`);
