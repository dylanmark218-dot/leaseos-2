# Approved external source registry (0233)

The registry answers one question before LeaseOS contacts a publisher: **has a person approved this exact
endpoint, for this purpose, as it stands today?** It is a control plane over sources, endpoints, approvals
and their history. It is not a host allowlist, and it does not replace the egress guard. It sits in front of
the guard and can only narrow what the guard allows.

| Piece | Where |
|---|---|
| Rules (pure) | `server/_core/sourceRegistry.ts` |
| Data access, change control, the runtime gateway | `server/sourceRegistryService.ts` |
| API (16 procedures, no UI) | `server/sourceRegistryRouter.ts`, mounted as `sourceRegistry` |
| Seeds | `server/_core/sourceRegistrySeeds.ts`; source identities in `server/_core/externalSourceSeeds.ts` |
| Schema | `drizzle/0233_external_source_registry.sql`; declarations in `drizzle/schema.ts` |
| Permissions | `server/_core/recordsAuthorization.ts` (`source.*`) |
| The one wired runtime path | `server/facilityDirectoryRouter.ts` (`facilityDirectory.arcgis.*`) |
| Network safety (unchanged boundary) | `server/_core/egressGuard.ts` |
| Tests | `server/_core/sourceRegistry.test.ts`, `server/sourceRegistry.db.test.ts`, `server/_core/egressGuard.test.ts`, `server/facilityDirectory.db.test.ts` |

## What existed, and what was reused

The repository already had most of the identity half of a source registry. The registry extends that instead
of adding a second model.

| Existing | Status before 0233 | Use in 0233 |
|---|---|---|
| `externalDataSources` (B20.8, 0024) | Identity, licence fields, licence review (`status`, `geo.sourceReview`) | **Extended**: approval `lifecycle`, `revision`, `rowVersion`, `revisionByUserId`, classification (`sourceClass`, `riskClass`, `sensitivity`), `termsUrl`. Licence review is untouched. |
| `providerCredentials` → `encryptedSecrets` (0192) | The credential store, holding references and envelopes | **Reused as is**. An endpoint names a credential by `credentialRef`. |
| `externalDatasetImports` (0024) | Declared, never written | **Adopted as the provenance record**: gains `endpointId`, `sourceRevision`, `approvalId`, `purpose`. |
| `externalFeedFetches` (0024) | Declared, never written | **Adopted as the fetch log**: gains `endpointId` and a `refused` outcome. |
| `facilityImportRuns` (0139) | The facility importer's run record | Gains `externalDatasetImportId`. |
| `facilitySourceLicences` (0139/0143) | The facility directory's licence register | **Unchanged**. The importer's licence gate still applies after the registry. |
| `egressGuard.ts` | https only, public addresses after DNS and at every redirect, pinned connection, limits | **Unchanged rules**. Two additions, both narrowing (see below). |

New tables: `externalSourceEndpoints`, `externalSourceApprovals` and `externalSourceEvents` (append-only,
enforced by triggers).

## Trust model: four questions, in order

1. **Identity.** Who publishes the source, under what licence and terms. This is the `externalDataSources`
   row. Licence review (`status`) is a separate decision from approval, and neither implies the other.
2. **Approval.** Has a person authorised LeaseOS to contact the source, for which purpose, and until when?
   This is the source's `lifecycle` plus an `externalSourceApprovals` row bound to one `revision` of its
   endpoints.
3. **Endpoint.** Exactly what may be contacted: host, port, method and path. This is
   `externalSourceEndpoints`, compared exactly.
4. **Network safety.** Whether this one request may leave the server. That is the egress guard, and only the
   guard.

The order of a request (`registryGet`, the only path from an approval to the network):

```
procedure permission (roleProcedure)          — business authorization, audited
→ checkEgressUrl(url)                          — the caller (arcgisGet) refuses an unsafe URL before the database
→ authorizeUrl: endpoint for host+port+path    — registry lookup, read fresh on every call
→ runtimeDecision: lifecycle, approval, revision, review-by, purpose, endpoint enabled, endpoint policy
→ (multi-page work) sameAuthority(pinned, now) — same source, endpoint, revision and approval as at the start
→ guardedGet(url, edges, effectiveLimits(endpoint, defaults))
     └ the guard's own checks, then destinationPolicy = the endpoint's rule, on the first URL and every redirect
→ record(): endpoint health + one externalFeedFetches row
```

