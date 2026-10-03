-- 0213 — S2-FLEET-A: the runtime instance registry. Metadata about running processes, nothing else.
--
-- Slot: main ends at 0209. A scan of origin/main and every remote branch on 2026-10-01 (at 2a76920)
-- found 0210–0212 claimed by `claude/driver-portfolio-credential-wallet-ya8928`
-- (0210_driver_portfolio, 0211_driver_portfolio_events_append_only, 0212_driver_portfolio_api), so
-- 0213 is the first number free on main and on every branch. The register that said "next free:
-- 0210" was written before that branch renumbered; docs/architecture/MIGRATION_COLLISION_REGISTER.md
-- records this claim in the same commit.
--
-- WHAT A ROW IS. One process — a server (dist/index.js) or a standalone worker (dist/worker.js) —
-- from the moment it registers at startup until it marks itself stopped, or until its heartbeat
-- expires because it crashed. It carries the build the process was built from (NULL when the process
-- runs from sources and so has no identity: that is recorded, never counted as compatible), the
-- capabilities that build declares, and liveness timestamps.
--
-- TENANCY. None, deliberately. This table describes the deployment, not any organization's data; it
-- carries no orgRef and no tenant or user API can read or write it. Writes come only from the
-- entrypoints' own startup and shutdown code (server/_core/runtimeRegistry.ts).
--
-- IDENTITY IS IMMUTABLE. Nothing updates instanceRef, runtimeKind, buildSha, buildRelease,
-- buildSource or capabilitiesJson after the INSERT. A heartbeat moves lastHeartbeatAt and nothing
-- else; a graceful stop sets stoppedAt. No row is deleted by application code.

CREATE TABLE `runtimeInstances` (
	`id` int AUTO_INCREMENT NOT NULL,
	-- Random per process start (`rt_` + UUID). Not the pid, not the hostname: neither is unique
	-- across a fleet, and a hostname is an internal detail this table has no reason to hold.
	`instanceRef` varchar(48) NOT NULL,
	`runtimeKind` enum('server','worker') NOT NULL,
	-- The full commit id embedded at build time, or NULL for a process run from sources.
	`buildSha` varchar(40),
	`buildRelease` varchar(32),
	`buildSource` enum('artifact','unbuilt') NOT NULL,
	-- JSON array of capability names from server/_core/runtimeCapabilities.ts.
	`capabilitiesJson` text NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`lastHeartbeatAt` timestamp NOT NULL DEFAULT (now()),
	`stoppedAt` timestamp NULL,
	CONSTRAINT `runtimeInstances_id` PRIMARY KEY(`id`),
	CONSTRAINT `runtimeInstances_instanceRef_unique` UNIQUE(`instanceRef`)
);
--> statement-breakpoint
CREATE INDEX `runtimeInstances_live_idx` ON `runtimeInstances` (`stoppedAt`,`lastHeartbeatAt`);
