# Intelligence Engine — Checkpoint 2: the ingestion pipeline, and amendments that reach the rules

Status: **built and tested end to end against fakes. Nothing has been fetched for real.**

All six seed sources are still unassessed. Running the pipeline today refuses every one of them
**before making a single request**. Assessing licences is a human step, and it is the critical path
(§5).

Builds on [Checkpoint 1](INTELLIGENCE_ENGINE_CHECKPOINT_1.md).

---

## 1. What a run does

`ingestion.ingestSource(sourceId, deps)` does one source per call, in this order. Each step is
recorded in a report, and the run returns rather than throws.

| Step | What it does | Network |
|---|---|---|
| catalogue | Loads the source row. Uncatalogued, or no collector for its format, means refused. | none |
| schedule | Skips when the last retrieval is newer than `refreshIntervalHours` (unless `force`) | none |
| decide | `decideFetch` with robots *unchecked*. **Any refusal other than `ROBOTS_UNCHECKED` stops here:** no licence, prohibited, retired, access-controlled, bad URL, no crawler contact. | **none** |
| robots | `fetchRobots` (RFC 9309). The result goes to `knowledgeSources.robotsStatus` / `robotsCheckedAt`. | 1 request |
| decide | Decides again with the real robots answer. The robots request counts against the source's delay, so the run sleeps it out. | none |
| collect | `HtmlCrawler` / `PdfCollector`: one GET with `redirect: "manual"`, ETag / Last-Modified validators, a byte ceiling and a content-type check | 1 request |
| document | One `knowledgeDocuments` row per URL, created `QUARANTINED` on first sight | none |
| extract | HTML: `extractHtml` → sections and a **text fingerprint**. PDF: hashed only (§4). | none |
| snapshot | `recordSnapshot`. Raw bytes are kept only if the licence permits `rag_ingestion`. | none |
| release / chunks | On a new version only: the licence gate, then `writeChunks`, each chunk under its heading | none |

The operator entry point is a script, deliberately not a router or the worker:

```bash
LEASEOS_CRAWLER_CONTACT=https://<who-to-contact> \
  pnpm exec tsx scripts/knowledge-ingest.ts --as <userId> [--seed] [--force] [--source <id> …]
```

Here is today's output against a fresh database, unedited:

```
ca-justice-sor-2005-313: REFUSED (0 requests)
  ✓ catalogue Commercial Vehicle Drivers Hours of Service Regulations (SOR/2005-313) (law)
  ✗ decide    NO_LICENCE_ASSESSMENT: "ca-justice-sor-2005-313" has no licence assessment; it is not fetched until someone has read its terms
… (the same for all six)
```

## 2. Amendments reach the rules: the loop this checkpoint closes

Main's rule ledger (`0189`, `promotionLedger`) promotes a rule only from a source revision that a
named person has marked `verified`. `rulesOnStaleSources` lists every current rule whose source
revision is no longer `verified`.

Checkpoint 1 recorded supersession only as a pointer, so a detected amendment never reached that
list. Now `recordSnapshot` does three things:

- It writes new versions as `candidate`, with `retrievedAt`. A machine never verifies.
- It marks the replaced revision `superseded`. A `withdrawn` revision stays withdrawn.
- It returns the `REGULATORY_CHANGE_DETECTED` signal, as before.

The result: when a publisher amends a page, every rule cut from the old text appears in
`rulesOnStaleSources` for a person to re-read, and no new rule can be promoted from the old text.
**The rule itself is not changed.** The deterministic figure moves only when a person re-verifies
and re-promotes. `knowledgeIngestion.db.test.ts` runs that whole loop:

1. ingest
2. a second person verifies the revision
3. a rule is promoted from it
4. the page is re-served with a new footer date — nothing happens
5. the page is amended — the rule is flagged and still `CURRENT`
6. a garbled response — nothing happens
7. a `304` — nothing happens

### Why versions compare extracted text, not bytes

Once a detected change can flag a verified rule, a false change is expensive. Government pages
change bytes on every request: footer dates, analytics, tokens. For example, Justice Laws pages
carry a Web Experience Toolkit `Date modified` block that changes independently of the regulation.

So:

- `knowledgeSnapshots.contentSha256` stays the **raw** hash. That is provenance: exactly what was
  served.