No code path goes from "approved" straight to a fetch. `server/sourceRegistry.db.test.ts` checks this
structurally: no `fetch(` or socket import in the registry, its router or the importer; the importer calls
only `registryGet`; and `registryGet` contains the single `guardedGet` call.

## Relationship to the egress guard

The guard remains the final boundary. 0233 changes it in two ways, both narrowing:

- **`destinationPolicy`** (`EgressLimits`). This is an optional rule a caller adds. It runs after the guard's
  own URL check, on the first URL and on every redirect hop. A reason it returns refuses the hop with
  `unapproved_destination`, a destination refusal. A hop the policy accepts must still pass every guard rule:
  https, no credentials in the URL, a public address after DNS (re-resolved per hop, connection pinned). A
  policy that accepts everything still loses to a private answer, plain http and the metadata address
  (`egressGuard.test.ts`, "cannot admit what the guard refuses").
- **`EGRESS_CEILINGS`** (60 s, 32 MiB, 3 redirects). Each value is the largest any caller used when the ceiling
  was set. A request asking for more is refused (`limits`) before any lookup, not trimmed. Endpoint
  validation and a database CHECK enforce the same ceilings, so a registry row cannot widen a limit at any of
  the three layers.

The registry's `effectiveLimits` takes the caller's defaults, narrows the timeout and size to the endpoint's
values where set, replaces the content types with the endpoint's declared types, and adds the endpoint as
the destination policy. The guard still sends exactly three fixed headers. No registry value becomes a
header, a cookie or a credential.

## The data model

**`externalDataSources` (extended)**
- `lifecycle`, described below. Only `approved` authorises a request.
- `revision` increments whenever an endpoint changes what may be contacted. An approval covers one revision.
- `revisionByUserId` records who made the current revision; they may not approve it.
- `rowVersion` increments on every write. Each mutation names the version it read (`expectedRowVersion`);
  a mismatch is `CONFLICT`. This is the commercial-lifecycle convention.

**`externalSourceEndpoints`**
- The endpoint is stored as the WHATWG URL parser writes it: `hostname` (lower-case punycode, no trailing
  dot), `port`, `pathPrefix` (canonical, no trailing slash), `pathMatch` (`exact`/`prefix`), `httpMethod`,
  `serviceType`, `canonicalUrl`.
- Each endpoint declares its content types (from a fixed list) and may narrow `timeoutMs`/`maxBytes`
  within the ceilings.
- Authentication is `authScheme` plus `credentialRef`. A CHECK enforces that `NONE` binds no credential.
- `enabled` defaults to false.
- Health columns, described below.
- `endpointRef` (`<sourceKey>/<endpointKey>`) is unique.

**`externalSourceApprovals`** is a governance object, not a boolean.
- It carries the `sourceRevision` it covers and a `scopeJson` naming the purposes.
- States: `proposed` → `approved` | `rejected` | `superseded` | `revoked`.
- It records the requester and reason, the reviewer and note, the approver, a review-by `expiresAt`
  (at most 366 days), and the revoker and reason.
- CHECKs require the approver, time and expiry on an approved row, and the revoker, time and reason on a
  revoked row.

**`externalSourceEvents`** is append-only.
- One row per change: `eventType`, from and to lifecycle, revision, actor, reason, and a detail object
  holding field names and non-secret values.
- `actorUserId` is null only for seed events.
- Triggers refuse UPDATE and DELETE, following the convention of 0203.

## Lifecycle

The vocabulary is LeaseOS's existing approval words: draft, pending approval, approved, suspended, revoked,
retired. Approval rows use the versioned-approval words.

