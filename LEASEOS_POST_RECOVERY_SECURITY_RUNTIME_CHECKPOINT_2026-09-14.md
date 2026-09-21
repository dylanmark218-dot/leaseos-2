# LeaseOS Post-Recovery Security/Runtime Checkpoint — 2026-09-14

Branch: `integration/post-recovery-security-runtime`
Base: `candidate/project-recovery-rc` (`5d3e42bc1b06eb32ab65698eeb5ca6beb5406983`)

## Implemented in this checkpoint

- Device enrollment now receives a P-256 SPKI public key; the server validates the curve and derives the SHA-256 fingerprint itself.
- Device rows are bound to the server-resolved acting organization (`resolveActingScope`); legacy unbound devices fail closed and must be re-enrolled.
- Device key history retains public keys so the existing 72-hour retired-key grace can be cryptographically verified rather than trusting a claimed fingerprint.
- Sync packages carry `signedAt`, a fresh nonce and an IEEE-P1363 ECDSA signature over canonical package content.
- The server verifies the complete canonical package before admission and records a unique `(fieldDeviceId, nonce)` row to prevent replay.
- Signature timestamps are limited to a 10-minute skew window.
- Browser fallback `MemoryKeystore` now uses a real WebCrypto P-256 signing key while retaining a separate AES wrapping key for its in-memory vault.
- Client sync signs the package with the non-exported private key. Network failure after upload/seal returns affected captures from `syncing` to `queued` for idempotent retry.
- Sync receipts now persist the server-recomputed content/manifest hashes rather than echoing device-supplied computed values.
- Migration `0110_device_cryptographic_binding.sql` adds organization/public-key binding and the nonce replay ledger.

## Fail-closed compatibility decision

Existing fingerprint-only devices are intentionally not grandfathered. After migration they have no stored public key or organization binding, so synchronization is refused until re-enrollment. This avoids creating a permanent downgrade path around signature verification.

## Verification available in this environment

- TypeScript syntax/transpile check on changed/new TS/TSX: zero syntax diagnostics.
- `git diff --check`: clean.
- Schema has no duplicate `mysqlTable` names.
- New `deviceSyncNonces` table exists in both Drizzle schema and migration 0110.
- Historical SQL-only `dispatchEligibilityChecks` remains a pre-existing migration/schema-history mismatch; this checkpoint does not conceal or rename it.
- Full dependency-backed Vitest/MySQL/browser/native gate is not available in this restored container because `node_modules` is absent.

## Next tranche

1. Reconcile existing DB integration fixtures with cryptographic enrollment/signing.
2. Tenant-scope integration clients, inbound events and webhook delivery.
3. Add authenticated `loadsense_weight` machine feed with replay/sequence persistence.
4. Retain raw LoadSense evidence but refuse projection into legacy global operational tables until authoritative asset ownership is available.

## Continuation — tenant-bound integrations and LoadSense raw edge

- Migration 0111 adds `orgRef` to integration clients, inbound events, webhook subscriptions and webhook deliveries.
- Machine authentication context now carries the organization stored on the integration client; historical unbound integration keys fail closed and must be re-registered.
- Integration client management, inbound listing, webhook management and delivery listing are filtered to the server-resolved acting organization.
- Webhook dispatch compares `domainEventOutbox.tenantId` to the subscription organization before delivery; a subscription cannot receive another tenant's event.
- Migration 0112 adds the `loadsense_weight` feed and tenant/client provenance on `loadSenseGatewayFrames`.
- `loadsense_weight` validates the recovered `leaseos.loadsense.v1` frame protocol and persists a tenant-qualified gateway frame key. Duplicate gateway sequence/frame keys do not create a second raw frame.
- The LoadSense machine edge explicitly returns `Billing authority: not_granted`; raw onboard sensor evidence does not become certified-scale evidence or mutate billable quantity.
- For non-default tenants, legacy integration feeds retain authenticated inbound evidence but do not project into global legacy unit/operator/load/financial tables until those tables gain authoritative tenant ownership.
