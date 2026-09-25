# Intelligence Engine — Checkpoint 1: source catalogue and immutable provenance

Status: **built, tested, not wired.** Nothing is fetched. No collector exists. Every seeded source is
`unassessed`, and an unassessed source cannot be fetched, snapshotted or chunked.

This checkpoint is the provenance foundation for the LeaseOS industry intelligence engine: an
LLM/RAG layer specialised for trucking, oilfield service, waste and disposal, compliance and
accounting. It deliberately stops before crawling. The rule is: get provenance right on a handful of
authoritative sources first, and only then scale.

---

## 1. What the survey found, and how it changed the plan

The brief assumed a greenfield PostgreSQL/pgvector build. The repository is neither.

| Assumption in the brief | What is actually here | Consequence |
|---|---|---|
| PostgreSQL + pgvector | **MariaDB 10.11** via `mysql2` + Drizzle (`dialect: "mysql"`). CI runs `mariadb:10.11`. | No pgvector, and 10.11 has no vector type. Keyword retrieval already uses InnoDB `FULLTEXT` (`assistantAskRouter.retrieve`). Vector search is a Checkpoint 3 decision (§8). No new dependency added. |
| A source registry to build | `knowledgeSources` (0118) already holds a **licence assessment** per source, with four independent permissions and a permission-document rule | **Extended, not duplicated.** The catalogue columns sit beside the licence columns and can never write them. |
| Versioned snapshots to build | `knowledgeDocuments` (always created `QUARANTINED`), `knowledgeVersions` (effective range, supersedes/superseded-by), `knowledgeChunks` (each stamped with the authorizing assessment) | Snapshots added as the **retrieval-event** layer between document and version. |
| Authority tiers A–E to define | `admission.ts` already ranks seven levels (`law` … `unverified`) and refuses to let a lower one outrank a higher | Tiers are a **view** over those levels (`industryTaxonomy.TIER_OF`). One scale, not two. |
| Temporal gating to build | `admission.admit` already refuses superseded, not-yet-effective and expired material | Reused. Added `versionInForce`, which answers the historical question ("what applied on this date?") that `admit` does not. |
| Deterministic engines to protect | `admission.FORBIDDEN_AI_OUTCOMES` and `checkClaim` already bar the model from HOS hours, dispatch authorization, payroll, invoices and similar | Unchanged. This checkpoint adds no path from retrieval to a decision. |
| Tenant isolation to design | Organization material lives in `knowledgePassages` (tenant-keyed). `contextAssembly.assembleContext` refuses foreign-tenant blocks. The public corpus has **no tenant column**. | Kept structurally separate. `scopeHits` applies the same rule at ranking time. A test asserts that no corpus table grows a tenant column. |
| Rate limiting to design | `feedCollector.planFeedFetch` enforces published quotas for feeds (511: 10 calls/60 s) | `ApiIngestor` is described as building on it, not replacing it. |
| A crawl allow-list to design | `citationGuard.OFFICIAL_DOMAINS` lists publisher domains for citations | Left alone. Crawl scope is per-source (`domains`), which is narrower. |
| — | The only real licence assessment (`AB_511`) **blocks** 511 Alberta for commercial reuse | Seed domains are exact hosts (`www.alberta.ca`), so a crawl of Alberta carrier guidance cannot drift into `511.alberta.ca`. |

Guards that shaped the implementation:

- `knowledgeWritePaths.test.ts`: the corpus has **one writer**, `repository.ts`. Widened here to cover
  `knowledgeVersions` and `knowledgeSnapshots`.
- `engineReachability.test.ts`: every `_core` module must be reached from production or declared
  unwired. The four new modules are declared, and the pin moves from 63 to 67.
- `columnParity.test.ts` and `verify-parity.sh`: `schema.ts` and the migrations must agree column by
  column.
- The migration collision register: `0197` was claimed after scanning all 88 remote branches. The
  highest number held anywhere was `0196`, from PR #29.

## 2. The model

```
knowledgeSources ─┬─ licence half   (0118)  written only by registerSource, from a stored assessment
                  └─ catalogue half (0197)  written only by registerCatalogueEntry; never touches the licence half
        │
knowledgeDocuments   one logical document (a URL); created QUARANTINED; licence-gated lifecycle
        │
knowledgeSnapshots   one row per retrieval attempt, failures included; APPEND-ONLY (triggers)       (0197)
        │   └─ versionRef ─┐
knowledgeVersions    one row per distinct content; effective range; supersedes ⇄ superseded-by
        │
knowledgeChunks      text; authorizedByAssessmentId, versionRef, snapshotRef, contentHash, topics     (0197 cols)
```

