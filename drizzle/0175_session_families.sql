-- S1-A — a session is a row now, because a session nobody records is a session nobody can revoke.
--
-- Until this table, `verifySession` was a stateless HS256 `jwtVerify` with no server lookup, and
-- the token it verified was minted with `expiresInMs: ONE_YEAR_MS`. Logout cleared the cookie; a
-- copy already taken out of the browser kept working for the rest of its year, and nothing in the
-- system could say otherwise. There was no session table to consult.
--
-- WHAT IS STORED, AND WHAT IS NOT. `refreshVerifierHash` is a SHA-256 of the verifier the client
-- holds. The verifier itself is never written here, which is the same rule the portal's bearer
-- tokens already follow ("a bearer token is stored only as its SHA-256" —
-- server/_core/externalIdentityPolicy.ts). A dump of this table yields no usable credential.
--
-- ABSOLUTE EXPIRY IS SET ONCE. `absoluteExpiresAt` is written at login and never moved. A family
-- used every day still dies on day thirty; an expiry that advanced on each use would mean "thirty
-- days after you stop", which is not a lifetime.
--
-- appId IS STORED because a family belongs to the surface it was minted for. `sdk.verifySession`
-- has refused a session whose `appId` does not match this deployment since the shared-secret
-- finding; a refresh that could cross surfaces would reopen exactly that hole one layer down.

CREATE TABLE `sessionFamilies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`familyRef` varchar(64) NOT NULL,
	`openId` varchar(191) NOT NULL,
	-- The surface this family was issued for. Never reassigned.
	`appId` varchar(128),
	-- Reserved: acting scope is still resolved per request from membership, not carried in the
	-- session. A session proves identity; it does not carry authority.
	`tenantContext` varchar(64),
	-- SHA-256 of the current verifier. Rotated on every refresh; never the verifier itself.
	`refreshVerifierHash` varchar(64) NOT NULL,
	`rotationCounter` int NOT NULL DEFAULT 0,
	-- S1 records the assurance a login reached; S6 will enforce step-up against it.
	`authAssurance` enum('password','mfa') NOT NULL DEFAULT 'password',
	`mfaCompletedAt` timestamp NULL,
	-- Reserved for S4/S6 device binding. A lost phone is then revoked without deleting the account.
	`deviceRef` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp NULL,
	`absoluteExpiresAt` timestamp NOT NULL,
	`revokedAt` timestamp NULL,
	`revokeReason` enum(
		'logout','revoked_all','device_revoked','reuse_detected','credential_change','admin','expired'
	),
	-- Hashed, never raw. Useful for "which sessions are mine" without keeping an address log.
	`userAgentHash` varchar(64),
	`ipHash` varchar(64),
	CONSTRAINT `sessionFamilies_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessionFamilies_familyRef_unique` UNIQUE(`familyRef`)
);
--> statement-breakpoint

-- Revoke-all for one account, and the "my sessions" read, both filter on these two.
CREATE INDEX `sessionFamilies_openId_idx` ON `sessionFamilies` (`openId`,`revokedAt`);
--> statement-breakpoint

-- The refresh path looks a family up by its hash; this keeps that a point read.
CREATE INDEX `sessionFamilies_verifier_idx` ON `sessionFamilies` (`refreshVerifierHash`);
