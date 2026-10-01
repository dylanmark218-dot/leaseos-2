-- S2-C — provider credential metadata, with no column that can hold a secret.
--
-- This is the table dashboards, connector health and audit read. It answers "is Alberta 511
-- configured, who owns that credential, when was it rotated" and it cannot answer "what is the
-- key", because there is nowhere here to put one: the value lives in `encryptedSecrets` and this
-- table holds only `secretRef`.
--
-- THE COLUMN THAT IS DELIBERATELY ABSENT. `fleetFuelCards.providerToken` is a plaintext
-- varchar(120) credential column that no production code reads or writes — declared, unwired, and
-- exactly the shape of mistake this table refuses to repeat. A structural test pins that no new
-- production caller starts using it.
--
-- OWNERSHIP IS AN INVARIANT, NOT A CONVENTION. PLATFORM credentials have no `orgRef`; TENANT
-- credentials must have one. Both directions are enforced by a CHECK rather than by service code,
-- because a malformed row is what a generic resolver would later have to guess about — and
-- guessing, in a credential resolver, means serving one tenant another tenant's key.
--
-- NO FALLBACK IS EXPRESSIBLE HERE. There is no "inherit from platform" flag. A connector whose
-- provider terms genuinely permit falling back to a platform credential must say so in its own
-- policy; the generic store must never decide that, because the decision is legal rather than
-- technical.
--
-- `credentialVersion` TRACKS THE PROVIDER'S VALUE, NOT OUR KEY. Replacing the key a provider
-- issued increments it. Rewrapping our own master key changes `encryptedSecrets.keyId` and leaves
-- this column alone — they are different events and conflating them would make an audit trail lie.
CREATE TABLE `providerCredentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`credentialRef` varchar(64) NOT NULL,
	-- Joins externalDataSources.sourceKey, which already carries the licensing dimensions
	-- (commercialUsePermitted, redistributionPermitted, rateLimitCalls). Credential presence and
	-- licence permission stay separate questions; S2-H combines them.
	`providerKey` varchar(120) NOT NULL,
	`environment` enum('production','staging','sandbox') NOT NULL DEFAULT 'production',
	`authScheme` enum('NONE','API_KEY','STATIC_BEARER','OAUTH2_CLIENT_CREDENTIALS','OAUTH2_REFRESH','SIGNED_REQUEST','MUTUAL_TLS') NOT NULL,
	`ownership` enum('PLATFORM','TENANT') NOT NULL,
	-- NULL exactly when ownership = PLATFORM. Enforced below.
	`orgRef` varchar(64),
	-- Exists only so uniqueness can be enforced. MariaDB permits any number of NULLs in a
	-- composite UNIQUE, so a UNIQUE over `orgRef` constrains tenant rows and lets PLATFORM rows
	-- duplicate freely — and `resolveForOutbound` reads the first matching row, so two active
	-- platform rows for one provider would make "which credential did we send" a function of row
	-- order. Collapsing NULL to a sentinel closes that; `ownership` is in the index too, so a
	-- tenant whose orgRef is literally '~platform' still cannot collide with a platform row.
	`orgScope` varchar(64) AS (COALESCE(`orgRef`, '~platform')) STORED,
	-- The provider's own account/client identifier. NOT secret; an OAuth client id is public.
	`externalAccountId` varchar(200),
	-- Pointer into encryptedSecrets. NULL is legitimate for authScheme = NONE (an open feed still
	-- goes through a connector so caching, licence and audit apply uniformly).
	`secretRef` varchar(64),
	`status` enum('active','disabled','rotating','revoked','expired') NOT NULL DEFAULT 'active',
	`credentialVersion` int NOT NULL DEFAULT 1,
	-- A truncated hash of the plaintext, so an operator can confirm "this is the key I pasted"
	-- without the system disclosing any character of it. Never plaintext, not even the last four.
	`fingerprint` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NULL,
	`rotatedAt` timestamp NULL,
	`expiresAt` timestamp NULL,
	`lastUsedAt` timestamp NULL,
	`createdByUserId` int,
	`disabledByUserId` int,
	`disabledReason` varchar(300),
	CONSTRAINT `providerCredentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `providerCredentials_credentialRef_unique` UNIQUE(`credentialRef`),
	-- Ownership coherence, at the storage layer where it cannot be bypassed by a new caller.
	CONSTRAINT `providerCredentials_ownership_orgRef_chk` CHECK (
		(`ownership` = 'PLATFORM' AND `orgRef` IS NULL) OR (`ownership` = 'TENANT' AND `orgRef` IS NOT NULL)
	)
);
--> statement-breakpoint
-- Resolution asks for one provider, in one environment, under one ownership — and must get at most
-- one row back. Indexed on `orgScope` rather than `orgRef` precisely because the NULL in a platform
-- row would otherwise exempt platform credentials from uniqueness.
CREATE UNIQUE INDEX `providerCredentials_scope_unique` ON `providerCredentials` (`providerKey`,`environment`,`ownership`,`orgScope`);
--> statement-breakpoint
CREATE INDEX `providerCredentials_provider_status_idx` ON `providerCredentials` (`providerKey`,`status`);
--> statement-breakpoint
CREATE INDEX `providerCredentials_tenant_idx` ON `providerCredentials` (`orgRef`,`providerKey`);
