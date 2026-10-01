/**
 * The Canadian provider path, end to end, against a real database.
 *
 *   provider registry → runtime readiness → scheduler tick → HTTP (faked publisher) → parse →
 *   normalize → roadAdvisories / externalFeedRuns → geometric placement on approved routes →
 *   approval recheck → route_approval_stale → dispatch readiness
 *
 * Nothing here reimplements a step: the tick is `runTransportFeedTick`, approvals are made and
 * checked through the tRPC callers, readiness is `composeReadiness`. The publisher is the only
 * fake — every request goes through the provider's own endpoint and `feedHttp`, and is answered
 * from a fixture, so the suite never depends on a government system being up.
 *
 * Production does not run any of this on a timer; see docs/transport/CANADIAN_PROVIDER_RUNTIME.md.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { getDb, seedExternalDataSources } from "./db";
import { composeReadiness } from "./readinessComposer";
import type { HttpClient } from "./_core/feedHttp";
import { runTransportFeedTick, type TransportTickReport } from "./transportFeedRuntime";

const URL = process.env.DATABASE_URL;

describe("Canadian provider runtime — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped provider-runtime suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 912_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const SOURCES = ["drivebc_open511", "qc_mtmd_roadworks", "on511", "mb511", "ab511", "nb511", "yt511", "nl511", "sk_highway_hotline"];
const ON_SECRET = "on+TEST/key=7c1";
const ON_SECRET_ENC = encodeURIComponent(ON_SECRET);

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  await seedExternalDataSources();
  // Test-owned rows only: a database kept between local runs would otherwise carry this suite's
  // own earlier runs into the collector's quota and interval arithmetic.
  const ph = SOURCES.map(() => "?").join(",");
  await pool.execute(`DELETE FROM externalFeedRuns WHERE sourceKey IN (${ph})`, SOURCES);
  await pool.execute(`DELETE FROM roadAdvisories WHERE sourceKey IN (${ph})`, SOURCES);
});
afterAll(async () => { await pool?.end(); });
afterEach(() => { vi.unstubAllEnvs(); });

/** `geo.transportFeeds` reads the server's own environment, so the health calls stub it. */
function serverEnv(env: Record<string, string>) { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); }

