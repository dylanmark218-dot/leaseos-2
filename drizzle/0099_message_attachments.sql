-- v22.20 — 0099: attachments, as references.
--
-- One table, holding a pointer and nothing else. No invoice total, no defect
-- text, no document bytes: the moment a message carries a copy of a protected
-- record, the board becomes a second record vault with its own weaker
-- permissions, and the copy starts disagreeing with the original.
--
-- Deliberately no tenantId. An attachment is reachable only through its
-- message, which is reachable only through its channel, which carries the
-- organization. A duplicated column would be a second place for organization
-- identity to disagree — the same reason shiftInterests carries none.
--
-- The unique key stops the same reference being attached twice to one message,
-- so a retry is not two attachments.

CREATE TABLE `messageAttachments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `attachmentRef` varchar(64) NOT NULL,
  `messageRef` varchar(64) NOT NULL,
  `kind` varchar(40) NOT NULL,
  `objectRef` varchar(120) NOT NULL,
  `attachedByUserId` int NOT NULL,
  `attachedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageAttachments_id` PRIMARY KEY(`id`),
  CONSTRAINT `messageAttachments_ref_unique` UNIQUE(`attachmentRef`),
  CONSTRAINT `messageAttachments_one_per_message` UNIQUE(`messageRef`, `kind`, `objectRef`)
);
--> statement-breakpoint
CREATE INDEX `messageAttachments_message` ON `messageAttachments` (`messageRef`);
--> statement-breakpoint
CREATE INDEX `messageAttachments_object` ON `messageAttachments` (`kind`, `objectRef`);
