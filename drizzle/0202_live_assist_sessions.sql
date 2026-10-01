-- 0202 — LA-1a: the Live Assist session spine, and nothing else.
--
-- Slot: main ends at 0198. A scan of origin/main and all 94 remote branches on 2026-09-25 found
-- 0195–0197 (document control, intelligence engine) and 0199–0201 (mechanic portal) claimed above the
-- head. This takes 0202, the first number no branch holds, and 0203 for the append-only guard.
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md records the claim.
--
-- OWNER RULING. This is the narrow LA-1a carve-out recorded in docs/live-assist/LA1A_OWNER_RULING.md.
-- It builds the session lifecycle only. It does not authorize a model call, image analysis, camera,
-- screen or video capture, document transmission, form extraction or evidence creation; no column
-- below holds an image, a frame, a storage key or model output.
--
-- TENANCY. Every table carries `orgRef` NOT NULL, written from the server's `resolveActingScope`, never
-- from input. Uniqueness that a client can influence (`startKey`) is scoped to (orgRef, userId). This
-- does not make organization-wide isolation a system property; it makes these tables scoped.
--
-- The transient tables (turns, frames, observations) have no writer until a later checkpoint. They are
-- created now so the purge that removes them exists before the first row does.

CREATE TABLE `liveAssistSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionRef` varchar(40) NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	-- The client's retry key for `start`: a repeated start with the same key returns the same session.
	`startKey` varchar(64) NOT NULL,
	`source` enum('photo','camera','screen','video') NOT NULL,
	`state` enum('active','paused','ended','expired') NOT NULL,
	-- 1 while active or paused, NULL once stopped. With the unique index below: one open session per
	-- person per organization, enforced by the database rather than by a check-then-insert race.
	`openMarker` tinyint,
	-- The limits this session was started under. A later policy change never widens a live session.
	`policySnapshotJson` text NOT NULL,
	`startedAt` timestamp NOT NULL,
	`lastHeartbeatAt` timestamp NOT NULL,
	-- Server deadlines. A heartbeat moves the idle deadline from the server's clock; nothing moves the hard one.
	`idleDeadlineAt` timestamp NOT NULL,
	`hardDeadlineAt` timestamp NOT NULL,
	`pausedAt` timestamp NULL,
	`endedAt` timestamp NULL,
	`endReason` enum('user_end','idle_timeout','budget_spent','policy_disabled'),
	-- Derived when the session stops (endedAt + retention). The purge reads only this.
	`purgeAfter` timestamp NULL,
	`transientPurgedAt` timestamp NULL,
	`previousSessionRef` varchar(40),
	-- Work counters for the checkpoint that first submits a frame. LA-1a writes none of them.
	`framesSubmitted` int NOT NULL DEFAULT 0,
	`bytesSubmitted` bigint NOT NULL DEFAULT 0,
	`inferenceCalls` int NOT NULL DEFAULT 0,
	`inputTokens` int NOT NULL DEFAULT 0,
	`outputTokens` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liveAssistSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `liveAssistSessions_sessionRef_unique` UNIQUE(`sessionRef`),
	CONSTRAINT `liveAssistSessions_startKey_unique` UNIQUE(`orgRef`,`userId`,`startKey`),
	CONSTRAINT `liveAssistSessions_open_unique` UNIQUE(`orgRef`,`userId`,`openMarker`)
);
--> statement-breakpoint
CREATE INDEX `liveAssistSessions_owner_idx` ON `liveAssistSessions` (`orgRef`,`userId`,`startedAt`);
--> statement-breakpoint
CREATE INDEX `liveAssistSessions_deadline_idx` ON `liveAssistSessions` (`state`,`idleDeadlineAt`);
--> statement-breakpoint
CREATE INDEX `liveAssistSessions_purge_idx` ON `liveAssistSessions` (`transientPurgedAt`,`purgeAfter`);
--> statement-breakpoint
CREATE TABLE `liveAssistTurns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`seq` int NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`channel` enum('text','voice') NOT NULL,
	`text` text NOT NULL,
	`frameHashesJson` text,
	`redactionFlagsJson` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liveAssistTurns_id` PRIMARY KEY(`id`),
	CONSTRAINT `liveAssistTurns_seq_unique` UNIQUE(`sessionId`,`seq`)
);
--> statement-breakpoint
CREATE INDEX `liveAssistTurns_session_idx` ON `liveAssistTurns` (`orgRef`,`sessionId`);
--> statement-breakpoint
-- Hashes and dimensions of an image a session looked at. Never the bytes. A row with
-- `savedEvidenceRecordId` set was deliberately saved as evidence and the purge never removes it.
CREATE TABLE `liveAssistFrames` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`frameSeq` int NOT NULL,
	`kind` enum('context','inspect','crop') NOT NULL,
	`frameHash` varchar(64) NOT NULL,
	`originalHash` varchar(64),
	`perceptualHash` varchar(16),
	`width` int NOT NULL,
	`height` int NOT NULL,
	`byteSize` int NOT NULL,
	`regionJson` text,
	`markedByUser` boolean NOT NULL DEFAULT false,
	`savedEvidenceRecordId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liveAssistFrames_id` PRIMARY KEY(`id`),
	CONSTRAINT `liveAssistFrames_seq_unique` UNIQUE(`sessionId`,`frameSeq`)
);
--> statement-breakpoint
CREATE INDEX `liveAssistFrames_session_idx` ON `liveAssistFrames` (`orgRef`,`sessionId`);
--> statement-breakpoint
CREATE TABLE `liveAssistObservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`turnId` int,
	`frameHash` varchar(64),
	`kind` enum('identified','read_text','condition','guidance_step') NOT NULL,
	`statement` varchar(600) NOT NULL,
	`certainty` enum('visible_clearly','visible_partially','not_visible','inferred') NOT NULL,
	`requestedView` enum('closer','wider','other_side','more_light','hold_steady','freeze','region','context_question'),
	`requestedRegionJson` text,
	`safetyClass` enum('none','advise_qualified_inspection','stop_work_escalate') NOT NULL DEFAULT 'none',
	`overreachFlagsJson` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liveAssistObservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `liveAssistObservations_session_idx` ON `liveAssistObservations` (`orgRef`,`sessionId`);
--> statement-breakpoint
-- The lifecycle record. Metadata only. `actorUserId` NULL means the server acted (a deadline passed,
-- the purge ran). Made append-only by 0203.
CREATE TABLE `liveAssistEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`actorUserId` int,
	`eventType` enum('session_started','session_paused','session_resumed','session_ended','session_expired','session_transient_purged') NOT NULL,
	`endReason` enum('user_end','idle_timeout','budget_spent','policy_disabled'),
	`detail` varchar(200),
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liveAssistEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `liveAssistEvents_org_idx` ON `liveAssistEvents` (`orgRef`,`occurredAt`);
--> statement-breakpoint
CREATE INDEX `liveAssistEvents_session_idx` ON `liveAssistEvents` (`sessionId`);
--> statement-breakpoint
-- An organization's policy. A change is a new row and the old one is superseded; `currentMarker` with
-- its unique index makes two concurrent changes collide instead of both becoming current.
CREATE TABLE `liveAssistPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`policyRef` varchar(64) NOT NULL,
	`orgRef` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`sourcesAllowedJson` text NOT NULL,
	`idleSeconds` int NOT NULL,
	`maxSessionMinutes` int NOT NULL,
	`retentionHours` int NOT NULL,
	`maxSessionsPerUserPerDay` int NOT NULL,
	`dailySpendCeilingCents` int,
	`setByUserId` int NOT NULL,
	`currentMarker` tinyint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`supersededAt` timestamp NULL,
	CONSTRAINT `liveAssistPolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `liveAssistPolicies_policyRef_unique` UNIQUE(`policyRef`),
	CONSTRAINT `liveAssistPolicies_current_unique` UNIQUE(`orgRef`,`currentMarker`)
);