### Retrieval outcomes (`provenance.classifyRetrieval`, recorded by `repository.recordSnapshot`)

| Outcome | Version | Notes |
|---|---|---|
| `first_seen` | new | |
| `unchanged` | existing one confirmed | an identical re-fetch or a `304` |
| `changed` | new, `supersedes` the last | also returns a `REGULATORY_CHANGE_DETECTED` signal |
| `unavailable` | none | the previous version stays in force: a page being down is not a rule being repealed |
| `hash_mismatch` | none | the hash is **recomputed from the bytes**, never taken from the collector. The raw-object pointer is discarded. |

A snapshot records: the URL (validated against the source's domains), retrieval time, collector
kind and version, HTTP status, content type, ETag, Last-Modified, byte length, recomputed SHA-256,
the collector's declared hash, the raw-object key, the previous snapshot, the resulting version,
stated publication and effective dates, parser version, extraction status and a provenance JSON
(which always names the licence assessment that allowed it).

### Immutability

- The `knowledgeSnapshots_no_delete` trigger refuses every `DELETE`.
- The `knowledgeSnapshots_append_only` trigger refuses every `UPDATE` except recording the
  extraction outcome, and allows that **once**, from `pending`.
- Versions are appended. The only mutation on an older version is filling its
  `supersededByVersionRef` pointer.
- Returning to earlier text is a *new* version, not a rewind.

### Refusals (nothing is written)

A snapshot is refused for:

- an uncatalogued, retired, unassessed or prohibited source;
- a document that belongs to another source;
- an unsafe or off-domain URL;
- an inverted effective range;
- **a raw-object key from a source whose licence does not permit `rag_ingestion`**. Keeping the
  original bytes is reproduction. The hash alone is still recorded, so change detection works
  before a licence arrives.

## 3. Authority tiers and taxonomy

| Tier | Levels (admission.ts) | Meaning |
|---|---|---|
| A | `law` | legislation, regulation, regulator directive |
| B | `official_guidance` | government guidance, official standard |
| C | `recognized_standard`, `manufacturer` | recognized industry body, OEM |
| D | `company_policy`, `operational` | company, facility or operator source |
| E | `unverified` | general web, community, AI inference |

`provenance.resolveClaims` settles competing claims about one fact, for a place and a date:

1. Claims from the wrong jurisdiction are **excluded**. They are not contradictions.
2. Claims that are not in force on the date are excluded, and so are claims with no effective date.
3. A directly applicable claim beats conditional federal material. Federal Canadian rules are
   *conditional* for a province because the carrier's operating status decides which regime applies.
4. Only the highest authority level is eligible. A lower level that disagrees is reported in
   `lowerAuthorityContradictions` and flagged for review. It never overrides.
5. If sources of equal authority disagree, **nothing prevails** and the claim goes to a person.
   Newer is not the same as superseding.

The taxonomy (`industryTaxonomy.INDUSTRY_TOPICS`) is a closed list of 32 topics in 10 groups,
covering everything the brief named. Unknown topics and empty topic lists are refused, because a
source with no topic is invisible to every category filter.

## 4. Collectors and crawler constraints

The eight collectors are declared in `collectors.COLLECTORS`, and **each one is a stub that throws
`CollectorNotImplemented`**: `ApiIngestor`, `HtmlCrawler`, `PdfCollector`, `BrowserCrawler`,
`GeoDataIngestor`, `SitemapCrawler`, `RssWatcher` and `CommonCrawlImporter`. Each takes an injected
`fetch`, clock and identity, so a real collector is testable without a network.

`decideFetch` is the one decision every collector must ask. It checks the following, and fails
closed on each:

| Constraint | Rule |
|---|---|
| Licence | No assessment means no fetch. A prohibited source means no fetch. |
| Access control | A source behind a login, paywall, subscription or CAPTCHA is never fetched. A `401`/`402`/`403`/`407` answer means **stop** (`accessSignal`), never retry with credentials. |
| URL | https only; no credentials, IP literals, internal hosts, non-default ports or punycode lookalikes; must be under the source's own domains |
| Identity | The `LeaseOSIntelligenceBot/0.1 (+contact)` user agent is required. **No contact configured means no crawl.** |
| robots.txt (RFC 9309) | Groups are matched case-insensitively, with fallback to `*`. The longest match wins, and allow wins a tie; `*` and `$` are supported. `4xx` means no restrictions and `5xx`/unreachable means disallow all (§2.3.1). A robots.txt older than 24 hours (§2.4) or never checked is **refused**. |
| Rate | At least 10 s between requests to one source by default, concurrency 1, and a byte ceiling. The catalogue validator refuses a delay under 1 s or concurrency over 4. |
| Common Crawl | Discovery and history only. A WARC record is a third party's copy, so the publisher's licence still governs and provenance must name both. |
| Audit | Every retrieval is a snapshot row, failures included, and snapshots cannot be deleted. |

## 5. Seed sources

These are in `sourceCatalogue.SEED_CATALOGUE`. **Every `homeUrl` was checked live on 2026-09-25.**

| sourceId | Tier | Topics | Note |
|---|---|---|---|
| `ca-justice-sor-2005-313` | A | hos_eld | Federal HOS regulations. Justice Laws also publishes XML. |
| `ab-tec-commercial-carriers` | B | nsc, inspections, cvip, permits | |
| `ab-tec-carrier-requirements` | B | hos_eld, permits, nsc | **No dedicated Alberta HOS/permit page was found.** This points at the requirements page, which links onward. Replace it when the page is confirmed; do not guess a path. |
| `aer-directive-047` | A | disposal_facilities, disposal_tickets, aer_petrinex, waste_classification | Release and effective dates go on the **version**, never on the source |
| `aer-directive-058` | A | waste_classification, disposal_facilities, environmental_compliance | |
| `aer-st107` | B | disposal_facilities, waste_classification | Refreshed daily once permitted. A facility dropping off the list is a change worth detecting. Reconcile with `shared/facilities.ts`; do not build a second directory. |

`licenceNotes` on each row points the human assessor at the first question to ask. **It is not an
assessment.** AER commercial-reuse terms are open for the same reason `DATA_SOURCES.md` already holds
ST37/ST102 unverified.

The catalogue is seeded by calling `registerCatalogueEntry`. Nothing calls it in production yet (§9).

## 6. Tenant boundary

- The public industry corpus (`knowledgeSources`, `knowledgeDocuments`, `knowledgeVersions`,
  `knowledgeSnapshots`, `knowledgeChunks`) has no tenant column, and a DB test asserts it never
  grows one.
- A catalogue entry carrying `tenantId`, `organizationId` or `companyId` is refused with
  `PRIVATE_MATERIAL`, rather than having its owner silently dropped.
- Organization documents belong in `knowledgePassages`, which is tenant-keyed, has a stated
  reproduction basis, and is written only by `assistantAskRouter`.
- `scopeHits` filters ranked hits to the public corpus plus the actor's own tenant. Owner-less
  private rows are refused. `contextAssembly` applies the same rule again before the model sees
  anything.

## 7. The deterministic boundary

The LLM/RAG layer may retrieve and explain. It does not calculate HOS, axle weights, certificate
expiry, invoice totals, GST or payroll. Those stay in `hos.ts`, the routing and axle engines,
`documentValidity`, the billing and GST paths and so on. `admission.FORBIDDEN_AI_OUTCOMES` and
`checkClaim` already make "decision" answers require binding, human-confirmed authority. Checkpoint 1
adds no route around that.

In time, the provenance model should let a deterministic rule cite the exact version it was
promoted from. `hosRuleLimitHistory` (0120) already records the promoted figure. Linking it to a
`versionRef` is a Checkpoint 4 item.

## 8. Retrieval: preparing for hybrid search on this database

Chunks now carry `versionRef`, `snapshotRef`, `contentHash` and `topicsJson`. With the source's
jurisdiction and authority level, that is every filter hybrid retrieval needs: province, date
through the version's effective range, topic, tier, and licence through `authorizedByAssessmentId`.

The recommendation for Checkpoint 3, in order:

1. **Keyword now:** add an InnoDB `FULLTEXT` index on `knowledgeChunks.text`. This is the pattern
   `knowledgePassages` already uses, and needs no dependency.
2. **Vectors:** decide between upgrading to MariaDB ≥ 11.7, which adds a native `VECTOR` type and
   index and keeps one database, and a sidecar index keyed by `chunkRef`. The sidecar is disposable
   and rebuildable from the corpus, so it is never a source of truth. **Do not add OpenSearch** until
   corpus size demands it.
3. Rank by combining both signals. Then pass everything through `admission.planAnswer`, which
   splits usable, reference-only and withheld hits, then `versionInForce` for the question's date,
   then `resolveClaims`.

## 9. Knowledge graph (architecture only)

Nodes are existing rows wherever they exist. The graph should be a relation table over IDs that
LeaseOS already owns, not a second copy of them.

| Node | Existing home |
|---|---|
| Regulation / document / version | `knowledgeDocuments`, `knowledgeVersions` |
| Jurisdiction | code (`CA-AB`) |
| Facility | `shared/facilities.ts`, the facility directory |
| Vehicle / unit | fleet tables |
| Driver, certificate | workforce, driver qualification |
| Company | organizations |
| Road segment | the road graph (`roadGraph*`, OSM loaders) |
| Waste class, TDG class | taxonomy / TDG tables |
| Permit, job, lease/LSD | dispatch, spatial tables |

Edges, each carrying `sourceVersionRef`, `effectiveFrom`/`effectiveUntil` and `assertedBy`
(regulation, a person, or an operational record):

- `APPLIES_TO` (regulation → vehicle class / operation type)
- `ACCEPTS` (facility → waste class)
- `HOLDS` (driver → certificate)
- `HAS_RESTRICTION` (road → limit)
- `LOCATED_AT` (lease → LSD)
- `REQUIRES` (job → TDG class / permit)
- `SUPERSEDES` (version → version; already modelled)
- `PUBLISHED_BY` (document → authority)

One rule carries over from the claim resolver: an edge asserted by a lower tier never removes or
contradicts one asserted by a higher tier. It is recorded beside it and flagged.

## 10. Change detection

`recordSnapshot` returns a `REGULATORY_CHANGE_DETECTED` signal on every `changed` outcome. The
signal carries the from/to versions and the source's authority level. Checkpoint 1 **returns** it
and does not route it.

The intended route is:

1. The signal goes onto the existing enforcement outbox.
2. The system looks up which chunks, promoted rules (`hosRuleLimitHistory`), Academy modules and
   forms cite the old version.
3. A review item is raised for each affected rule, weighted by tier.
4. A person confirms before any deterministic figure moves. `rulePromotion` already requires this.

A facility disappearing from ST107 is the same kind of signal, applied to a row instead of a
document.

## 11. Unresolved risks

1. **No licence is assessed for any seed source.** Until a person records assessments, Checkpoint 2
   cannot fetch anything. This is intended, but it is the critical path.
2. **The Alberta HOS/permit page is unconfirmed.** It needs a person to locate it.
3. **Re-extraction.** The extraction outcome is write-once per snapshot, so running an improved
   parser over an old snapshot currently needs a new retrieval. If that proves costly, Checkpoint 2
   should add an `extractionRuns` table. The snapshot itself should not become mutable.
4. **`knowledgeDocuments.contentHash` keeps the first-seen hash.** The current hash lives on the
   latest version and snapshot. Readers must use those.
5. **The licence registry is in code** (`sourceGate.REGISTRY`), while `knowledgeSources` also stores
   licence columns. `recordSnapshot` reads the code registry, as the existing `quarantineDocument`
   and `writeChunks` do. Unifying the two is outside this checkpoint and needs its own decision.
6. **robots.txt matching does not percent-normalise paths.** An encoded path could match
   differently from its decoded form. This must be addressed before a real crawler ships.
7. **Nothing is wired.** The model is proven by tests against MariaDB, but no router or job reaches
   it yet (declared in `engineReachability.test.ts`).

## 12. Recommended Checkpoint 2

"Assessed ingestion of the six seeds", in this order:

1. **Human step first:** record licence assessments for the six seeds, through the existing
   `registerSource` and assessment workflow. For each, answer at least linking, metadata, RAG
   ingestion and raw retention.
2. Set the crawler contact in environment config. Add a robots.txt fetch-and-cache step that writes
   `robotsStatus`/`robotsCheckedAt`.
3. Implement `HtmlCrawler` and `PdfCollector` only. They take injected `fetch` and are tested
   against recorded fixtures. Implement parsers that emit section, page and heading.
4. Add a controller-only job, not a public router, that runs, per due source:
   `decideFetch` → `collect` → `quarantineDocument` → `recordSnapshot` → `releaseFromQuarantine` →
   parse → `writeChunks` → `recordExtraction`. Every step is audited.
5. Route `REGULATORY_CHANGE_DETECTED` onto the outbox as a review item, with no automatic effect.
6. Remove the four modules from `DECLARED_UNWIRED` as they become reached.

Only then move to Checkpoint 3 (hybrid retrieval and citations), Checkpoint 4 (knowledge graph and
contradiction engine) and Checkpoint 5 (the agent wired into Field, Route, Vault, ELD/HOS, disposal
and accounting).