| From | Action (procedure) | To |
|---|---|---|
| draft, approved, suspended, revoked | `requestReview` | pending_approval |
| pending_approval | `approve` | approved |
| pending_approval | `reject` | draft |
| approved | `suspend` | suspended |
| suspended | `resume` (only while the standing approval still covers the current revision and is unexpired) | approved |
| pending_approval, approved, suspended | `revoke` | revoked |
| any but retired | `retire` (also disables every endpoint and revokes open approvals) | retired |

- **Draft and pending never authorise.** The runtime refuses every state except `approved`, with codes
  `not_approved`, `suspended`, `revoked` and `retired`.
- **An edit that changes what may be contacted reopens review.** This covers a new host, port, path, path
  match, method, service type, content type, limit, auth scheme or credential, and enabling an endpoint.
  - The source moves to a new revision. Its approval and any open request are superseded.
  - An approved or suspended source goes back to `pending_approval`, with a request raised by the editor and
    the prior scope.
  - The editor may not approve it.
- **Disabling an endpoint only narrows**, so it takes effect at once with no new revision.
- **Approval checks.**
  - An open request must exist for the current revision.
  - The approver must not be the requester and must not have made the revision.
  - The review-by date must be in the future and within 366 days.
  - At least one endpoint must be enabled.
- **Renewal** is a fresh `requestReview` and approval. Requesting a review stops an approved source until the
  new request is approved.

## Who may do what

There is no single "integration admin" permission. Each act has its own:

| Permission | Procedures | management | controller | safety | auditor |
|---|---|---|---|---|---|
| `source.directory.read` | `list`, `get` | ✓ | ✓ | ✓ | ✓ |
| `source.health.review` | `health` | ✓ | ✓ | ✓ | ✓ |
| `source.registry.submit` | `seed`, `create`, `update`, `requestReview` | ✓ | ✓ | ✓ | |
| `source.endpoint.edit` | `endpointAdd`, `endpointUpdate` | ✓ | ✓ | ✓ | |
| `source.credential_ref.edit` | `credentialBind` | ✓ | ✓ | | |
| `source.registry.review` | `reject` | ✓ | ✓ | | |
| `source.registry.approve` | `approve`, `resume` | ✓ | ✓ | | |
| `source.registry.suspend` | `suspend` | ✓ | ✓ | ✓ | |
| `source.registry.revoke` | `revoke`, `retire` | ✓ | ✓ | | |

- Safety can propose, configure and *stop* a source at once (suspend), but cannot approve, reject, revoke or
  bind a credential.
- Review, approve, suspend, revoke, endpoint edit and credential-reference edit are in
  `SENSITIVE_PERMISSIONS`. Their audit row in `authorizationDecisions` must be written, or the call fails
  closed.
- Every mutation also writes its own `externalSourceEvents` row in the same transaction.
- Holding a permission does not override separation of duties.

## Endpoint policy (host, port, path, method)

- **Parsing is the URL parser's.** There is no custom URL parsing. `parseEndpointBase` refuses a base URL
  whose raw path differs from the parser's (`..`, `.`, a space), carries `%2f`, `%5c`, `%2e` or a backslash,
  has an empty segment, a query, a fragment or credentials, or is not https on a public DNS name.
  - IP literals, `localhost`, `.local`, `.internal`, `.home.arpa` and single labels are refused.
- **Hosts compare as exact strings** of the parser's output, never as substrings. `evil-example.com`,
  `example.com.attacker.tld`, `sub.example.com` and `xample.com` do not match `example.com`. An IDN matches
  only in its punycode form.
- **Ports compare exactly.** An explicit `:443` is the default port.
- **Paths compare on a segment boundary** after the parser has resolved `..`, `%2e%2e` and `.%2e`. So
  `/layer/17/../../other` is judged as `/other`, and `/layer/170` is not inside `/layer/17`. An encoded
  separator (`%2f`, `%5c`) in a request path is refused.
