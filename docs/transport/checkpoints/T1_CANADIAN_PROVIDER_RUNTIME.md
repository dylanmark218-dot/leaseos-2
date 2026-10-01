# T1 — Canadian provider runtime: collection path proven, production scheduling not enabled

**Status:** implemented and gate-verified on `claude/canadian-transport-licensing-oab59q`; not merged.

| | |
|---|---|
| Base | `main` @ `2a76920` (merge of #60). The previous tranche of this branch, the provider adapters, merged earlier as #25 |
| Implementation commits | `cbc2997` (runtime, store, route dependency, docs) · `4113b78` and `6a54738` (pin moves only) |
| Gate-verified SHA | `6a54738` — the full repository gate, from a fresh database, exit 0 |
| Migration | **none**. Head unchanged at `0209_operating_zone_scope.sql` (186 migrations, 429 tables). `externalFeedRuns` and `roadAdvisories` (0081) already held every fact needed |
| Runtime | Node **22.23.3** (`.nvmrc`), ICU 78.3, tz **2026c** · pnpm 10.4.1 · **MariaDB 10.11.14** |
| Production scheduling | **not enabled.** Nothing calls `runTransportFeedTick`. `LEASEOS_TRANSPORT_FEEDS_ENABLED` is declared by name only and set nowhere. No key value is in the tree |

The design and its open decisions are in [`../CANADIAN_PROVIDER_RUNTIME.md`](../CANADIAN_PROVIDER_RUNTIME.md).
The per-province record is in [`../CANADIAN_PROVIDER_MATRIX.md`](../CANADIAN_PROVIDER_MATRIX.md).

## What is proven

| Claim | Proof |
|---|---|
| Provider runtime runs end to end through the canonical collector, fetcher, ingester, scheduler and placement | `canadianProviderRuntime.db.test.ts` — DriveBC, Québec and Ontario through `runTransportFeedTick` on MariaDB |
| Rights gating: a key never overrides an unrecorded licence | AB, MB, NB, YT and NL stay `rights_review` with keys set, and the HTTP layer is never reached (pure and DB) |
| Rights gating: a verified row with commercial use `unknown` is refused | `shouldPoll` extension, pure test |
| Credential gating | Ontario without a key is `credential_missing`, makes no request, writes no run and records no error. With a key it makes one request through `feedHttp` |
| Key secrecy | No raw or URL-encoded key in thrown errors, egress refusals, echoed error bodies, recorded runs, tick log lines, readiness lines, or the `geo.transportFeeds` response |
| DB ingest lifecycle | Idempotent re-collection · supersession linked by `supersededByAdvisoryRef` · complete-listing withdrawal kept on record (no row deleted) · a feed not yet due writes no run |
| Snapshot safety | An outage, a page filling DriveBC's 500 cap, an empty listing, or a listing with a rejected record withdraws nothing |
| Route staleness | A closure on an approved route → `stale` (`changed: ["liveAdvisories"]`) → readiness `route_approval_stale`, blocking → verdict not `eligible`. Minor work on another route leaves it approved. A severity change rechecks only the routes it touches |
| Tenant isolation | Org A's affected approval goes stale. Org B's is untouched, and B cannot read A's |
| Saskatchewan | Never scheduled and never requested. The Hotline host appears in production code only as an attribution link (structural test) |

## Gate result at `6a54738`

Command: `DATABASE_URL=mysql://root@127.0.0.1:3306/<fresh db> bash scripts/ci-gate.sh`, using the
pinned Node.

| Gate | Result |
|---|---|
| 0a runtime version truth | Node 22.23.3 · tz 2026c |
| 0 reserved migration slots | untouched |
| 1–3b clean DB, migrations, table parity, 0207 backfill | pass · 0170 verified |
| 4 typecheck · test-file ratchet | clean · 0 errors (pin 0) |
| 5 procedure census | pass |
| 6 test suite | **436 / 436 files · 6,645 passed · 3 skipped · 0 failed** |
| 6b fixture isolation | 4 files, 67 tests, verified |
| 7 build · 7a production-only boot | pass · `dist/index.js` and `dist/worker.js` boot with production dependencies only |
| 7b / 7c external and machine gates | 36 / 2, pinned |
| 8 current-state document | current (703 role-authorized procedures) |
| **exit** | **0 — PASS** |

Focused suites inside that run:

| Suite | Tests |
|---|---|
| `canadianProviderRuntime.test.ts` (pure) | 32 |
| `canadianProviderRuntime.db.test.ts` (MariaDB) | 14 |
| `canadianTransportProviders.test.ts` | 32 |
| `transportDateContract.test.ts` | 17 |
| `feedCollector` / `feedIngest` / `feedHttp` / `advisoryImpact` | 14 / 12 / 14 / 12 |
| `externalSourceSeeds` / `alberta511Gate` / `sourceReview` | 35 / 17 / 6 |
| `structures` / `geographyAgreement` / `regulatoryDataDiscipline` | 6 / 10 / 8 |
| `engineReachability` / `procedureAuthorization` / `operationalApiAuthorization` / `crossLayerIntegrity` | 5 / 39 / 37 / 4 |

## Baseline, for attributing failures

Untouched `main` @ `2a76920` passed the same gate in the same environment: 434 files, 6,599 passed,
3 skipped, exit 0. The branch's first full run, at `cbc2997`, failed 4 tests, and all 4 were this
branch's own pins:

- **`structures.test.ts` ×2** — the dependency-key list now includes `liveAdvisories`. Fixed in
  `4113b78`.
- **`regulatoryDataDiscipline`** — one of the two windowed restriction read paths moved to
  `routeDependencies.ts`; the test now reads both files and asserts each still windows. Fixed in
  `6a54738`.
- **`crossLayerIntegrity`** — the mounted surface went from 752 to 753 for `geo.transportFeeds`.
  Fixed in `6a54738`.

No failure was pre-existing.

## Provider runtime matrix at close

| Source | Rights | Key | Status |
|---|---|---|---|
| `drivebc_open511` | verified, OGL – BC | not required | `disabled` — `ready` once the owner enables it |
| `qc_mtmd_roadworks` | verified, CC BY 4.0 | not required | `disabled` — `ready` once the owner enables it |
| `on511` | verified, OGL – Ontario | required, absent | `credential_missing` |
| `ab511` `mb511` `nb511` `yt511` `nl511` | not verified | held or obtainable | `rights_review` |
| `sk_highway_hotline` | not verified | — | `no_published_api`, never scraped |

## Outstanding — owner

1. **Where the recurring tick runs.** This is the production blocker. It needs an owner ruling, like
   `docs/live-assist/LA1A_OWNER_RULING.md` was for the Live Assist sweep.
2. Enable `drivebc_open511` and `qc_mtmd_roadworks`.
3. Register for and set `ON_511_API_KEY`.
4. Send the six tracked rights requests and the Ontario logo question
   (`docs/P6_DATA_PERMISSION_REQUESTS.md` §6, §7). All are marked NOT SENT.
5. Policy calls listed in the runtime document:
   - the materiality line
   - feed health in readiness
   - the collection interval
   - incremental ingest of a truncated page

Register row: `docs/REMAINING_BUILD_REGISTER.md` P6.12.
