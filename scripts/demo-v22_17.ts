/**
 * v22.17 live demonstration — not a test.
 *
 * Imports the Alberta access-road layer for one township from the captured
 * fixture, builds a graph over it, records the channels a road operator's
 * road-use document would state, and computes a real route with its
 * communication plan. Everything below is read off the running system.
 */
import { readFileSync } from "node:fs";
import { appRouter } from "../server/routers";
import { grantUserRole } from "../server/db";
import { setGeoFetcher } from "../server/geoRouter";
import type { FeatureCollection } from "../server/_core/geoImport";
import type { DomainRole } from "../server/_core/recordsAuthorization";

const roads = JSON.parse(readFileSync("server/fixtures/geo/roads_54_18_w5.geojson", "utf8")) as FeatureCollection;
let seq = 9_100_000 + Math.floor(Math.random() * 500_000);   // fresh identities each run; role grants persist
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const line = (s = "") => console.log(s);
const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  const controller = await withRole("controller");
  const controller2 = await withRole("controller");
  const safety = await withRole("safety");
  const driver = await withRole("driver");
  const shop = await withRole("shop_lead");
  const dispatcher = await withRole("dispatcher");

  setGeoFetcher(async () => roads);

  /* ---- 1. import Alberta's own road layer, and build the graph ---- */
  const imported = await caller(controller).geo.accessRoadsImport({ minLatitude: 53.62, minLongitude: -116.66, maxLatitude: 53.72, maxLongitude: -116.5 });
  const graph = await caller(controller).geo.graphBuild({ label: "TWP54 RGE18 W5 — demo", minLatitude: 53.6, minLongitude: -116.7, maxLatitude: 53.75, maxLongitude: -116.45 });

  line("IMPORT   " + `${imported.rowsWritten} road segments from ${imported.sourceKey}`);
  line("GRAPH    " + `${graph.segmentsConsidered} segments → ${graph.routableEdges} routable edges, ${graph.nodes} nodes, ${graph.components} components`);

  /* ---- 2. the channel registry ---- */
  const seeded = await caller(controller).comms.channelSeed();
  const listed = await caller(controller).comms.channelList({ verifiedOnly: false });
  line("CHANNELS " + `${seeded.inserted} seeded — ${listed.verified} verified, ${listed.unverified} unverified`);

  /* ---- 3. a route across real geometry ---- */
  const unitId = 1;
  const vehicle = { grossWeightKg: 31_500, maxAxleGroupKg: 24_000, heightM: 4.15, widthM: 2.6, lengthM: 27.5, dangerousGoods: false, requiresEscort: false };
  const checks = ["road_weight_restriction", "bridge_capacity", "overhead_clearance", "seasonal_closure"];
  const from = { fromLatitude: 53.62091, fromLongitude: -116.50758 };
  const to = { toLatitude: 53.69944, toLongitude: -116.54345 };

  const bare = await caller(dispatcher).geo.routeCompute({ ...from, ...to, vehicle, requiredChecks: checks });
  if (bare.outcome !== "evaluated" || !bare.path) { line(`ROUTE    ${bare.outcome}: ${bare.reasons.join("; ")}`); return; }
  line("ROUTE    " + `${bare.path.segments.length} segments, ${bare.path.kilometres} km via ${bare.path.segments.find(s => s.label && !/^Access road/.test(s.label))?.label ?? bare.path.segments[0].label}`);
  line("VERDICT  " + `${bare.verdict!.dispatchStatus} · legal ${bare.verdict!.legal} · unknown ${bare.verdict!.unknownCount} · failing ${bare.verdict!.failingCount}`);

  /* ---- 4. the same route, before anybody has said anything about radio ---- */
  const silent = await caller(dispatcher).geo.routeCompute({ ...from, ...to, vehicle, requiredChecks: checks, includeCommunications: true, unitId });
  const s = silent.outcome === "evaluated" ? silent.communications! : null;
  line();
  line("COMMS (nothing recorded)");
  line("         " + `verdict ${s!.verdict} · ${s!.unknownChannelKm} km of ${s!.totalKm} km with no channel on record`);
  line("         " + s!.explanation);

  /* ---- 5. record what an operator's road-use document actually says ---- */
  const segs = bare.path.segments.map(x => x.segmentId);
  const firstHalf = segs.slice(0, Math.ceil(segs.length / 2));
  const secondHalf = segs.slice(Math.ceil(segs.length / 2));
  for (const segmentId of firstHalf) {
    await caller(safety).comms.assignmentRecord({ segmentId, channelKey: "LAD-4", authorityTier: "operator_instruction", roadName: "Forestry Trunk Road", sourceKey: "operator_doc", sourceCitation: "Operator road-use procedures", callDirectionLoaded: "decreasing_km", callIntervalKm: 5, mustCallKm: [2, 4, 6] });
  }
  for (const segmentId of secondHalf) {
    await caller(safety).comms.assignmentRecord({ segmentId, channelKey: "AB-163.050", authorityTier: "company_entry", roadName: "Lease access", sourceKey: "company" });
  }
  // Cellular runs out partway along.
  for (const segmentId of secondHalf) {
    await caller(safety).comms.coverageRecord({ segmentId, medium: "cellular", state: "unavailable", authorityTier: "driver_observation", sourceKey: "field_observation" });
  }

  const planned = await caller(dispatcher).geo.routeCompute({ ...from, ...to, vehicle, requiredChecks: checks, includeCommunications: true, unitId });
  const p = planned.outcome === "evaluated" ? planned.communications! : null;
  line();
  line("COMMS (operator document recorded)");
  for (const z of p!.zones) {
    line("         " + `KM ${pad(`${z.fromKm}–${z.toKm}`, 12)} ${pad(z.channelKey ?? "—", 12)} ${pad(z.transmit, 24)} ${z.transmitReasons[0] ?? ""}`);
  }
  line("         " + `verdict ${p!.verdict} · must-call at km ${p!.mustCall.map(m => m.atKm).join(", ") || "none"}`);
  const cell = p!.coverage.find(c => c.medium === "cellular")!;
  line("         " + `cellular: ${cell.availableKm} km available, ${cell.unavailableKm} km unavailable, ${cell.unknownKm} km unknown`);

  /* ---- 6. verify the channel, licence the company, equip the truck ---- */
  const seg0 = segs[0];
  await caller(controller2).comms.channelVerify({ channelKey: "LAD-4", sourceUrl: "https://ised-isde.canada.ca/", sourceVersion: "B1 as published" });
  const auth = await caller(controller).comms.authorizationRecord({ channelKey: "LAD-4", authorized: true, licenceRef: "L-88231", licenceExpiresAt: new Date("2027-06-30"), provinces: ["AB"] });
  await caller(controller2).comms.authorizationVerify({ authorizationRef: auth.authorizationRef, evidenceRecordId: 1 });
  await caller(shop).comms.unitCapabilitySet({ unitId, vhf: true, cb: true, programmingProfileRef: "AB-NORTH-07", programmingProfileVersion: "22", programmedChannelKeys: ["LAD-4", "CB-19"] });

  const gp = { latitude: 53.62091, longitude: -116.50758, province: "AB" };
  const check = await caller(dispatcher).comms.transmitCheck({ channelKey: "LAD-4", unitId, ...gp, segmentId: seg0 });
  line();
  line("TRANSMIT LAD-4 @ 53.6209N — " + check.status.toUpperCase());
  for (const g of check.gates) line("         " + `${pad(g.gate, 24)} ${pad(g.result, 8)} ${g.reason}`);

  /* ---- 7. the same channel, 150 km south ---- */
  const south = await caller(dispatcher).comms.transmitCheck({ channelKey: "LAD-1", unitId, latitude: 52.27, longitude: -113.8, province: "AB" });
  line();
  line("TRANSMIT LAD-1 @ 52.2700N — " + south.status.toUpperCase());
  line("         " + (south.reasons.find(r => r.includes("south of")) ?? south.reasons[0]));

  /* ---- 8. the sign on the road beats the document ---- */
  const approval = await caller(dispatcher).spatial.routeApprove({
    unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [seg0], dispatchStatus: bare.verdict!.dispatchStatus,
    explanation: "Computed over imported Alberta road data", requiredChecks: ["road_weight_restriction"],
    load: { grossWeightKg: 31_500, dangerousGoods: false },
  });
  const before = await caller(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });
  const obs = await caller(driver).comms.signObserve({ observedChannelText: "LAD-1", latitude: 53.62091, longitude: -116.50758, segmentId: seg0, roadName: "Forestry Trunk Road", photoHash: "b".repeat(64) });
  await caller(safety).comms.signDecide({ observationRef: obs.observationRef, decision: "confirm" });
  const after = await caller(dispatcher).spatial.routeApprovalCheck({ approvalRef: approval.approvalRef });

  line();
  line("SIGN     " + `driver photographed "LAD-1" → office confirmed → posted_sign authority`);
  line("APPROVAL " + `before: ${before.stale ? "stale" : "current"} · after: ${after.stale ? "STALE" : "current"}`);
  line("         " + after.reasons.join("; "));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
