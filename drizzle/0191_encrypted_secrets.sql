-- S2-B — the one place ciphertext lives.
--
-- Before this table, reversible secrets sat inline on the record that used them:
-- `externalIdentities.mfaSecretEnc` and `webhookSubscriptions.secretEnc`, both encrypted with the
-- same `LEASEOS_PORTAL_MFA_KEY`. Two consequences. Any query that selected the owning row selected
-- the ciphertext with it, so one `SELECT *` in a dashboard is a disclosure. And because the
-- envelope recorded neither key nor purpose, rotation had nothing to key off.
--
-- SPLIT ON PURPOSE. Metadata is read widely — health screens, audit, connector readiness — while
-- ciphertext is read by exactly one resolver. Keeping them in one table means every metadata read
-- also touches the secret, and the first careless `SELECT *` becomes the leak. Callers hold a
-- `secretRef`; only `secretStore` resolves it.
--
-- secretRef IS OPAQUE AND STABLE. Random, not derived from the plaintext in any way (a derived ref
-- would be an oracle: same key, same ref). It survives master-key rewrap unchanged, which is what
-- lets rotation re-encrypt rows without rewriting every foreign reference to them.
--
-- NOTHING HERE IS A KEY. `keyId` is the *name* of a key, carried so a row written under a retired
-- key stays readable and so a rewrap can find the rows that still reference one. Key material is
-- never written to the database, never to a migration, never to a log.
--
-- MIGRATION PROVENANCE. `sourceTable`/`sourceColumn` record where a value came from when S2-D and
-- S2-E later move the legacy ciphertext, so a partially-completed migration is inspectable and
-- resumable. They are NULL for secrets created natively here.
CREATE TABLE `encryptedSecrets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`secretRef` varchar(64) NOT NULL,
	`purpose` enum('MFA_SECRET','WEBHOOK_SECRET','PROVIDER_CREDENTIAL','INTEGRATION_SECRET') NOT NULL,
	-- The key that encrypted THIS row. Rotation changes it; the reference above does not move.
	`keyId` varchar(64) NOT NULL,
	-- v1.<purpose>.<keyId>.<iv>.<authTag>.<ciphertext>. `text`, not varchar(400): a MUTUAL_TLS
	-- client certificate and key will not fit in 400 characters, and discovering that later would
	-- mean a second migration on a table holding live secrets.
	`envelope` text NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`rewrappedAt` timestamp NULL,
	`disabledAt` timestamp NULL,
	`sourceTable` varchar(64),
	`sourceColumn` varchar(64),
	CONSTRAINT `encryptedSecrets_id` PRIMARY KEY(`id`),
	CONSTRAINT `encryptedSecrets_secretRef_unique` UNIQUE(`secretRef`)
);
--> statement-breakpoint
-- Rewrap scans ask "which rows still use the key I am retiring", for one purpose at a time.
CREATE INDEX `encryptedSecrets_purpose_key_idx` ON `encryptedSecrets` (`purpose`,`keyId`);
--> statement-breakpoint
-- S2-D/S2-E resume by asking what has already been moved out of a given legacy column.
CREATE INDEX `encryptedSecrets_source_idx` ON `encryptedSecrets` (`sourceTable`,`sourceColumn`);