- **Method** must equal the endpoint's. A webhook endpoint is POST; everything else is GET.
- **Selection.**
  - The longest covering prefix governs whether or not it is enabled, so disabling a specific endpoint is
    never undone by a broader one.
  - Among equal prefixes, the enabled endpoint governs. Two enabled ties are refused as `ambiguous`.
  - Enabling a second endpoint that would tie with an enabled one anywhere in the registry is refused at
    write time (`CONFLICT`).
  - An endpoint whose source row is gone governs and blocks nothing.
- **An ArcGIS endpoint is one layer**: `…/rest/services/…/FeatureServer|MapServer/<id>`, prefix match. The
  importer can therefore reach that layer's `?f=pjson` and `/query`, and nothing beside it.

## Credentials

- **The registry holds references, never values.** `credentialBind` accepts `{authScheme, credentialRef}`
  only, with a strict schema; an extra field is refused.
- The reference must name an **active** `providerCredentials` row whose `providerKey` is this source and whose
  scheme matches.
- **Disclosure.** An endpoint view reports `credentialBound: true|false`, never the reference.
  - The `credential_bound` event records the scheme and the reference. The reference is a pointer that only
    the credential store can resolve.
  - Nothing the registry returns, logs or records carries a `secretRef`, a fingerprint or an envelope
    (`server/sourceRegistry.db.test.ts`).
- **Rotation** binds a new reference. On an enabled endpoint that is a new revision, so the source goes back
  for review before the new credential is used.
- **Presentation is not wired.** `registryGet` sends no credential: the guard has no header path for one,
  and the one wired integration needs none. Credentialed fetches remain a design extension point (see
  below). They must resolve the reference at request time and attach only the scheme's header under the
  guard's outbound-header policy.

## Licence and terms

The registry records what is known — `licenceName`, `licenceUrl`, `termsUrl`, `attributionText`,
`commercialUsePermitted`, `redistributionPermitted` (`yes`/`no`/`unknown`) — and draws no legal conclusion.

- **Licence review and approval are separate.** Licence review is the existing `status` and
  `geo.sourceReview`. Approval to contact a source says nothing about whether its data may be cached,
  redistributed or used commercially.
- The two facility sources are seeded `unverified` with commercial use and redistribution `unknown` and no
  attribution text, as every unverified seed is.
- The facility importer still requires a confirmed, cache-permitted licence in `facilitySourceLicences`.

## Provenance

Every import through the facility importer writes one `externalDatasetImports` row before its run row. The
row records:
- source, endpoint, source revision, approval id and purpose;
- `datasetKey` (the endpoint ref) and `datasetVersion` (the layer's own `editingInfo` last-edit stamp, when
  it publishes one);
- `sourceFormat` (`arcgis_json`, or `arcgis_json_supplied` for `importFeatures`), and the SHA-256 of the
  bytes read (metadata plus every page) or of the supplied features;
- the importer version (`facilityDirectory.arcgis@0233`), feature count, coordinate system, retrieval time
  and the importing user.

`facilityImportRuns.externalDatasetImportId` points at that row. The import's answer returns
`{datasetImportRef, sourceKey, endpointRef, sourceRevision}`.

## Concurrency and change control

- **Two writers at once.** Each mutation locks the source row (`SELECT … FOR UPDATE`) and checks
  `expectedRowVersion`. Of two simultaneous approvals, exactly one succeeds and the other is `CONFLICT`
  (tested).
- **A revocation, suspension or endpoint edit during an import** stops it at the next page. Every page is
  authorised against the database again and checked with `sameAuthority` against the decision the import
  started under. A source revoked and re-approved mid-import is a different approval, and the old import
  stops (`changed_during_operation`).
- **Before anything is written**, the importer asks the registry once more. A change after the last page
  records nothing.
- Revision, approval id and actor are recorded in the event history and in each provenance row.

## Health and change detection

