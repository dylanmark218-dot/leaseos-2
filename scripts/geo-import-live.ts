/**
 * v22.13 — A live import from Alberta's services. Run against a real database;
 * every row it writes carries its source, layer, run and retrieval time.
 *   pnpm exec tsx scripts/geo-import-live.ts 5 18 54
 */
import { appRouter } from "../server/routers";
import { grantUserRole } from "../server/db";

const [meridian, rangeNumber, township] = process.argv.slice(2).map(Number);
if (!meridian || !rangeNumber || !township) { console.error("usage: geo-import-live.ts <meridian> <range> <township>"); process.exit(1); }

const userId = 9_100_000 + Math.floor(Math.random() * 10_000);
await grantUserRole({ userId, role: "controller", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
const caller = appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

const sections = Array.from({ length: 36 }, (_, i) => i + 1);
let parcels = 0;
for (let i = 0; i < sections.length; i += 6) {
  const batch = sections.slice(i, i + 6);
  const run = await caller.geo.atsImportTownship({ meridian, rangeNumber, township, sections: batch });
  parcels += run.rowsWritten;
  console.log(`ATS sections ${batch[0]}-${batch.at(-1)}: fetched ${run.featuresFetched}, wrote ${run.rowsWritten}${run.truncated ? " (TRUNCATED)" : ""}`);
}
const coverage = await caller.geo.coverage();
const twp = coverage.townships.find(t => t.meridian === meridian && t.rangeNumber === rangeNumber && t.township === township);
console.log(`township parcels now: ${twp?.parcels ?? 0}`);

const [[minLat, minLng, maxLat, maxLng]] = [await (async () => {
  const db = await (await import("../server/db")).getDb();
  const rows = await db!.execute(`SELECT MIN(minLatitude) a, MIN(minLongitude) b, MAX(maxLatitude) c, MAX(maxLongitude) d FROM atsLegalSubdivisions WHERE meridian=${meridian} AND rangeNumber=${rangeNumber} AND township=${township}`) as unknown as [Record<string, number>[]];
  const r = rows[0][0];
  return [Number(r.a), Number(r.b), Number(r.c), Number(r.d)] as [number, number, number, number];
})()];
console.log(`township extent: ${minLat.toFixed(5)},${minLng.toFixed(5)} → ${maxLat.toFixed(5)},${maxLng.toFixed(5)}`);
const roads = await caller.geo.accessRoadsImport({ minLatitude: minLat, minLongitude: minLng, maxLatitude: maxLat, maxLongitude: maxLng });
console.log(`access roads: fetched ${roads.featuresFetched}, wrote ${roads.rowsWritten}${roads.truncated ? " (TRUNCATED — import a smaller box)" : ""}`);
console.log(`attribution: ${roads.attribution ?? "(none recorded)"}`);

for (const lsd of ["01-24-054-18-W5", "13-24-054-18-W5", "04-11-054-18-W5"]) {
  const r = await caller.geo.lsdLocate({ lsd });
  if (r.outcome !== "located") { console.log(`${lsd}: ${r.outcome} — ${r.reasons[0]}`); continue; }
  const a = r.access;
  console.log(`${lsd}: ${r.location!.descriptor} centroid ${r.location!.centroidLatitude.toFixed(6)}, ${r.location!.centroidLongitude.toFixed(6)}${a ? ` | access ${a.latitude.toFixed(6)}, ${a.longitude.toFixed(6)} (${a.featureTypeLabel}, ${a.metresFromCentroid} m${a.touchesParcel ? ", touches the parcel" : ""})` : " | no access point"}`);
}
process.exit(0);
