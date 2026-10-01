# Canadian provider runtime

How a provincial road event gets from a publisher to an approved route, and what stops it at each
step. This covers the runtime only. Which provinces publish what, and under which licence, is in
[`CANADIAN_PROVIDER_MATRIX.md`](CANADIAN_PROVIDER_MATRIX.md). The licence record itself is in
`DATA_SOURCES.md` and the `externalDataSources` table.

**Checkpoint record:** [`checkpoints/T1_CANADIAN_PROVIDER_RUNTIME.md`](checkpoints/T1_CANADIAN_PROVIDER_RUNTIME.md)
(gate-verified SHA, counts, environment).

**Production does not collect anything yet.** All the code below exists and is tested against a
real database, but nothing in production calls `runTransportFeedTick`. Turning collection on is an
owner decision; see [Production enablement](#production-enablement).

## The path

```
CANADIAN_TRANSPORT_PROVIDERS            _core/transport/providerRegistry.ts   endpoint, key variable, parser
  → providerRuntimeReadiness            same file                              rights → key → enabled → database
  → feedScheduler.tick                  _core/feedScheduler.ts                 backoff after failures
  → feedCollector.shouldPoll            _core/feedCollector.ts                 CLEARED / DUE / QUOTA / Retry-After
  → httpFeedFetcher                     _core/feedHttp.ts                      the only place a key is read; redaction
      over productionFeedClient()       server/transportFeedRuntime.ts         egress guard: https, public address only
  → parser + normalizer                 _core/transport/{ibi511,drivebcOpen511,quebecRoadworks}.ts
  → ingestFeed                          _core/feedIngest.ts                    supersede, never overwrite; guarded withdrawal
  → dbAdvisoryStore                     server/transportFeedRuntime.ts         roadAdvisories + externalFeedRuns (0081)
  → invalidateApprovalsForAdvisoryChanges   server/routeDependencies.ts       only routes whose geometry it touches
      → advisoriesOnRoute               _core/advisoryImpact.ts                geometry, never road names
      → recheckRouteApproval            server/routeDependencies.ts            the one staleness computation
  → routeApprovals.status = stale
  → composeReadiness                    server/readinessComposer.ts            route_approval_stale: blocking, manager-overridable
```

Every step was already in the code except the per-province adapters (previous checkpoint), the
database store, and the advisory dependency on an approval (this checkpoint). There is still one of
each: one collector gate, one ingester, one placement routine, one geography resolver, one staleness
computation. `spatial.routeApprovalCheck` and the feed runtime now both call `recheckRouteApproval`.
The function that computes a route's dependencies moved out of `spatialRouter.ts` into
`server/routeDependencies.ts`. Its logic did not change; the only addition is the live-advisory
dependency described below.

## Gates, in the order they are checked

| # | Gate | Where | Fails as |
|---|---|---|---|
| 1 | The provider has a published endpoint | `providerRuntimeReadiness` | `no_published_api` (Saskatchewan) |
| 2 | The registry row is `verified` **and** `commercialUsePermitted = yes` | `shouldPoll` (CLEARED) | `rights_review` |
| 3 | The key is configured, if the publisher needs one | `shouldPoll` | `credential_missing` |
| 4 | The owner has enabled it (`LEASEOS_TRANSPORT_FEEDS_ENABLED`) | `providerRuntimeReadiness` | `disabled` |
| 5 | A database exists to record runs and advisories in | `providerRuntimeReadiness` | `runtime_unavailable` |
| 6 | Not in backoff after failures | `feedScheduler.tick` | held, line says so |
| 7 | The publisher's `Retry-After` has passed | `shouldPoll` | refused `quota_exhausted` |
| 8 | Due by the publisher's update interval | `shouldPoll` | skipped, **no run row written** |
| 9 | Within the publisher's published rate limit | `shouldPoll` | refused `quota_exhausted` |

Rights are checked before the key. A key in the environment is never consulted for a source whose
licence is not recorded, so having a key cannot be what moves a source forward. Gate 2 used to check
only `status`. But `geo.sourceReview` can mark a row verified and leave `commercialUsePermitted` at
`unknown`, and the import gate (`geoRouter.sourceGate`) already refused that combination. The
collector now refuses it too.

Only providers that reach `ready` are passed to the scheduler. The others are reported and nothing
else happens: no request is built, no key is read, no run is written.

## Provider runtime matrix (2026-10-01, before any owner action)

| Source | Rights | Key | Enabled | Status |
|---|---|---|---|---|
| `drivebc_open511` | verified (OGL – BC) | not required | no | `disabled` → `ready` when enabled |
| `qc_mtmd_roadworks` | verified (CC BY 4.0) | not required | no | `disabled` → `ready` when enabled |
| `on511` | verified (OGL – Ontario) | `ON_511_API_KEY` | no | `credential_missing` until the key is set |
| `ab511` `mb511` `nb511` `yt511` `nl511` | **not verified** | held or obtainable | — | `rights_review`, with or without a key |
| `sk_highway_hotline` | not verified | — | — | `no_published_api`, never scraped |

## Snapshot safety, per provider

`ingestFeed` treats each of these as a full listing, so an event missing from the response is
withdrawn. That is only safe when the response really is the whole listing, and the evidence for
that differs by publisher:

| Provider | Paging | What counts as incomplete |
|---|---|---|
| DriveBC | `limit` capped at 500. The pagination block never says a listing was cut short. | A response that fills the page. `IncompleteSnapshotError`, nothing withdrawn. |
| Québec WFS | Reports `numberMatched` | Fewer features than `numberMatched`. Nothing withdrawn. |
| 511 platform (AB, ON, MB, NB, YT, NL) | None documented. One unpaged GET. | No paging signal exists to read. The two guards below apply. |

Two guards apply to every provider:

- **A rejected record holds withdrawal.** We don't know the rejected record's id, so the event it
  would have refreshed looks absent. Withdrawing on that basis would let a parser defect clear a
  closure. The records that did normalize are still ingested.
- **An empty listing does not withdraw while advisories are held.** An outage page or a quiet error
  returning `[]` is much likelier than every closure in a province ending in the same minute.

A response that fails to parse, is incomplete, or is empty while advisories are held is recorded as
a failed collection, not a success. The health screen's "last success" therefore means "last listing
we actually used".

## Lifecycle

- **Same event collected twice** → unchanged (content hash, excluding retrieval time). No new row.
- **Event changes** → a new row is inserted, and the old one is set to `superseded` with
  `supersededByAdvisoryRef` pointing to the new row.
- **Event absent from a complete listing** → `withdrawn`.
- **Nothing is deleted.** Every version stays in `roadAdvisories`, so a route approved under an old
  version can still be explained.
- **The same id twice in one listing** → handled once.

## Placement and the approval dependency

Advisories are placed on a route by geometry (`advisoriesOnRoute`), using the polyline from
`resolveRouteCommunicationGeography`:

- **Single point.** The radius is left null, so the 2 km default applies. A point is never placed
  with a tighter circle than the default.
- **Lines and polygons.** These become the smallest circle covering every coordinate plus a 250 m
  margin, and never less than the default.
- **Tolerance.** The boundary is inclusive. An advisory exactly at its radius is placed; one metre
  further is not.

`RouteDependencies.liveAdvisories` hashes the advisories placed on this route that are material:

| Material (moves the hash) | Shown on the route, does not move the hash |
|---|---|
| closures and restrictions, any severity | minor or informational construction, incidents, conditions |
| anything `major` | |
| anything of `unknown` severity | |

Each material advisory is identified by its id, type, severity and time window. Wording and
publisher timestamps are not part of the hash.

- **A closure appears on the route** → the hash moves → `stale` → readiness `route_approval_stale`
  (blocking, manager-overridable) → the verdict is no longer `eligible`.
- **A closure is downgraded, or ends** → that is also a change → `stale`. A person re-approves the
  route; the system never flips it back to approved.
- **Older approvals.** Approvals recorded before this field existed don't have it, and are compared
  only on what they carried.
- **No recorded graph build.** The approval has no geometry. Its value is a constant
  (`no_route_geometry`), so it never goes stale from an advisory. Readiness separately reports the
  missing geometry.

After a run, the runtime rechecks only the approvals whose geometry a changed advisory touches. That
includes the advisory's previous version, since a closure that moved or ended still touches where it
used to be.

The policy above lives in `isMaterialToRoute` (`server/routeDependencies.ts`). It is the owner's to
tune. DriveBC alone carries more than 200 minor construction events, and if each one sent an
approval back for review, dispatchers would learn to override the flag.

### A provider outage does not clear anything

If the publisher can't be reached, or returns a page that may be cut short, or returns an empty
listing, nothing is withdrawn. The advisories stay active, so the approval hash doesn't move, and a
route approved while a closure was live still carries that closure. The health screen reports the
feed as `unreachable`, `timeout` or `snapshot_incomplete`, not as fine.

There is one gap, and it is a policy decision. The approval hash covers advisories, not feed health.
A route approved while a feed was down records whatever advisories were held at that moment.
Lowering dispatch readiness whenever a feed is down would apply to every Alberta route for as long
as `ab511` is rights-blocked, so it was not done here. See owner decision 3 below.

## Health (`geo.transportFeeds`, permission `geo.source.review`)

Each provider reports:

- rights, key state, enabled, runtime status
- last attempted, last successful and last complete-snapshot time
- last error category and HTTP status
- records received and rejected
- whether the last snapshot was complete
- the number of active advisories

`state` is never a flattened "failed". The possible values are:

| Group | States |
|---|---|
| Working | `ok`, `never_collected`, `stale` |
| Not collecting, by design | `rights_blocked`, `credential_missing`, `disabled`, `database_unavailable`, `no_published_api`, `withdrawn` |
| Collection problems | `unreachable`, `timeout`, `destination_refused`, `credential_rejected`, `rate_limited`, `http_error`, `unexpected_response`, `parser_rejected`, `snapshot_incomplete` |

The 511 platform answers a bad key with `400 <Error><Message>Invalid Key</Message></Error>` (seen
2026-10-01). A 400 from a keyed source is therefore read as `credential_rejected`.

The same response carries the attribution projection: provider, jurisdiction, dataset, licence and
URL, required attribution text, source page, rights status and date, and `logoPermitted: false`.
This is what Settings → Legal → Maps, Routing & Government Data Sources will render. The page is
not built yet.

The response never contains:

- a key, or a key's variable name
- a request URL
- a publisher response body
- the recorded error text
- the review note, the reviewer, or internal notes

## Secrets

- **Declaration.** Key names are declared in `TRANSPORT_FEED_ENV_VARS` (`server/_core/env.ts`) as
  names only.
- **Where a key is read.** Only `httpFeedFetcher`, at request time.
- **Redaction.** Every error leaving the fetcher is redacted in both the raw and the URL-encoded form
  of the key. The query string carries the encoded form, which a raw-only redaction would miss for
  any key containing `+`, `/` or `=`.
- **Egress.** `productionFeedClient()` goes through the egress guard. That guard fixes the request
  headers, so a header-style credential is refused rather than silently dropped. All Canadian
  publishers take the key in the query string.
- **Tested leak paths:** thrown errors, egress refusals, error bodies that echo the key, recorded
  runs, tick log lines, readiness lines, the health and attribution response, and a recorded row
  whose text was never redacted.

## Rate limits and caching

- **Central collection.** One collector serves the whole fleet. No device calls a publisher, and
  devices read collected advisories.
- **Polling interval.** Each provider polls at most once per its registry interval: hourly for all
  of them. That is under 1% of the 511 platform's "Ten calls every 60 seconds".
- **Ten per minute is a ceiling, not a target.** The quota gate enforces it locally anyway.
- **Conditional requests.** None of the publishers send `ETag` or `Last-Modified` (checked
  2026-10-01), so conditional requests aren't possible. An unchanged listing is detected by content
  hash and costs no writes.
- **`Retry-After`.** It is honoured if a publisher sends one; the egress guard now passes that one
  header through. No publisher sends it today.
- **Backoff.** After failures, backoff doubles from 60 s up to 1 h (`DEFAULT_BACKOFF`).
- **One key per source.** The registry holds one key per source. Nothing rotates keys or identities
  to get around a limit.

An hourly interval is conservative for closures. Lowering it is an owner decision. The registry
column is in whole hours, so anything faster than hourly needs a schema change.

## Production enablement

This is not done in this checkpoint, on purpose. The SPINE moratorium ("no new engines until this
path is wired") and the instruction not to start a production scheduler both apply. What is missing
is the decision about where a recurring job runs, not code.

Steps to turn on B.C. and Québec:

1. **Decide where the tick runs, and record that decision as an owner ruling.** Main already has the
   pattern: `startProductionWorker` (`server/_core/productionWorker.ts`) runs Live Assist's purge on
   the worker heartbeat through `createSweepTicker` / `withSweepOnHeartbeat`. That was approved by
   its own owner ruling, `docs/live-assist/LA1A_OWNER_RULING.md`, and that ruling covers Live Assist
   only.

   A feed tick is a different risk. It makes outbound network calls (up to 60 s timeout each) from
   the same heartbeat the outbox drain loop awaits, so it needs its own ruling, and this checkpoint
   does not presume one.

   Once ruled, the change is one ticker:
   ```ts
   createSweepTicker({ run: at => runTransportFeedTick({ db, env: process.env, client: productionFeedClient(), now: at }) })
   ```
   The ticker should run at most every few minutes. The collector's DUE gate limits real publisher
   calls to one per interval, and a not-due provider writes no row.

   Alternatively, a separate cron process can call the same function. That avoids putting network
   waits on the drain heartbeat.
2. **Enable the sources.** Set `LEASEOS_TRANSPORT_FEEDS_ENABLED=drivebc_open511,qc_mtmd_roadworks`
   in the production environment.
3. **Check health.** Call `geo.transportFeeds` and expect `ok` with complete snapshots after the
   first tick.
4. **Ontario.** Register for a developer key, set `ON_511_API_KEY`, add `on511` to the enabled list,
   and check that the first run is not `credential_rejected`. On the first keyed call, also confirm
   the response content type. The client allows only `application/json`.

The rights-blocked 511s and Saskatchewan need written answers first
(`docs/P6_DATA_PERMISSION_REQUESTS.md` §6). Recording an answer is a `geo.sourceReview`. No code
changes are needed.

## Owner decisions this leaves open

1. Where the recurring tick runs (worker job, cron or other). This is the production blocker.
2. Whether `isMaterialToRoute` is the right materiality line.
3. Whether an unavailable or stale feed covering a route should lower dispatch readiness.
4. Whether hourly is the right collection interval for closures.
5. Whether an incomplete DriveBC page should be ingested incrementally (new closures visible,
   nothing withdrawn) rather than failed outright. It is failed today, as instructed.

## Known limits

- **Invalidation cost.** After a run that changed something, `invalidateApprovalsForAdvisoryChanges`
  resolves the geometry of every approved route that has a recorded graph build, then fully rechecks
  only those a changed advisory touches. That is fine at today's volume. At scale it wants a bounding
  box stored per approval, or a spatial index, so the first pass becomes a query rather than a loop.
- **The store is not transactional.** An ingest writes the new version, then supersedes the old one,
  as separate statements. If the process is interrupted between the two, two versions can be active
  until the next run supersedes the extra one; both stay on record. One process collects, by design,
  so two ticks never race.
- **Run notes carry the category.** The failure category and any `Retry-After` are stored as a
  prefix of `externalFeedRuns.errorText` (`[category retry-after=Ns] …`), because the table predates
  them and this checkpoint adds no migration. Dedicated columns would be a small follow-up migration
  if they are wanted.

## Tests

| File | What it proves |
|---|---|
| `server/canadianProviderRuntime.test.ts` | Readiness order; key redaction across every path; failure categories and `Retry-After`; withdrawal guards; placement conservatism and tolerance; attribution projection; Saskatchewan never fetched |
| `server/canadianProviderRuntime.db.test.ts` (MariaDB) | DriveBC, Québec and Ontario end to end; idempotence; supersession; outage, truncation and empty listings clear nothing; complete withdrawal; closure → stale → readiness not eligible; unrelated route untouched; tenant isolation; blocked 511s and Saskatchewan never requested |
| `server/canadianTransportProviders.test.ts` | Parsers against live-shaped fixtures |
| `server/transportDateContract.test.ts` | Province-local time without offsets, including B.C.'s permanent UTC−7 (needs the `.nvmrc` Node build) |