| Item | Status |
|---|---|
| Per-endpoint health summary: last attempt, success and failure, consecutive failures, last outcome, last HTTP status. Updated on every registry-governed request, including refusals of a registered endpoint | **Implemented** |
| Fetch log: one `externalFeedFetches` row per request (path only, never the query string; SHA-256 of a 2xx body), and refusals by the registry or the network | **Implemented** |
| Schema drift: SHA-256 of the sorted field list on `inspect`/`importFromLayer`; a change sets `schemaChangedAt`, and `inspect` reports `schemaChanged` | **Implemented** |
| Upstream version: the layer's last-edit stamp recorded as `datasetVersion` | **Implemented** |
| Review-by expiry enforced on every request | **Implemented** |
| Scheduled health probes (today health reflects only real requests) | Design extension point only |
| Automatic suspension on repeated failure or schema drift (the columns exist to drive it; a person decides today) | Design extension point only |
| Alerts or notifications for drift, failures, or an approaching review-by date | Design extension point only |
| Detecting a change to a publisher's licence or terms page | Design extension point only |
| Presenting a bound credential through `registryGet` | Design extension point only |
| The 511 collector consulting the registry (its endpoints are seeded disabled; it keeps its own licence and owner gates) | Design extension point only |

## Seeds (only what the repository already reads)

`sourceRegistry.seed`, or `seedRegistry()`, inserts what the database lacks and changes no existing row.

- **The facility directory's three regulator layers**, enabled, prefix match, no authentication:
  - Saskatchewan Petroleum Facilities (`SK_FACILITIES.layerUrl`, the importer's own preset);
  - the two BC Energy Regulator layers named in `docs/facility-map/IMPORTER_SPECS_2026-09-17.md`.

  Their sources (`sk_petroleum_gis`, `bcer_gis`) are seeded as **requests** for approval, with the
  repository evidence as the reason and no requester. A manager still approves each one; a seed is never an
  approval.
- **The road-information endpoints**, derived from `CANADIAN_TRANSPORT_PROVIDERS` so the registry and the
  collector cannot disagree about an address. They are seeded disabled with no credential, and no review is
  opened: nothing consults them yet.
- An endpoint seeded into a source that is already past draft lands disabled, because enabling it needs
  review.

## Operating it

- **Onboarding a source**
  1. `create` (draft).
  2. `endpointAdd` (enabled), and `credentialBind` if the endpoint needs a credential.
  3. `requestReview` with a purpose and a reason.
  4. A different person with `source.registry.approve` calls `approve` with a review-by date and a note.
- **After deployment, for the facility importer**: `seed`, then a manager approves `sk_petroleum_gis` and/or
  `bcer_gis` as they stand. Until then the importer refuses with `BLOCKED — source registry: … is pending
  approval`.
- **Incident**
  - `suspend` stops every request at once (safety may do this).
  - `resume` needs the approval to still cover the source.
  - `revoke` withdraws authority. The next request is refused, and an import in progress stops at its next
    page.
  - `retire` ends a source for good.
- **Credential rotation**: create the new credential in the credential store, then `credentialBind` the new
  reference, then re-approve.
- **Review-by date passed**: requests are refused (`approval_expired`) until a fresh request is approved.

## API

All procedures are `roleProcedure`, with no bare `protectedProcedure`. Every mutation of an existing source
takes `expectedRowVersion`, and every change except `seed` takes a 10–1000 character reason. Errors map as follows:

| Registry error | tRPC code |
|---|---|
| not found | `NOT_FOUND` |
| version conflict | `CONFLICT` |
| separation of duties | `FORBIDDEN` |
| invalid | `BAD_REQUEST` |
| a runtime refusal | `PRECONDITION_FAILED` |

No procedure contacts a source.

`list`, `get` (endpoints, last 20 approvals, last 50 events), `health` (endpoints and the last 50 fetches),
`seed`, `create`, `update` (identity and terms only; no revision), `endpointAdd`, `endpointUpdate`,
`credentialBind`, `requestReview`, `reject`, `approve`, `suspend`, `resume`, `revoke`, `retire`.

## Migration safety (0233)

- Forward-only and additive: new columns are nullable or defaulted, and no row is rewritten or deleted.
- Every existing source starts `draft`, which authorises nothing.
- No foreign keys. Explicit named indexes and CHECKs.
- Numbered after a scan of every open branch (`MIGRATION_COLLISION_REGISTER.md`).
- No column can hold a secret.
