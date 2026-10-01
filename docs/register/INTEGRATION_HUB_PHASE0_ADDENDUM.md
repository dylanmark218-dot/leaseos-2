# Integration Hub — Phase 0 addendum: restart from `main` (2026-10-01)

The original Phase 0 survey (`INTEGRATION_HUB_PHASE0.md`) and build were done against `main` at
`6f52b57`. By the time this session resumed, `main` had advanced 333 commits (to `b35bac4`) and had,
independently, landed its own fixes for two of the exact problems the Integration Hub set out to
solve. The branch is restarted from current `main` rather than rebased commit-by-commit, because the
collision is not textual (mergeable hunks) but architectural (two designs for the same primitive).
The original work is preserved at tag `archive/integration-hub-v1-stale` (commit `e430c0b`) for
provenance; nothing in it is lost, it is superseded.

## What landed on `main` since the fork, and what it means here

**SEC-004 (`0185_webhook_delivery_claim.sql`, `server/webhookDispatchService.ts`).** The exact
double-send race the Hub's delivery lease fixed was independently fixed on `main` first: `claimedAt`/
`claimedBy` on `webhookDeliveries`, an INSERT-first claim (`claimNewAttempt`), a guarded reclaim
(`reclaimExpiredAttempt`), a guarded finish (`finishClaimedAttempt`), `claimIsLive`,
`WEBHOOK_CLAIM_LEASE_MS` (5 min). `docs/architecture/MIGRATION_COLLISION_REGISTER.md` already
recorded the collision and its resolution: this branch's own claim-column migration is dropped
entirely; `webhookDispatchService.ts` is used as-is, unedited.

**S2 secrets architecture (`0191`–`0194`, `server/secretStore.ts`, `server/providerCredentialService.ts`).**
A generic encrypted-secret store (`encryptedSecrets`, purpose-bound AES-256-GCM, exactly five
allow-listed importers, pinned by `secretBoundary.test.ts`) and a generic credential-metadata table
(`providerCredentials`: ownership PLATFORM/TENANT, authScheme, environment, rotation, fingerprint,
`resolveForOutbound`) now exist and are the house's one way to hold a reversible secret. This
supersedes the Hub's own `integrationCredentials` table and hand-rolled AES-256-GCM entirely.
Connector credentials are now issued, rotated, revoked and resolved through
`providerCredentialService.ts`, scoped by a deterministic `providerKey` naming convention
(`connectorProviderKey(connectorRef, purpose)`), `ownership: "TENANT"`, `orgRef` from the acting
scope. No new file imports `secretStore.ts`; the five-importer allow-list is untouched.

**The egress guard (`server/_core/egressGuard.ts`, `egressHttp.ts`).** A hardened, tested,
already-production SSRF guard (https-only, address-range refusal including IPv4-octal-ambiguity and
manual IPv6 parsing, DNS-pin-then-connect, hand-followed and re-checked redirects, byte/time/content-type
limits, `Retry-After` surfaced) supersedes the Hub's own `destinationPolicy.ts`/`transport.ts`.
`egressGet`/`egressPost` are used directly for the Hub's own outbound fetches (sync polling adapters);
`webhookDispatchService.ts` already uses `egressPost` for webhook delivery and is not touched.

**Organization-scoped role grants (`0207`–`0209`) and the `authorize()` organization axis.**
`resolveActingScope(db, userId)` still works exactly as before for the common case; two new refusals
(`AmbiguousOrganization`, `MembershipRevoked`) are possible and are translated to named tRPC errors by
`roleProcedure` itself, so ordinary `roleProcedure`-gated routers — including this one — need no change.
`authorize()` gained an `organization` parameter that `roleProcedure` now resolves and forwards
automatically; a router that calls `authorize()` a second time inside a handler (this one never does)
would need to forward it explicitly.

**The sweep-ticker pattern (`server/_core/liveAssist/sweepTicker.ts`).** `createSweepTicker` /
`withSweepOnHeartbeat` is the house's general mechanism for adding a rate-limited, non-overlapping,
never-throwing periodic task to the one production worker's heartbeat, introduced for Live Assist and
reused here verbatim for the Hub's own tick (dead-letter scan, sync scheduling and execution).

**The gate itself changed materially**: a syntax-tree procedure census with a committed pin file
(`scripts/procedure-census.ts`, `server/_core/procedureCensus.pin.json`) replaced the old
grep-and-magic-number gates for `protectedProcedure`/`publicProcedure`/`adminProcedure`; a JSON vitest
reporter plus `scripts/verify-gate-run.ts`/`scripts/skipped-db-suites.ts` replaced text-scraping the
human reporter; `scripts/verify-fixture-isolation.sh` now fails a suite that depends on a record id it
did not create. `OPERATIONAL_PROCEDURE_PERMISSIONS` is still a hand-maintained pinned count (now 723
before this work), as is `crossLayerIntegrity.test.ts`'s `serverPaths.size` (793) and
`PROCEDURE_AUTHORIZATION_INVENTORY.md`'s total (387) — these are bumped by this work's own addition,
not reset.

## What is therefore built fresh here (genuinely new, not duplicated by any of the above)

Typed connector registry and instances; versioned declarative data-sync contracts; the canonical
envelope for the Hub's own signed inbound edge; dead letters (additive — `integrationDeadLetters` is
populated by scanning `webhookDeliveries` for `status='dead'` rows with no dead-letter yet, never by
editing the dispatch service); sync runs and cursors with crash-safe, transactional cursor commit;
conflict records and policy; connector health and a circuit breaker; Hub metrics and a health line;
the Hub's own audit trail; Exception Centre and Inbox projection of Hub problems; the raw-body signed
inbound edge itself (main's existing inbound path remains the unsigned, API-key, machine-channel
`inbound.ingest`; the Hub's edge is new).

## Migration numbers

First number free on `main` and every open remote branch at restart time: **`0220`**. Takes
`0220`–`0223` (connectors+contracts+hub-events; sync runs+cursors; dead letters+actions+conflicts;
plus the small additive columns on `webhookSubscriptions`/`integrationClients`/`inboundEvents`).
Re-verified against a full branch scan including a newly-appeared branch,
`claude/ri-p-b1-tenant-first-webhooks` (an unrelated, unmerged, small tenant-scoping fix to
`dispatchWebhooks`'s subscription query — no file this work edits, so no collision either way).
