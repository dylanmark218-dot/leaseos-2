-- requestDatedAt and requestReceivedAt are separate because the 15 days run from
-- the request and the two dates can differ by days. The clock runs from the later
-- of them — see _core/inspectorRequest.ts. Confirm the correct anchor against the
-- regulation text before this is relied on.

CREATE TABLE `academyInspectorRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requestRef` varchar(64) NOT NULL,
  `inspectorName` varchar(220),
  `issuingAuthority` varchar(220) NOT NULL,
  `authorityFileRef` varchar(120),
  `requestDatedAt` timestamp NOT NULL,
  `requestReceivedAt` timestamp NULL,
  `dueAt` timestamp NOT NULL,                  -- computed at intake, stored so the deadline is auditable
  `subjectUserId` int NOT NULL,
  `certificateId` int NOT NULL,
  `state` enum('received','assembling','produced','incomplete','withdrawn') NOT NULL DEFAULT 'received',
  `producedAt` timestamp NULL,
  `producedByUserId` int,
  `packageHash` varchar(64),                   -- what was handed over, so it can be shown again unchanged
  `packagePartsJson` text,                     -- which parts the package actually contained
  `missingPartsJson` text,                     -- and which it could not, with their codes
  `irrecoverable` boolean NOT NULL DEFAULT false,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyInspectorRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyInspectorRequests_ref_unique` UNIQUE(`requestRef`),
  CONSTRAINT `academyInspectorRequests_due_after_dated` CHECK (`dueAt` > `requestDatedAt`)
);
--> statement-breakpoint
CREATE INDEX `academyInspectorRequests_open_idx` ON `academyInspectorRequests` (`state`,`dueAt`);
--> statement-breakpoint
CREATE INDEX `academyInspectorRequests_certificate_idx` ON `academyInspectorRequests` (`certificateId`);
