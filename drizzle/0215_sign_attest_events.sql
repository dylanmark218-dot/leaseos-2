-- 0215 — Sign & Attest, SA1: the trail. One row per state change of a signing revision, in sequence,
-- each carrying the hash of the one before it.
--
-- Slot: follows 0214 on this branch (docs/architecture/MIGRATION_COLLISION_REGISTER.md).
--
-- `(revisionId, sequence)` is unique and the sequence is assigned under a row lock on the revision,
-- so two concurrent writers cannot both append "the next" event. `eventHash` is
-- sha256(prevEventHash ∥ canonical(event)); the head is copied to the revision at finalization. The
-- table is append-only: nothing in production updates or deletes a row, and 0216 makes the database
-- refuse it as well (separate file, on the 0176/0203 precedent: tables, then their guard).
--
-- `occurredAt` is the clock the event happened by; `clockSource` says whose clock that was. A device
-- recording `sync_pending` offline reports its own time, and the server records when it heard.

CREATE TABLE `attestEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventRef` varchar(64) NOT NULL,
	`revisionId` int NOT NULL,
	`orgRef` varchar(64),
	`sequence` int NOT NULL,
	`eventType` varchar(60) NOT NULL,
	`sessionId` int,
	`fieldId` int,
	`markId` int,
	`artifactId` int,
	`actorSource` enum('human','system','external','integration') NOT NULL,
	`actorUserId` int,
	`actorExternalIdentityId` int,
	`deviceRef` varchar(64),
	`previousState` varchar(40),
	`newState` varchar(40),
	`detailJson` text,
	`prevEventHash` varchar(64),
	`eventHash` varchar(64) NOT NULL,
	`clockSource` enum('server','device') NOT NULL DEFAULT 'server',
	`occurredAt` timestamp NOT NULL,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attestEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `attestEvents_eventRef_unique` UNIQUE(`eventRef`),
	CONSTRAINT `attestEvents_seq_unique` UNIQUE(`revisionId`,`sequence`)
);
--> statement-breakpoint
CREATE INDEX `attestEvents_type_idx` ON `attestEvents` (`revisionId`,`eventType`);