const callerFor = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [`U-${rnd()}`]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function operator() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Op ${rnd()}`]);
  return Number(r.insertId);
}

/**
 * A 6 km east–west road with a real polyline and a graph build containing it. Each road is placed
 * 0.25° (~28 km) north of the last, from a random base, so this suite's roads never sit near each
 * other or near another suite's.
 */
let nextLat = 49.5 + Math.random() * 8;
type Road = { buildRef: string; segmentId: string; mid: [number, number]; west: [number, number]; east: [number, number] };
async function road(lng = -122.70): Promise<Road> {
  const lat = (nextLat += 0.25);
  const buildRef = `GB-${rnd()}`, objectId = 600_000_000 + Math.floor(Math.random() * 300_000_000);
  const segmentId = `AB-ACCESS-${objectId}`;
  const west: [number, number] = [lng, lat], east: [number, number] = [lng + 0.084, lat];
  await pool.execute(
    "INSERT INTO accessRoadSegments (objectId, name, featureType, featureTypeLabel, surfaceKind, lengthMetres, minLatitude, minLongitude, maxLatitude, maxLongitude, pathJson, sourceKey, sourceLayer, importRunRef, retrievedAt) VALUES (?, 'Fixture Highway', 2, 'Road', 'paved', 6000, ?, ?, ?, ?, ?, 'ats_road_allowance', 'access', ?, NOW())",
    [objectId, lat, west[0], lat, east[0], JSON.stringify([west, east]), `RUN-${rnd()}`],
  );
  await pool.execute(
    "INSERT INTO roadGraphBuilds (buildRef, label, minLatitude, minLongitude, maxLatitude, maxLongitude, snapToleranceMetres, segmentsConsidered, nodeCount, edgeCount, componentCount, largestComponentEdges, isolatedEdges, excludedSurfacesJson, sourceRunRefsJson, status, builtByUserId, builtAt) VALUES (?, 'provider runtime fixture', ?, ?, ?, ?, 5, 1, 2, 1, 1, 1, 0, '[]', '[]', 'current', 1, NOW())",
    [buildRef, lat - 0.1, west[0] - 0.1, lat + 0.1, east[0] + 0.1],
  );
  const a = `N-${objectId}-A`, b = `N-${objectId}-B`;
  await pool.execute("INSERT INTO roadGraphNodes (buildRef, nodeKey, latitude, longitude, degree, componentId) VALUES (?, ?, ?, ?, 1, 1), (?, ?, ?, ?, 1, 1)", [buildRef, a, lat, west[0], buildRef, b, lat, east[0]]);
  await pool.execute("INSERT INTO roadGraphEdges (buildRef, segmentId, accessRoadObjectId, label, fromNodeKey, toNodeKey, lengthMetres, surfaceKind, featureTypeLabel, componentId) VALUES (?, ?, ?, 'Fixture Highway', ?, ?, 6000, 'paved', 'Road', 1)", [buildRef, segmentId, objectId, a, b]);
  return { buildRef, segmentId, mid: [lng + 0.042, lat], west, east };
}

async function approve(dispatcher: number, unitId: number, r: Road) {
  const out = await callerFor(dispatcher).spatial.routeApprove({
    unitId, originRef: "YARD", destinationRef: "LEASE", segmentIds: [r.segmentId], buildRef: r.buildRef,
    dispatchStatus: "warning", explanation: "provider runtime fixture", requiredChecks: ["road_weight_restriction"],
    load: { grossWeightKg: 30_000, dangerousGoods: false },
  });
  return out.approvalRef;
}
async function approvalStatus(ref: string) {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, staleReasonsJson FROM routeApprovals WHERE approvalRef = ?", [ref]);
  return rows[0] as { status: string; staleReasonsJson: string | null };
}
async function advisoryRows(sourceKey: string, externalRef: string) {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT advisoryRef, status, severity, advisoryType, supersededByAdvisoryRef, latitude, longitude, advisoryOnly FROM roadAdvisories WHERE sourceKey = ? AND externalRef = ? ORDER BY id", [sourceKey, externalRef]);
  return rows;
}
async function runCount(sourceKey: string) {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM externalFeedRuns WHERE sourceKey = ?", [sourceKey]);
  return Number(rows[0]!.n);
}

/* ---- the publishers, faked at the HTTP edge ---- */

type Answer = { status: number; body: string } | Error;
const publisher: Record<string, () => Answer> = {};
const requests: string[] = [];
const client: HttpClient = {
  async request({ url }) {
    requests.push(url);
    const host = new globalThis.URL(url).host;
    const answer = publisher[host]?.() ?? { status: 404, body: "" };
    if (answer instanceof Error) throw answer;
    return { ...answer, headers: {} };
  },
};

const driveBcEvent = (id: string, at: [number, number], over: Record<string, unknown> = {}) => ({
  id: `drivebc.ca/${id}`, headline: "INCIDENT", status: "ACTIVE", updated: "2026-10-01T09:00:00-07:00",
  description: `Fixture Highway, both directions. ${id}.`, event_type: "INCIDENT", event_subtypes: ["ROAD_CLOSED"], severity: "MAJOR",
  geography: { type: "Point", coordinates: at }, roads: [{ name: "Fixture Highway" }], ...over,
});
const driveBc = (...events: unknown[]) => () => ({ status: 200, body: JSON.stringify({ events, pagination: { offset: "0" }, meta: { version: "v1" } }) });

let clock = new Date();
const advance = (hours = 2) => { clock = new Date(clock.getTime() + hours * 3_600_000); return clock; };
const ENABLED = { LEASEOS_TRANSPORT_FEEDS_ENABLED: "drivebc_open511,qc_mtmd_roadworks" };
async function tickWith(env: Record<string, string | undefined> = ENABLED): Promise<TransportTickReport> {
  return runTransportFeedTick({ db: (await getDb())!, env, client, now: clock });
}

d("a provincial closure reaches an approved route, and only the routes it touches", () => {
  let dispatcher: number;
  let R1: Road, R2: Road, R3: Road;
  let A1: string, A2: string;
  let unitId: number;
  let operatorId: number;

  beforeAll(async () => {
    if (!URL) return;
    dispatcher = await member(null, ["dispatcher"]);
    unitId = await unitOwnedBy(null);
    operatorId = await operator();
    [R1, R2, R3] = [await road(), await road(), await road()];
  });

  it("(3)(12)(13)(14) DriveBC: a closure on R1 makes A1 stale and blocks readiness; minor work on R2 leaves A2 approved", async () => {
    A1 = await approve(dispatcher, unitId, R1);
    A2 = await approve(dispatcher, unitId, R2);
    const before = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: A1 }, clock);
    expect(before.eligibility.blockers.some(b => b.code.startsWith("route_approval_"))).toBe(false);

    publisher["api.open511.gov.bc.ca"] = driveBc(
      driveBcEvent("E1", R1.mid),
      driveBcEvent("E2", R2.mid, { event_type: "CONSTRUCTION", event_subtypes: ["ROAD_MAINTENANCE"], severity: "MINOR" }),
    );
    advance();
    const report = await tickWith();

    expect(report.scheduled.sort()).toEqual(["drivebc_open511", "qc_mtmd_roadworks"]);
    expect(report.readiness.find(r => r.sourceKey === "drivebc_open511")).toMatchObject({ status: "ready", credential: "not_required" });
    const inv = report.invalidation["drivebc_open511"]!;
    expect(inv.rechecked).toEqual(expect.arrayContaining([A1, A2]));
    expect(inv.madeStale).toContain(A1);
    expect(inv.madeStale).not.toContain(A2);

    // Persisted, with its position and the advisory-only flag.
    const e1 = await advisoryRows("drivebc_open511", "drivebc.ca/E1");
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ status: "active", severity: "closure", advisoryType: "closure", advisoryOnly: 1 });
    expect(Number(e1[0]!.latitude)).toBeCloseTo(R1.mid[1], 5);

    // The approval check names the dependency in a dispatcher's words.
    const check = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: A1, at: clock });
    expect(check).toMatchObject({ status: "stale", changed: ["liveAdvisories"] });
    expect(check.reasons.join(" ")).toContain("provincial road advisories on the route changed");
    expect((await approvalStatus(A2)).status).toBe("approved");

    // Readiness no longer reports this route as clear.
    const after = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: A1 }, clock);
    expect(after.eligibility.blockers).toContainEqual(expect.objectContaining({ code: "route_approval_stale", severity: "blocking", subject: "route" }));
    expect(after.eligibility.verdict).not.toBe("eligible");
    const other = await composeReadiness({ operatorId, unitId, trailerId: null, jobId: null, routeApprovalRef: A2 }, clock);
    expect(other.eligibility.blockers.some(b => b.code === "route_approval_stale")).toBe(false);
  }, 60_000);

  it("(5) collecting the same listing again changes nothing", async () => {
    advance();
    const report = await tickWith();
    expect(report.tick!.lines.join("\n")).toMatch(/drivebc_open511: OK — 2 seen, 0 new or revised/);
    expect(report.invalidation["drivebc_open511"]).toBeUndefined();
    expect((await advisoryRows("drivebc_open511", "drivebc.ca/E1")).filter(r => r.status === "active")).toHaveLength(1);
  }, 60_000);

  it("does not write a run for a feed that is not yet due", async () => {
    const n = await runCount("drivebc_open511");
    const report = await tickWith();   // same clock: polled minutes ago, publisher updates hourly
    expect(await runCount("drivebc_open511")).toBe(n);
    expect(report.tick!.lines.join("\n")).toMatch(/drivebc_open511: REFUSED \(not_due\)/);
  }, 60_000);

  it("(6) a severity change supersedes the old version and rechecks only the routes it touches", async () => {
    const A3 = await approve(dispatcher, unitId, R1);   // approved knowing the closure
    const A4 = await approve(dispatcher, unitId, R3);   // nothing on R3
    publisher["api.open511.gov.bc.ca"] = driveBc(
      driveBcEvent("E1", R1.mid, { event_subtypes: ["HAZARD"], severity: "MINOR", event_type: "INCIDENT" }),
      driveBcEvent("E2", R2.mid, { event_type: "CONSTRUCTION", event_subtypes: ["ROAD_MAINTENANCE"], severity: "MINOR" }),
    );
    advance();
    const report = await tickWith();
    const rows = await advisoryRows("drivebc_open511", "drivebc.ca/E1");
    expect(rows.map(r => r.status)).toEqual(["superseded", "active"]);
    expect(rows[0]!.supersededByAdvisoryRef).toBe(rows[1]!.advisoryRef);
    expect(rows[1]).toMatchObject({ severity: "minor", advisoryType: "incident" });
    const inv = report.invalidation["drivebc_open511"]!;
    expect(inv.rechecked).toContain(A3);
    expect(inv.rechecked).not.toContain(A4);
    expect(inv.madeStale).toContain(A3);
    expect((await approvalStatus(A4)).status).toBe("approved");
  }, 60_000);

  it("(8)(9) an outage, a truncated page and an empty listing clear nothing", async () => {
    publisher["api.open511.gov.bc.ca"] = driveBc(driveBcEvent("E1", R1.mid), driveBcEvent("E2", R2.mid, { event_type: "CONSTRUCTION", event_subtypes: ["ROAD_MAINTENANCE"], severity: "MINOR" }));
    advance();
    await tickWith();
    const A5 = await approve(dispatcher, unitId, R1);   // approved while the closure is live

    publisher["api.open511.gov.bc.ca"] = () => new Error("connect ETIMEDOUT api.open511.gov.bc.ca");
    advance();
    let report = await tickWith();
    expect(report.tick!.lines.join("\n")).toMatch(/drivebc_open511: FAILED \[unreachable\]/);

    // A page that fills DriveBC's 500 cap, without E1: possibly cut short, so it withdraws nothing.
    const filler = Array.from({ length: 500 }, (_, i) => driveBcEvent(`F${i}`, [R3.mid[0] + 2, R3.mid[1] + 2], { severity: "MINOR", event_subtypes: [] }));
    publisher["api.open511.gov.bc.ca"] = driveBc(...filler);
    advance(4);   // past the backoff the failure earned
    report = await tickWith();
    expect(report.tick!.lines.join("\n")).toMatch(/FAILED HTTP 200 \[snapshot_incomplete\]/);

    publisher["api.open511.gov.bc.ca"] = driveBc();
    advance(4);
    report = await tickWith();
    expect(report.tick!.lines.join("\n")).toMatch(/\[snapshot_incomplete\] — the listing was empty/);

    expect((await advisoryRows("drivebc_open511", "drivebc.ca/E1")).filter(r => r.status === "active")).toHaveLength(1);
    expect((await approvalStatus(A5)).status).toBe("approved");
    const check = await callerFor(dispatcher).spatial.routeApprovalCheck({ approvalRef: A5, at: clock });
    expect(check.status).toBe("approved");

    // Health names it, rather than calling the feed fine or merely "failed".
    const controller = await member(null, ["controller"]);
    serverEnv(ENABLED);
    const status = await callerFor(controller).geo.transportFeeds();
    const bc = status.providers.find(p => p.sourceKey === "drivebc_open511")!;
    expect(bc.state).toBe("snapshot_incomplete");
    expect(bc.lastCompleteSnapshotAt).not.toBeNull();
    expect(bc.activeAdvisories).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("(7) a complete listing that no longer carries the closure withdraws it — kept, not deleted — and the routes it touched go back for review", async () => {
    const A6 = await approve(dispatcher, unitId, R1);
    publisher["api.open511.gov.bc.ca"] = driveBc(driveBcEvent("E2", R2.mid, { event_type: "CONSTRUCTION", event_subtypes: ["ROAD_MAINTENANCE"], severity: "MINOR" }));
    advance(4);
    const report = await tickWith();
    const rows = await advisoryRows("drivebc_open511", "drivebc.ca/E1");
    expect(rows.length).toBeGreaterThanOrEqual(3);                 // every version is still on record
    expect(rows.filter(r => r.status === "active")).toHaveLength(0);
    expect(rows[rows.length - 1]!.status).toBe("withdrawn");
    expect(report.invalidation["drivebc_open511"]!.madeStale).toContain(A6);
  }, 60_000);

  it("(3) Québec: a road closed outright reaches the route through the same path", async () => {
    const RQ = await road(-71.30);
    const AQ = await approve(dispatcher, unitId, RQ);
    const feature = {
      type: "Feature", id: 990001,
      properties: { identifiant: `QC-${rnd()}`, routeAutoroute: "175", entraveType: "Majeure (semaine et fin de semaine)", entrave: "Route fermée en tout temps", entravesLieesAuxChargesEtDimensions: "", debut: "2026/01/01 00:00:00", fin: "2027/12/31 00:00:00", miseAJour: "2026/09/30 08:00:00", descriptionAnglais: "Route 175 closed at all times", descriptionFrancais: "Route 175 fermée" },
      geometry: { type: "LineString", coordinates: [[RQ.mid[0], RQ.mid[1] - 0.01], [RQ.mid[0], RQ.mid[1] + 0.01]] },
    };
    publisher["ws.mapserver.transports.gouv.qc.ca"] = () => ({ status: 200, body: JSON.stringify({ type: "FeatureCollection", numberMatched: 1, features: [feature] }) });
    advance(4);
    const report = await tickWith();
    expect(report.invalidation["qc_mtmd_roadworks"]!.madeStale).toContain(AQ);
    expect((await approvalStatus(AQ)).status).toBe("stale");
  }, 60_000);
});

d("(1)(2) keys and rights: who is called, and what comes back", () => {
  it("(2) Ontario without a key: credential_missing, no request, no run, no false error", async () => {
    const before = requests.length;
    advance();
    const report = await tickWith({ LEASEOS_TRANSPORT_FEEDS_ENABLED: "on511" });
    expect(report.readiness.find(r => r.sourceKey === "on511")).toMatchObject({ status: "credential_missing", rightsVerified: true, schedulable: false });
    expect(report.scheduled).toEqual([]);
    expect(requests.slice(before)).toEqual([]);
    expect(await runCount("on511")).toBe(0);
    const controller = await member(null, ["controller"]);
    serverEnv({ LEASEOS_TRANSPORT_FEEDS_ENABLED: "on511" });
    const on = (await callerFor(controller).geo.transportFeeds()).providers.find(p => p.sourceKey === "on511")!;
    // Waiting on a key is not a failure: no error category, no attempt.
    expect(on).toMatchObject({ state: "credential_missing", credential: "missing", lastErrorCategory: null, lastAttemptedAt: null });
  }, 60_000);

  it("(4) Ontario with a key: one request through the canonical HTTP layer, the key nowhere in what is recorded or returned", async () => {
    const dispatcher = await member(null, ["dispatcher"]);
    const unitId = await unitOwnedBy(null);
    const RO = await road(-79.40);
    const AO = await approve(dispatcher, unitId, RO);
    const env = { LEASEOS_TRANSPORT_FEEDS_ENABLED: "on511", ON_511_API_KEY: ON_SECRET };

    publisher["511on.ca"] = () => ({ status: 400, body: `<Error><Message>Invalid Key ${ON_SECRET}</Message></Error>` });
    const before = requests.length;
    advance();
    let report = await tickWith(env);
    const sent = requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^https:\/\/511on\.ca\/api\/v2\/get\/event\?format=json&lang=en&key=/);
    expect(sent[0]).toContain(`key=${ON_SECRET_ENC}`);

    const [runs] = await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM externalFeedRuns WHERE sourceKey = 'on511'");
    expect(runs).toHaveLength(1);
    const controller = await member(null, ["controller"]);
    serverEnv(env);
    const status = await callerFor(controller).geo.transportFeeds();
    expect(status.providers.find(p => p.sourceKey === "on511")).toMatchObject({ state: "credential_rejected", lastHttpStatus: 400, credential: "present" });
    for (const text of [JSON.stringify(runs), JSON.stringify(report), JSON.stringify(status)]) {
      expect(text).not.toContain(ON_SECRET);
      expect(text).not.toContain(ON_SECRET_ENC);
      expect(text).not.toContain("ON_511_API_KEY");
    }

    // The key is right after all: Ontario's closure reaches its route like any other.
    publisher["511on.ca"] = () => ({ status: 200, body: JSON.stringify([{ ID: 777001, RoadwayName: "Highway 11", Description: "Highway 11 closed in both directions.", LastUpdated: Math.floor(clock.getTime() / 1000), StartDate: 0, PlannedEndDate: 0, Latitude: RO.mid[1], Longitude: RO.mid[0], EventType: "closures", IsFullClosure: true, Severity: "Major" }]) });
    advance(4);
    report = await tickWith(env);
    expect(report.invalidation["on511"]!.madeStale).toContain(AO);
  }, 60_000);

  it("(1) Manitoba with a key present is refused at the rights gate; the HTTP layer is never reached", async () => {
    const before = requests.length;
    advance();
    const report = await tickWith({ LEASEOS_TRANSPORT_FEEDS_ENABLED: "mb511,ab511,nb511,yt511,nl511", MB_511_API_KEY: "mb-key", AB_511_API_KEY: "ab-key", NB_511_API_KEY: "nb", YT_511_API_KEY: "yt", NL_511_API_KEY: "nl" });
    for (const k of ["mb511", "ab511", "nb511", "yt511", "nl511"]) {
      expect(report.readiness.find(r => r.sourceKey === k), k).toMatchObject({ status: "rights_review", credential: "present", schedulable: false });
      expect(await runCount(k), k).toBe(0);
    }
    expect(report.scheduled).toEqual([]);
    expect(requests.slice(before)).toEqual([]);
  }, 60_000);

  it("(17) Saskatchewan is never scheduled and never requested, even when switched on", async () => {
    advance();
    const report = await tickWith({ LEASEOS_TRANSPORT_FEEDS_ENABLED: "sk_highway_hotline" });
    expect(report.readiness.find(r => r.sourceKey === "sk_highway_hotline")!.status).toBe("no_published_api");
    expect(report.scheduled).toEqual([]);
    expect(requests.some(u => /hotline\.gov\.sk\.ca/.test(u))).toBe(false);
  }, 60_000);

  it("only ever requested the three publishers whose rights are recorded", () => {
    const hosts = new Set(requests.map(u => new globalThis.URL(u).host));
    expect([...hosts].sort()).toEqual(["511on.ca", "api.open511.gov.bc.ca", "ws.mapserver.transports.gouv.qc.ca"]);
  });
});

d("(16) a public road event changes one tenant's approval and reveals nothing across tenants", () => {
  it("makes A's affected route stale, leaves B's alone, and B still cannot see A's approval", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A, ["dispatcher"]), dispB = await member(B, ["dispatcher"]);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const RA = await road(), RB = await road();
    const approvalA = await approve(dispA, unitA, RA);
    const approvalB = await approve(dispB, unitB, RB);

    publisher["api.open511.gov.bc.ca"] = driveBc(driveBcEvent(`T-${rnd()}`, RA.mid));
    advance(4);
    const report = await tickWith();
    expect(report.invalidation["drivebc_open511"]!.madeStale).toContain(approvalA);
    expect(report.invalidation["drivebc_open511"]!.rechecked).not.toContain(approvalB);

    expect((await callerFor(dispA).spatial.routeApprovalCheck({ approvalRef: approvalA, at: clock })).status).toBe("stale");
    expect((await callerFor(dispB).spatial.routeApprovalCheck({ approvalRef: approvalB, at: clock })).status).toBe("approved");
    await expect(callerFor(dispB).spatial.routeApprovalCheck({ approvalRef: approvalA, at: clock })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
