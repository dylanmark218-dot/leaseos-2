/**
 * Intelligence Engine Checkpoint 2 — run ingestion for catalogued sources. Operator-run only.
 *
 *   LEASEOS_CRAWLER_CONTACT=https://… pnpm exec tsx scripts/knowledge-ingest.ts --as <userId> [--seed] [--force] [--source <id> …]
 *
 *   --as <userId>   the person running it; recorded on every document and snapshot. Required.
 *   --seed          (re)register the seed catalogue first. Never touches a licence column.
 *   --source <id>   limit the run; repeatable. Default: every seed source.
 *   --force         ignore each source's refresh interval.
 *
 * What it will actually do depends on the licence assessments, not on this script. A source with
 * none is refused before any request is made — which is every seed until a person assesses it — so
 * running this today makes zero network requests and prints why. A crawler contact is required; an
 * anonymous crawler does not run.
 */
import { SEED_CATALOGUE } from "../server/_core/knowledge/sourceCatalogue";
import { registerCatalogueEntry } from "../server/_core/knowledge/repository";
import { crawlerIdentity } from "../server/_core/knowledge/collectors";
import { ingestSource } from "../server/_core/knowledge/ingestion";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

const operator = Number(values("--as")[0]);
if (!Number.isInteger(operator) || operator < 1) {
  console.error("usage: knowledge-ingest.ts --as <userId> [--seed] [--force] [--source <id> …]");
  process.exit(1);
}

if (flag("--seed")) {
  for (const e of SEED_CATALOGUE) {
    const r = await registerCatalogueEntry(e);
    console.log(`catalogue ${e.sourceId}: ${r.written ? "registered" : `${r.code} — ${r.reason}`}`);
  }
}

const identity = crawlerIdentity(process.env.LEASEOS_CRAWLER_CONTACT);
if (!identity) console.warn("LEASEOS_CRAWLER_CONTACT is not set to an https or mailto URL; every source will be refused NO_CRAWLER_IDENTITY");

const sources = values("--source").length ? values("--source") : SEED_CATALOGUE.map((e) => e.sourceId);
let failed = 0;
for (const sourceId of sources) {
  const report = await ingestSource(sourceId, {
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    identity,
    operatorUserId: operator,
    force: flag("--force"),
  });
  if (report.result === "failed") failed++;
  console.log(`\n${sourceId}: ${report.result.toUpperCase()} (${report.requests} request${report.requests === 1 ? "" : "s"})`);
  for (const s of report.steps) console.log(`  ${s.ok ? "✓" : "✗"} ${s.step.padEnd(9)} ${s.detail}`);
  if (report.change) console.log(`  ! ${report.change.kind}: ${report.change.fromVersionRef} → ${report.change.toVersionRef}`);
}
process.exit(failed ? 2 : 0);