- `knowledgeVersions.contentHash` is the hash of the **extracted text** when a parser ran.
  `provenanceJson.fingerprintBasis` records which basis was used.

The extractor drops scripts, navigation, header, footer and the WET page-details block. It keeps
the regulation's own statements, such as "Last amended on …". A parse that fails is a new
`unparseable` outcome. It keeps the bytes as evidence, but makes no version and leaves the current
version standing.

The rule the extractor follows: when in doubt, it keeps text. A spurious review costs a person a
few minutes, but a missed amendment could leave a wrong rule in force.

I checked the extractor (outside the repository; nothing committed) on the live Justice Laws
SOR/2005-313 page and on Alberta and AER landing pages. Headings and section numbers came through
intact, and the WET date block was the only furniture that leaked. It is now stripped, and a test
pins that.

## 3. Collector rules, now enforced in code

- **Redirects are reported, never followed.** The note names the target. A redirect is how a crawl
  leaves its domain without anyone deciding it should. robots.txt is the exception: it follows up
  to 5 redirects, as RFC 9309 requires, but only within the source's domains.
- **`401`/`402`/`403`/`407` stop the run and keep nothing.** No credentials are ever offered.
- **Wrong content type means nothing is kept.** A login page served as `text/html` where a PDF was
  expected is the soft paywall this catches.
- **The byte ceiling is checked twice**: against `Content-Length`, then against the actual bytes,
  so a lying header cannot get past it.
- **Network failures become results**, recorded as `unavailable` snapshots, not exceptions.
- **robots.txt paths are compared as octets** (RFC 9309 §2.2.2). Escapes are normalised, which
  closes Checkpoint 1 risk 6.

## 4. Changes to Checkpoint 1's work

- `0197` (still unmerged, so edited rather than superseded) gains the `unparseable` outcome.
- AER Directive 047 and 058 were catalogued as `pdf`, but their home URLs are **HTML landing pages**.
  The PDF collector would have rejected them as the wrong content type, so they would never have
  ingested. Both are now `html`. The directive PDFs are the instruments and should be added as
  separate documents.
- Merged `main` (`b35bac4`, 232 commits). `0197` is still claimed only by this branch and now sits
  below main's head, as LA-1a's numbers do. `migrationLedger` applies it by name. Recorded in the
  collision register.

## 5. What is left, in order

1. **Licence assessments for the six seeds — a person, not code.** Record each through the existing
   assessment path (`registerSource` plus a `sourceGate` entry). For each, decide at least: linking,
   metadata, RAG ingestion (which also governs raw-byte retention) and commercial redisplay. The
   pipeline will do exactly what each assessment says.
2. Set `LEASEOS_CRAWLER_CONTACT` to a real, monitored address.
3. Run `scripts/knowledge-ingest.ts --seed` for the assessed sources and review the report.
4. **PDF text extraction.** PDFs are collected and hashed today, so their changes are detected.
   Extracting their text needs a parser library, which is a dependency decision I did not take
   unasked. Until then, PDF extraction stays `pending`.
5. **Directive PDFs and the Alberta HOS page** as their own documents. One URL per source is all a
   run handles today.
6. A **controller-only schedule** (the worker), once a source is assessed. Starting a timer before
   then would only log refusals.
7. Then Checkpoint 3: hybrid retrieval over the chunks — a FULLTEXT index first, then a decision
   on vectors.

## 6. Unresolved risks

- **Re-verification after a false amendment.** If an extractor fault ever produces a spurious
  change, the verified revision becomes `superseded` and cannot be re-verified. A person verifies
  the new candidate instead (same text, new revision) and re-promotes. That is safe, but it is
  work, which is why furniture-stripping is tested.
- **Switching fingerprint basis.** A document first hashed raw and later through the extractor
  will register one spurious change at the switch. This happens at most once per document, and
  only fails in the safe direction (a review). No document has been hashed yet, so it cannot
  happen to existing data.
- **The extractor is not a general HTML parser.** It is a conservative tag-stripper, chosen to
  avoid adding a DOM dependency to the production bundle. Badly nested markup can drop or merge
  text. When that happens it fails or keeps too much; it never invents text.
- **Licences are still in two places** (the code registry and `knowledgeSources`). This is Checkpoint
  1 risk 5, unchanged.
