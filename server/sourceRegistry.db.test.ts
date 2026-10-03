/**
 * 0233 — the approved external source registry against the database, and the facility importer
 * running through it end to end.
 *
 * Every source here is the test's own (a random key on a random host under example.ca), so no run
 * touches the seeded Saskatchewan or BC sources the facility suite approves. The network is the
 * test's too: `setSourceRegistryEdges` stands a fake resolver and transport in for the publisher,
 * and the egress guard's rules apply to them unchanged — which is what lets these tests show an
 * approved source that resolves inside, or redirects away, being refused anyway.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { setSourceRegistryEdges } from "./sourceRegistryService";
import type { EgressTransport, ResolvedAddress, TransportResponse } from "./_core/egressGuard";
import { latLonToUtm } from "./_core/projections";
import { SK_FACILITIES } from "./_core/arcgisImport";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 360_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9);
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { setSourceRegistryEdges(null); await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: string) { const userId = seq++; await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]); return userId; }

/* ---------------- a publisher the test controls ---------------- */

const PUBLIC = "142.165.1.1";
type Route = { status?: number; headers?: Record<string, string>; body?: string; before?: () => Promise<void> };
/** A DNS and a web that know only what each test tells them, and remember what they were asked. */
function publisher(hosts: Record<string, string[]>, route: (url: URL) => Route | undefined) {
  const asked: string[] = [];
  const sent: string[] = [];
  const served: string[] = [];
  const resolve = async (host: string): Promise<ResolvedAddress[]> => {
    asked.push(host);
    const answers = hosts[host];
    if (!answers) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return answers.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const transport: EgressTransport = {
    async get({ url }) {
      sent.push(url.href);
      const r = route(url);
      if (!r) throw new Error(`no route for ${url.href}`);
      await r.before?.();
      const body = r.body ?? "{}";
      if ((r.status ?? 200) === 200) served.push(body);
      return {
        status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" },
        body: (async function* () { yield new TextEncoder().encode(body); })(), close: () => undefined,
      } satisfies TransportResponse;
    },
  };
  setSourceRegistryEdges({ resolve, transport });
  return { asked, sent, served };
}

/* ---------------- a source of the test's own ---------------- */

const REASON = "registry test: exercising the approval workflow";
const LAYER_PATH = "/arcgis/rest/services/Test/Facilities/FeatureServer/0";

type TestSource = { sourceKey: string; host: string; layerUrl: string; submitter: number; approver: number; reader: number };

async function draftSource(): Promise<TestSource> {
  const sfx = rnd();
  const sourceKey = `regtest_${sfx}`, host = `gis-${sfx}.example.ca`;
  const submitter = await withRole("safety"), approver = await withRole("management"), reader = await withRole("auditor");
  await callerFor(submitter).sourceRegistry.create({ sourceKey, displayName: `Registry test ${sfx}`, authority: "Test publisher", category: "oilfield_assets", reason: REASON });
  await callerFor(submitter).sourceRegistry.endpointAdd({
    sourceKey, expectedRowVersion: 1, endpointKey: "facilities_layer_0", displayName: "Test facilities layer", serviceType: "arcgis_feature_server", httpMethod: "GET",
    baseUrl: `https://${host}${LAYER_PATH}`, pathMatch: "prefix", authScheme: "NONE", contentTypes: ["application/json", "text/plain"], timeoutMs: null, maxBytes: null, enabled: true, reason: REASON,
  });
  return { sourceKey, host, layerUrl: `https://${host}${LAYER_PATH}`, submitter, approver, reader };
}
const read = async (t: TestSource) => callerFor(t.reader).sourceRegistry.get({ sourceKey: t.sourceKey });
const version = async (t: TestSource) => (await read(t)).source.rowVersion;
const reviewBy = () => new Date(Date.now() + 90 * 86_400_000);
async function requestAndApprove(t: TestSource, requester = t.submitter, approver = t.approver) {
  await callerFor(requester).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON });
  await callerFor(approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: reviewBy(), note: "registry test: approved as it stands" });
}
async function approvedSource(): Promise<TestSource> { const t = await draftSource(); await requestAndApprove(t); return t; }

/** Saskatchewan-shaped features (the licence the importer checks is the SK one, which is confirmed). */
function features(n: number) {
  const k = latLonToUtm(51.4667, -109.1667, 13);
  const ring = (e: number, nn: number) => [[e - 40, nn - 40], [e + 40, nn - 40], [e + 40, nn + 40], [e - 40, nn + 40], [e - 40, nn - 40]];
  return Array.from({ length: n }, (_, i) => ({
    attributes: { LICENCENUM: `RT${rnd().toUpperCase()}`, OWNERNAME: "REGISTRY TEST OPERATOR", LICTYPE: "WASTE FACILITY", LICSTATUS: "ACTIVE", SURFACELOC: "16-16-030-23W3" },
    geometry: { rings: [ring(k.easting + i * 1000, k.northing)] },
  }));
}
const META = (pageSize: number) => JSON.stringify({ name: "Test facilities", maxRecordCount: pageSize, extent: { spatialReference: { wkid: 2957, latestWkid: 2957 } }, fields: SK_FACILITIES.fields.map(name => ({ name, type: "esriFieldTypeString" })), editingInfo: { dataLastEditDate: Date.UTC(2026, 8, 1) } });

/** The layer: metadata, then pages of `perPage` from `all`. `onPage` runs before page n is answered. */
function layer(t: TestSource, all: ReturnType<typeof features>, perPage: number, onPage: Record<number, () => Promise<void>> = {}) {
  return (url: URL): Route | undefined => {
    if (url.hostname !== t.host) return undefined;
    if (url.pathname === LAYER_PATH && url.searchParams.get("f") === "pjson") return { headers: { "content-type": "text/plain; charset=utf-8" }, body: META(perPage) };
    if (url.pathname === `${LAYER_PATH}/query`) {
      const offset = Number(url.searchParams.get("resultOffset") ?? 0);
      const page = all.slice(offset, offset + perPage);
      return { body: JSON.stringify({ features: page, exceededTransferLimit: offset + perPage < all.length }), before: onPage[offset / perPage + 1] };
    }
    return undefined;
  };
}
const importFrom = (userId: number, t: TestSource) => callerFor(userId).facilityDirectory.arcgis.importFromLayer({ source: "sk_facilities", layerUrl: t.layerUrl, licenceKey: "sk_unrestricted_use_v2", mapping: SK_FACILITIES.mapping });
const facilityCount = async (fs: ReturnType<typeof features>) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM facilities WHERE facilityKey IN (${fs.map(() => "?").join(",")})`, fs.map(f => `sk_facilities:${f.attributes.LICENCENUM}`));
  return Number(r[0]!.n);
};
const datasetImports = async (t: TestSource) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM externalDatasetImports d JOIN externalDataSources s ON s.id = d.externalDataSourceId WHERE s.sourceKey = ?", [t.sourceKey]);
  return Number(r[0]!.n);
};
const decisions = async (userId: number, procedureName: string) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT permission, outcome FROM authorizationDecisions WHERE actorUserId = ? AND procedureName = ? ORDER BY id", [userId, procedureName]);
  return r.map(x => ({ permission: x.permission as string, outcome: x.outcome as string }));
};

/* ================================================================ */

d("source registry — who may do what", () => {
  it("grants each act its own permission: an auditor reads, a safety lead proposes and edits, only a manager decides; a refusal is recorded", async () => {
    const t = await draftSource();
    const driver = await withRole("driver");
    await expect(callerFor(driver).sourceRegistry.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(driver).sourceRegistry.get({ sourceKey: t.sourceKey })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The auditor reads the directory and the health page, and changes nothing.
    expect((await callerFor(t.reader).sourceRegistry.list()).some(s => s.sourceKey === t.sourceKey)).toBe(true);
    await callerFor(t.reader).sourceRegistry.health({ sourceKey: t.sourceKey });
    await expect(callerFor(t.reader).sourceRegistry.create({ sourceKey: `regtest_${rnd()}`, displayName: "Nope source", authority: "Nobody", category: "other", reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.reader).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The safety lead proposes, but may not approve, reject, revoke or bind a credential.
    await callerFor(t.submitter).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON });
    const v = await version(t);
    await expect(callerFor(t.submitter).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: v, reviewBy: reviewBy(), note: "approving my own request" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.submitter).sourceRegistry.reject({ sourceKey: t.sourceKey, expectedRowVersion: v, note: "rejecting my own request" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.submitter).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: v, reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.submitter).sourceRegistry.credentialBind({ sourceKey: t.sourceKey, expectedRowVersion: v, endpointKey: "facilities_layer_0", authScheme: "NONE", credentialRef: null, reason: REASON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await decisions(t.submitter, "sourceRegistry.approve")).toEqual([{ permission: "source.registry.approve", outcome: "denied_permission" }]);
    expect(await decisions(driver, "sourceRegistry.list")).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/^denied_/) })]);
    // The manager approves, and that decision is recorded as allowed under its own permission.
    await callerFor(t.approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: v, reviewBy: reviewBy(), note: "registry test: approved as it stands" });
    expect(await decisions(t.approver, "sourceRegistry.approve")).toEqual([{ permission: "source.registry.approve", outcome: "allowed" }]);
  }, 60_000);

  it("leaves licence determinations to the licence review: a new source's permissions are unknown, and no registry call can set them", async () => {
    const sfx = rnd(), sourceKey = `regtest_${sfx}`;
    const manager = await withRole("management");
    const base = { sourceKey, displayName: `Registry test ${sfx}`, authority: "Test publisher", category: "other" as const, reason: REASON };
    await expect(callerFor(manager).sourceRegistry.create({ ...base, commercialUsePermitted: "yes" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(manager).sourceRegistry.create({ ...base, attributionText: "© Test" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await callerFor(manager).sourceRegistry.create({ ...base, licenceName: "Test Open Licence", licenceUrl: "https://example.ca/licence" });
    const { source } = await callerFor(manager).sourceRegistry.get({ sourceKey });
    expect(source.licence).toMatchObject({ status: "unverified", name: "Test Open Licence", attributionText: null, commercialUsePermitted: "unknown", redistributionPermitted: "unknown" });
    for (const patch of [{ commercialUsePermitted: "yes" }, { redistributionPermitted: "yes" }, { attributionText: "x" }, { licenceName: "Another" }, { status: "verified" }]) {
      await expect(callerFor(manager).sourceRegistry.update({ sourceKey, expectedRowVersion: source.rowVersion, patch, reason: REASON } as never), JSON.stringify(patch)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await callerFor(manager).sourceRegistry.update({ sourceKey, expectedRowVersion: source.rowVersion, patch: { termsUrl: "https://example.ca/terms", riskClass: "low" }, reason: REASON });
    expect((await callerFor(manager).sourceRegistry.get({ sourceKey })).source).toMatchObject({ termsUrl: "https://example.ca/terms", riskClass: "low", licence: { commercialUsePermitted: "unknown", status: "unverified" } });
  }, 60_000);

  it("keeps the requester and the author of a revision from approving it, even holding the permission", async () => {
    const t = await draftSource();
    const manager = await withRole("management");
    // A manager who requests is not the one who approves.
    await callerFor(manager).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON });
    await expect(callerFor(manager).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: reviewBy(), note: "approving my own request" }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("requested an approval does not approve it") });
    // A manager who edits the endpoint made the revision; the request it reopens is not theirs to approve either.
    const other = await withRole("management");
    await callerFor(other).sourceRegistry.endpointUpdate({
      sourceKey: t.sourceKey, expectedRowVersion: await version(t), endpointKey: "facilities_layer_0", displayName: "Test facilities layer", serviceType: "arcgis_feature_server", httpMethod: "GET",
      baseUrl: t.layerUrl, pathMatch: "prefix", authScheme: "NONE", contentTypes: ["application/json", "text/plain"], timeoutMs: 20_000, maxBytes: null, enabled: true, reason: REASON,
    });
    await expect(callerFor(other).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: reviewBy(), note: "approving my own edit" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: new Date(Date.now() + 400 * 86_400_000), note: "a review date too far out" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("within 366 days") });
    await callerFor(t.approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: reviewBy(), note: "registry test: a third person approves" });
    expect((await read(t)).source.lifecycle).toBe("approved");
  }, 60_000);
});

d("source registry — lifecycle, audit evidence and change control", () => {
  it("moves draft → pending → approved → suspended → approved → revoked, each step an event with who, why and the revision", async () => {
    const t = await draftSource();
    expect((await read(t)).source).toMatchObject({ lifecycle: "draft", revision: 2 });   // adding an enabled endpoint is a revision
    await requestAndApprove(t);
    let g = await read(t);
    expect(g.source.lifecycle).toBe("approved");
    expect(g.approvals[0]).toMatchObject({ state: "approved", sourceRevision: 2, requestedByUserId: t.submitter, approvedByUserId: t.approver, scope: ["facility_directory.arcgis_import"] });
    await callerFor(t.submitter).sourceRegistry.suspend({ sourceKey: t.sourceKey, expectedRowVersion: g.source.rowVersion, reason: "registry test: publisher incident" });
    await callerFor(t.approver).sourceRegistry.resume({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), note: "registry test: incident closed" });
    await callerFor(t.approver).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: terms withdrawn" });
    g = await read(t);
    expect(g.source.lifecycle).toBe("revoked");
    expect(g.approvals[0]).toMatchObject({ state: "revoked", revokedByUserId: t.approver, revokeReason: "registry test: terms withdrawn" });
    const events = [...g.events].reverse();
    expect(events.map(e => e.eventType)).toEqual(["created", "endpoint_added", "review_requested", "approved", "suspended", "resumed", "revoked"]);
    expect(events.map(e => e.toLifecycle)).toEqual(["draft", "draft", "pending_approval", "approved", "suspended", "approved", "revoked"]);
    for (const e of events) {
      expect(e.actorUserId, e.eventType).not.toBeNull();
      expect(e.reason, e.eventType).toBeTruthy();
      expect(e.sourceRevision, e.eventType).toBeGreaterThanOrEqual(1);
    }
    expect(events.find(e => e.eventType === "approved")).toMatchObject({ actorUserId: t.approver, sourceRevision: 2 });
    // The history is evidence: the database refuses to rewrite or remove it.
    const [[src]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM externalDataSources WHERE sourceKey = ?", [t.sourceKey]);
    await expect(pool.execute("UPDATE externalSourceEvents SET actorUserId = 1 WHERE externalDataSourceId = ? AND eventType = 'approved'", [src!.id])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM externalSourceEvents WHERE externalDataSourceId = ?", [src!.id])).rejects.toThrow(/never deleted/);
  }, 60_000);

  it("approves nothing that would authorise nothing, and resumes only under an approval that still covers the source", async () => {
    // A source whose only endpoint is disabled has nothing for an approval to cover.
    const sfx = rnd(), sourceKey = `regtest_${sfx}`;
    const submitter = await withRole("safety"), approver = await withRole("management");
    await callerFor(submitter).sourceRegistry.create({ sourceKey, displayName: `Registry test ${sfx}`, authority: "Test publisher", category: "other", reason: REASON });
    await callerFor(submitter).sourceRegistry.endpointAdd({
      sourceKey, expectedRowVersion: 1, endpointKey: "events", displayName: "Test events", serviceType: "json_feed", httpMethod: "GET", baseUrl: `https://api-${sfx}.example.ca/v1/events`,
      pathMatch: "exact", authScheme: "NONE", contentTypes: ["application/json"], timeoutMs: null, maxBytes: null, enabled: false, reason: REASON,
    });
    await callerFor(submitter).sourceRegistry.requestReview({ sourceKey, expectedRowVersion: 2, scope: ["facility_directory.arcgis_import"], reason: REASON });
    await expect(callerFor(approver).sourceRegistry.approve({ sourceKey, expectedRowVersion: 3, reviewBy: reviewBy(), note: "registry test: nothing enabled" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("has no enabled endpoint") });
    // A suspended source whose approval has since lapsed is not resumed; it goes back for review.
    const t = await approvedSource();
    await callerFor(t.submitter).sourceRegistry.suspend({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: suspended" });
    await pool.execute("UPDATE externalSourceApprovals a JOIN externalDataSources s ON s.id = a.externalDataSourceId SET a.expiresAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE s.sourceKey = ? AND a.state = 'approved'", [t.sourceKey]);
    await expect(callerFor(t.approver).sourceRegistry.resume({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), note: "registry test: resuming a lapsed approval" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("request a fresh review") });
    expect((await read(t)).source.lifecycle).toBe("suspended");
  }, 60_000);

  it("refuses a write against a version someone else has already changed, and lets exactly one of two simultaneous approvals through", async () => {
    const t = await draftSource();
    const v = await version(t);
    await callerFor(t.submitter).sourceRegistry.update({ sourceKey: t.sourceKey, expectedRowVersion: v, patch: { termsUrl: "https://example.ca/terms" }, reason: REASON });
    await expect(callerFor(t.submitter).sourceRegistry.update({ sourceKey: t.sourceKey, expectedRowVersion: v, patch: { notes: "a second editor" }, reason: REASON }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await callerFor(t.submitter).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON });
    const second = await withRole("management");
    const at = await version(t);
    const results = await Promise.allSettled([t.approver, second].map(u => callerFor(u).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: at, reviewBy: reviewBy(), note: "registry test: simultaneous approval" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ code: "CONFLICT" }) });
    expect((await read(t)).events.filter(e => e.eventType === "approved")).toHaveLength(1);
  }, 60_000);

  it("an endpoint edit makes a new revision that the old approval does not cover; disabling narrows at once and needs no review", async () => {
    const t = await approvedSource();
    const before = (await read(t)).source;
    const edit = { sourceKey: t.sourceKey, endpointKey: "facilities_layer_0", displayName: "Test facilities layer", serviceType: "arcgis_feature_server" as const, httpMethod: "GET" as const,
      pathMatch: "prefix" as const, authScheme: "NONE" as const, contentTypes: ["application/json" as const, "text/plain" as const], timeoutMs: null, maxBytes: null, reason: REASON };
    // Disabling: same revision, still approved, but the endpoint is closed.
    await callerFor(t.submitter).sourceRegistry.endpointUpdate({ ...edit, expectedRowVersion: before.rowVersion, baseUrl: t.layerUrl, enabled: false });
    let g = await read(t);
    expect(g.source).toMatchObject({ lifecycle: "approved", revision: before.revision });
    expect(g.events[0]).toMatchObject({ eventType: "endpoint_disabled" });
    // Re-enabling, or pointing it elsewhere, is a new revision back in review.
    await callerFor(t.submitter).sourceRegistry.endpointUpdate({ ...edit, expectedRowVersion: g.source.rowVersion, baseUrl: `https://${t.host}/arcgis/rest/services/Test/Other/FeatureServer/0`, enabled: true });
    g = await read(t);
    expect(g.source).toMatchObject({ lifecycle: "pending_approval", revision: before.revision + 1 });
    expect(g.approvals.map(a => a.state)).toEqual(["proposed", "superseded"]);
    expect(g.approvals[0]).toMatchObject({ state: "proposed", sourceRevision: before.revision + 1, requestedByUserId: t.submitter });
    expect(g.events.slice(0, 2).map(e => e.eventType)).toEqual(["endpoint_updated", "review_requested"]);
    // Retiring disables every endpoint and ends every approval; a retired source is not edited again.
    await callerFor(t.approver).sourceRegistry.retire({ sourceKey: t.sourceKey, expectedRowVersion: g.source.rowVersion, reason: "registry test: publisher gone" });
    g = await read(t);
    expect(g.source.lifecycle).toBe("retired");
    expect(g.endpoints.every(e => !e.enabled)).toBe(true);
    expect(g.approvals.every(a => a.state !== "approved" && a.state !== "proposed")).toBe(true);
    await expect(callerFor(t.submitter).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: g.source.rowVersion, scope: ["facility_directory.arcgis_import"], reason: REASON }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 60_000);

  it("refuses an endpoint that is not a public https layer, and a second enabled endpoint for the same layer", async () => {
    const t = await draftSource();
    const base = { sourceKey: t.sourceKey, displayName: "Bad endpoint", serviceType: "arcgis_feature_server" as const, httpMethod: "GET" as const, pathMatch: "prefix" as const,
      authScheme: "NONE" as const, contentTypes: ["application/json" as const], timeoutMs: null, maxBytes: null, enabled: true, reason: REASON };
    for (const baseUrl of ["http://gis.example.ca/arcgis/rest/services/X/FeatureServer/0", "https://169.254.169.254/arcgis/rest/services/X/FeatureServer/0", "https://localhost/arcgis/rest/services/X/FeatureServer/0",
      "https://10.0.0.7/arcgis/rest/services/X/FeatureServer/0", "https://gis.example.ca/arcgis/rest/services/X/FeatureServer/0/../../../Admin/MapServer/0", "https://gis.example.ca/arcgis/rest/services/X/FeatureServer/0?token=abc"]) {
      await expect(callerFor(t.submitter).sourceRegistry.endpointAdd({ ...base, expectedRowVersion: await version(t), endpointKey: `bad_${rnd()}`, baseUrl }), baseUrl).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(callerFor(t.submitter).sourceRegistry.endpointAdd({ ...base, expectedRowVersion: await version(t), endpointKey: "slow", baseUrl: `${t.layerUrl.slice(0, -1)}1`, timeoutMs: 120_000 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("ceiling") });
    // Another source may not enable an endpoint that would govern this one's layer.
    const other = await draftSource();
    await expect(callerFor(other.submitter).sourceRegistry.endpointAdd({ ...base, sourceKey: other.sourceKey, expectedRowVersion: await version(other), endpointKey: "twin", baseUrl: t.layerUrl }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`${t.sourceKey}/facilities_layer_0 already governs`) });
  }, 60_000);

  it("seeding is idempotent, approves nothing, and registers the road-information endpoints disabled", async () => {
    const manager = await withRole("management");
    await callerFor(manager).sourceRegistry.seed();
    const again = await callerFor(manager).sourceRegistry.seed();
    expect(again).toMatchObject({ endpointsInserted: [], reviewsOpened: [] });
    const [seeded] = await pool.query<mysql.RowDataPacket[]>("SELECT e.endpointRef, e.enabled, e.credentialRef, s.lifecycle FROM externalSourceEndpoints e JOIN externalDataSources s ON s.id = e.externalDataSourceId WHERE e.createdByUserId IS NULL");
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.every(r => r.credentialRef === null)).toBe(true);
    for (const r of seeded.filter(r => !/^(sk_petroleum_gis|bcer_gis)\//.test(r.endpointRef as string))) expect(Number(r.enabled), r.endpointRef as string).toBe(0);
    // Every approval in the registry was granted by a person; a seed only ever opens a request.
    const [granted] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM externalSourceApprovals WHERE state = 'approved' AND approvedByUserId IS NULL");
    expect(Number(granted[0]!.n)).toBe(0);
    const [byNobody] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, COUNT(*) AS n FROM externalSourceEvents WHERE actorUserId IS NULL GROUP BY eventType");
    expect(byNobody.map(r => r.eventType).sort()).toEqual(expect.arrayContaining(["seeded"]));
    expect(byNobody.every(r => r.eventType === "seeded" || r.eventType === "review_requested")).toBe(true);
  }, 120_000);
});

d("source registry — credentials are referenced, never revealed", () => {
  it("binds only an active credential-store reference of this provider and scheme, reports only that one is bound, and a rotation needs a fresh approval", async () => {
    const t = await approvedSource();
    const secretRef = `sec_${rnd()}${rnd()}`, fingerprint = `fp${rnd()}${rnd()}`;
    const credA = `cred_rt_${rnd()}`, credB = `cred_rt_${rnd()}`, foreign = `cred_rt_${rnd()}`;
    await pool.execute("INSERT INTO providerCredentials (credentialRef, providerKey, environment, authScheme, ownership, secretRef, status, fingerprint) VALUES (?,?,'production','API_KEY','PLATFORM',?,'active',?), (?,?,'staging','API_KEY','PLATFORM',?,'active',?), (?,?,'production','API_KEY','PLATFORM',?,'active',?)",
      [credA, t.sourceKey, secretRef, fingerprint, credB, t.sourceKey, `${secretRef}b`, `${fingerprint}b`, foreign, `regtest_other_${rnd()}`, `${secretRef}c`, `${fingerprint}c`]);
    const manager = await withRole("management");
    const bind = async (credentialRef: string | null, authScheme: "API_KEY" | "NONE" | "STATIC_BEARER" = "API_KEY") =>
      callerFor(manager).sourceRegistry.credentialBind({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), endpointKey: "facilities_layer_0", authScheme, credentialRef, reason: "registry test: credential binding" });
    // A value, a secret pointer, another provider's credential or the wrong scheme is refused — and no message repeats a secret pointer.
    await expect(bind(secretRef)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bind(foreign)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("belongs to another provider") });
    const wrong = await bind(credA, "STATIC_BEARER").then(() => null, (e: Error) => e);
    expect(wrong?.message).toContain("is API_KEY, not STATIC_BEARER");
    expect(wrong?.message).not.toContain(secretRef);
    await expect(callerFor(manager).sourceRegistry.credentialBind({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), endpointKey: "facilities_layer_0", authScheme: "API_KEY", credentialRef: credA, reason: REASON, apiKey: "plaintext-key-123" } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Binding to an enabled endpoint of an approved source is a new revision: the source is back in review.
    await bind(credA);
    let g = await read(t);
    expect(g.source.lifecycle).toBe("pending_approval");
    expect(g.endpoints[0]).toMatchObject({ authScheme: "API_KEY", credentialBound: true });
    expect(Object.keys(g.endpoints[0]!)).not.toContain("credentialRef");
    await callerFor(t.approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: g.source.rowVersion, reviewBy: reviewBy(), note: "registry test: credential approved" });
    // Rotation to another reference is another revision, and another review.
    await bind(credB);
    g = await read(t);
    expect(g.source.lifecycle).toBe("pending_approval");
    expect(g.events.filter(e => e.eventType === "credential_bound").map(e => e.detail)).toEqual([{ authScheme: "API_KEY", credentialRef: credB }, { authScheme: "API_KEY", credentialRef: credA }]);
    // Nothing the registry answers carries a secret pointer or a fingerprint, and no endpoint view carries a reference.
    const everything = JSON.stringify([g, await callerFor(t.reader).sourceRegistry.list(), await callerFor(t.reader).sourceRegistry.health({ sourceKey: t.sourceKey })]);
    for (const s of [secretRef, fingerprint, "secretRef", "fingerprint", "envelope"]) expect(everything).not.toContain(s);
    const [events] = await pool.query<mysql.RowDataPacket[]>("SELECT CAST(detailJson AS CHAR) AS d, reason FROM externalSourceEvents e JOIN externalDataSources s ON s.id = e.externalDataSourceId WHERE s.sourceKey = ?", [t.sourceKey]);
    for (const e of events) expect(`${e.d} ${e.reason}`).not.toMatch(new RegExp(`${secretRef}|${fingerprint}`));
  }, 60_000);
});

d("source registry — the importer reaches a publisher only through the registry, then the egress guard", () => {
  it("imports an approved layer page by page, and records which source, endpoint, revision and approval it ran under", async () => {
    const t = await approvedSource();
    const all = features(3);
    const web = publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2));
    const run = await importFrom(t.submitter, t);
    expect(run).toMatchObject({ featureCount: 3, inserted: 3, provenance: { sourceKey: t.sourceKey, endpointRef: `${t.sourceKey}/facilities_layer_0`, sourceRevision: 2 } });
    expect(web.sent).toHaveLength(3);
    const [p] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT d.*, e.endpointRef, a.approvalRef, a.state AS approvalState FROM facilityImportRuns r JOIN externalDatasetImports d ON d.id = r.externalDatasetImportId JOIN externalSourceEndpoints e ON e.id = d.endpointId JOIN externalSourceApprovals a ON a.id = d.approvalId WHERE r.importRef = ?", [run.importRef]);
    const expected = createHash("sha256");
    for (const b of web.served) expected.update(b);
    expect(p[0]).toMatchObject({
      importRef: run.provenance.datasetImportRef, endpointRef: `${t.sourceKey}/facilities_layer_0`, sourceRevision: 2, purpose: "facility_directory.arcgis_import", approvalState: "approved",
      sourceFormat: "arcgis_json", datasetVersion: "2026-09-01T00:00:00.000Z", featureCount: 3, coordinateSystem: "EPSG:2957", importerVersion: "facilityDirectory.arcgis@0233",
      checksumSha256: expected.digest("hex"), importedByUserId: t.submitter, state: "imported",
    });
    // The fetch log has one row per request, by endpoint, naming the path and never the query string.
    const h = await callerFor(t.reader).sourceRegistry.health({ sourceKey: t.sourceKey });
    expect(h.recentFetches).toHaveLength(3);
    expect(h.recentFetches.every(f => f.outcome === "ok" && f.endpointRef === `${t.sourceKey}/facilities_layer_0` && !/[?&=]|where|resultOffset/.test(f.detail ?? ""))).toBe(true);
    expect(h.endpoints[0]!.health).toMatchObject({ lastOutcome: "ok", consecutiveFailures: 0, lastHttpStatus: 200 });
  }, 60_000);

  it.each([
    ["a URL no endpoint covers", (t: TestSource) => `https://${t.host}/arcgis/rest/services/Other/FeatureServer/0`, /no registered endpoint covers/],
    ["the approved host on another port", (t: TestSource) => `https://${t.host}:8443${LAYER_PATH}`, /no registered endpoint covers/],
    ["a look-alike host", (t: TestSource) => `https://${t.host}.attacker.example${LAYER_PATH}`, /no registered endpoint covers/],
    ["a sibling layer on the approved host", (t: TestSource) => `https://${t.host}${LAYER_PATH.replace(/0$/, "1")}`, /no registered endpoint covers/],
  ])("refuses %s before any lookup", async (_label, url, message) => {
    const t = await approvedSource();
    const web = publisher({ [t.host]: [PUBLIC] }, () => ({ body: "{}" }));
    await expect(callerFor(t.submitter).facilityDirectory.arcgis.inspect({ layerUrl: url(t) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(message) });
    expect(web.asked).toEqual([]);
    expect(web.sent).toEqual([]);
  }, 60_000);

  it("refuses a draft, a pending, a suspended, a revoked and an expired source, and a disabled endpoint — before any lookup, and at once", async () => {
    const t = await draftSource();
    const web = publisher({ [t.host]: [PUBLIC] }, layer(t, features(1), 2));
    const inspect = () => callerFor(t.submitter).facilityDirectory.arcgis.inspect({ layerUrl: t.layerUrl });
    await expect(inspect()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("is draft; nothing is fetched from it until a person approves it") });
    await callerFor(t.submitter).sourceRegistry.requestReview({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), scope: ["facility_directory.arcgis_import"], reason: REASON });
    await expect(inspect()).rejects.toMatchObject({ message: expect.stringContaining("is pending approval") });
    await callerFor(t.approver).sourceRegistry.approve({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reviewBy: reviewBy(), note: "registry test: approved as it stands" });
    expect(await inspect()).toMatchObject({ registry: { sourceKey: t.sourceKey, sourceRevision: 2, schemaChanged: false } });
    expect(web.sent).toHaveLength(1);
    await callerFor(t.submitter).sourceRegistry.suspend({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: suspended" });
    await expect(inspect()).rejects.toMatchObject({ message: expect.stringContaining("is suspended") });
    await callerFor(t.approver).sourceRegistry.resume({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), note: "registry test: resumed" });
    expect(await inspect()).toMatchObject({ registry: { sourceKey: t.sourceKey } });
    // A review-by date that has passed stops it without anyone acting.
    await pool.execute("UPDATE externalSourceApprovals a JOIN externalDataSources s ON s.id = a.externalDataSourceId SET a.expiresAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE s.sourceKey = ? AND a.state = 'approved'", [t.sourceKey]);
    await expect(inspect()).rejects.toMatchObject({ message: expect.stringContaining("past its review-by date") });
    await pool.execute("UPDATE externalSourceApprovals a JOIN externalDataSources s ON s.id = a.externalDataSourceId SET a.expiresAt = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE s.sourceKey = ? AND a.state = 'approved'", [t.sourceKey]);
    expect(await inspect()).toMatchObject({ registry: { sourceKey: t.sourceKey } });
    await callerFor(t.approver).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: revoked" });
    const sentBefore = web.sent.length, askedBefore = web.asked.length;
    await expect(inspect()).rejects.toMatchObject({ message: expect.stringContaining("approval is revoked") });
    expect([web.sent.length, web.asked.length]).toEqual([sentBefore, askedBefore]);
    // Re-approved, then the endpoint disabled: disabling needs no review and takes effect on the next request.
    await requestAndApprove(t);
    const g = await read(t);
    await callerFor(t.submitter).sourceRegistry.endpointUpdate({
      sourceKey: t.sourceKey, expectedRowVersion: g.source.rowVersion, endpointKey: "facilities_layer_0", displayName: "Test facilities layer", serviceType: "arcgis_feature_server", httpMethod: "GET",
      baseUrl: t.layerUrl, pathMatch: "prefix", authScheme: "NONE", contentTypes: ["application/json", "text/plain"], timeoutMs: null, maxBytes: null, enabled: false, reason: REASON,
    });
    await expect(inspect()).rejects.toMatchObject({ message: expect.stringContaining("is disabled") });
    // Every refusal of a registered endpoint is in its fetch log as refused.
    const h = await callerFor(t.reader).sourceRegistry.health({ sourceKey: t.sourceKey });
    expect(h.recentFetches.filter(f => f.outcome === "refused").length).toBeGreaterThanOrEqual(5);
  }, 90_000);

  it("an approval does not get past the egress guard: an approved host that resolves inside is refused, and nothing is sent", async () => {
    const t = await approvedSource();
    for (const inside of [["10.0.0.7"], ["169.254.169.254"], ["127.0.0.1"], [PUBLIC, "192.168.1.10"], ["::ffff:10.0.0.7"]]) {
      const web = publisher({ [t.host]: inside }, layer(t, features(1), 2));
      await expect(importFrom(t.submitter, t), inside.join(",")).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("does not resolve to a public address") });
      expect(web.sent).toEqual([]);
    }
    const h = await callerFor(t.reader).sourceRegistry.health({ sourceKey: t.sourceKey });
    expect(h.endpoints[0]!.health).toMatchObject({ lastOutcome: "refused_network", consecutiveFailures: 5 });
    expect(await datasetImports(t)).toBe(0);
  }, 60_000);

  it.each([
    ["to the metadata address", () => "https://169.254.169.254/latest/meta-data/iam/security-credentials/", "cloud metadata endpoint"],
    ["to a private literal", () => "https://10.20.30.40/arcgis/rest/services/Test/Facilities/FeatureServer/0?f=pjson", "private network"],
    ["to plain http on the approved host", (t: TestSource) => `http://${t.host}${LAYER_PATH}?f=pjson`, "https only"],
    ["to another public host", () => `https://mirror.example.org${LAYER_PATH}?f=pjson`, "not an approved destination"],
    ["out of the approved layer on the same host", () => "/arcgis/rest/services/Admin/MapServer/0?f=pjson", "not an approved destination"],
    ["back out through a dot segment", () => `${LAYER_PATH}/../../../../Admin/MapServer/0?f=pjson`, "not an approved destination"],
    ["to another approved source's layer", (_t: TestSource, other: TestSource) => `${other.layerUrl}?f=pjson`, "not an approved destination"],
  ])("an approved host's redirect %s is refused, and not followed", async (_label, location, message) => {
    const t = await approvedSource(), other = await approvedSource();
    const target = location(t, other);
    const web = publisher({ [t.host]: [PUBLIC], [other.host]: [PUBLIC], "mirror.example.org": [PUBLIC] },
      (url): Route => url.hostname === t.host && url.pathname === LAYER_PATH ? { status: 302, headers: { location: target } } : { body: META(2), headers: { "content-type": "text/plain" } });
    await expect(callerFor(t.submitter).facilityDirectory.arcgis.inspect({ layerUrl: t.layerUrl })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(message) });
    expect(web.sent).toHaveLength(1);
    expect(web.asked).toEqual([t.host]);
  }, 60_000);

  it("DNS rebinding: an approved host that answers public, then private on its own redirect, is refused at the second answer", async () => {
    const t = await approvedSource();
    const answers = [[PUBLIC], ["10.0.0.7"]];
    const asked: string[] = [], sent: string[] = [];
    setSourceRegistryEdges({
      resolve: async host => { asked.push(host); return (answers.shift() ?? []).map(address => ({ address, family: 4 as const })); },
      transport: { async get({ url }) { sent.push(url.href); return { status: 302, headers: { location: `${LAYER_PATH}?f=pjson&again=1` }, body: (async function* () { /* empty */ })(), close: () => undefined }; } },
    });
    await expect(callerFor(t.submitter).facilityDirectory.arcgis.inspect({ layerUrl: t.layerUrl })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("does not resolve to a public address") });
    expect(asked).toEqual([t.host, t.host]);
    expect(sent).toHaveLength(1);
  }, 60_000);

  it("a revocation between pages stops the import at the next page, and nothing is recorded", async () => {
    const t = await approvedSource();
    const all = features(4);
    const web = publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2, {
      1: async () => { await callerFor(t.approver).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: revoked mid-import" }); },
    }));
    await expect(importFrom(t.submitter, t)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("approval is revoked") });
    expect(web.sent.filter(u => u.includes("/query"))).toHaveLength(1);
    expect(await facilityCount(all)).toBe(0);
    expect(await datasetImports(t)).toBe(0);
  }, 60_000);

  it("an endpoint edit between pages stops the import: the source is back in review", async () => {
    const t = await approvedSource();
    const all = features(4);
    publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2, {
      1: async () => {
        await callerFor(t.submitter).sourceRegistry.endpointUpdate({
          sourceKey: t.sourceKey, expectedRowVersion: await version(t), endpointKey: "facilities_layer_0", displayName: "Test facilities layer", serviceType: "arcgis_feature_server", httpMethod: "GET",
          baseUrl: t.layerUrl, pathMatch: "prefix", authScheme: "NONE", contentTypes: ["application/json", "text/plain"], timeoutMs: 20_000, maxBytes: null, enabled: true, reason: "registry test: edited mid-import",
        });
      },
    }));
    await expect(importFrom(t.submitter, t)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("pending approval") });
    expect(await facilityCount(all)).toBe(0);
    expect(await datasetImports(t)).toBe(0);
  }, 60_000);

  it("a source re-approved between pages is a different authority: the import that began under the old one stops", async () => {
    const t = await approvedSource();
    const all = features(4);
    const second = await withRole("management");
    publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2, {
      1: async () => {
        await callerFor(t.approver).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: revoked mid-import" });
        await requestAndApprove(t, t.submitter, second);
      },
    }));
    await expect(importFrom(t.submitter, t)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("authority this operation started under changed") });
    expect(await facilityCount(all)).toBe(0);
    // Under the new approval a fresh import runs.
    publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2));
    expect(await importFrom(t.submitter, t)).toMatchObject({ inserted: 4 });
  }, 60_000);

  it("a revocation after the last page, before anything is written, records nothing", async () => {
    const t = await approvedSource();
    const all = features(2);
    publisher({ [t.host]: [PUBLIC] }, layer(t, all, 2, {
      1: async () => { await callerFor(t.approver).sourceRegistry.revoke({ sourceKey: t.sourceKey, expectedRowVersion: await version(t), reason: "registry test: revoked as the last page arrived" }); },
    }));
    await expect(importFrom(t.submitter, t)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("revoked") });
    expect(await facilityCount(all)).toBe(0);
    expect(await datasetImports(t)).toBe(0);
  }, 60_000);

  it("importFeatures fetches nothing, but records a URL only from an approved endpoint", async () => {
    const t = await draftSource();
    const input = { source: "sk_facilities", layerUrl: t.layerUrl, licenceKey: "sk_unrestricted_use_v2", wkid: 2957, layerFields: SK_FACILITIES.fields, mapping: SK_FACILITIES.mapping, features: features(1) };
    await expect(callerFor(t.submitter).facilityDirectory.arcgis.importFeatures(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("is draft") });
    await requestAndApprove(t);
    expect(await callerFor(t.submitter).facilityDirectory.arcgis.importFeatures(input)).toMatchObject({ inserted: 1, provenance: { sourceKey: t.sourceKey } });
    expect(await datasetImports(t)).toBe(1);
  }, 60_000);
});

describe("there is no way from an approval to a raw request", () => {
  const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("the registry, its router and the facility importer never call fetch or open a socket themselves", () => {
    for (const path of ["server/sourceRegistryService.ts", "server/sourceRegistryRouter.ts", "server/facilityDirectoryRouter.ts", "server/_core/sourceRegistry.ts"]) {
      const src = code(path);
      expect(src, path).not.toMatch(/\bfetch\s*\(/);
      expect(src, path).not.toMatch(/from\s+["'](node:)?(https?|net|tls|undici|axios)["']/);
    }
  });
  it("the facility importer's only network call is the registry gateway, and the gateway's only one is the egress guard", () => {
    const importer = code("server/facilityDirectoryRouter.ts");
    expect(importer).not.toMatch(/\b(guardedGet|egressGet)\s*\(/);
    expect(importer).toMatch(/\bregistryGet\s*\(/);
    const gateway = code("server/sourceRegistryService.ts");
    expect(gateway.match(/\bguardedGet\s*\(/g)).toHaveLength(1);
    expect(gateway).toMatch(/guardedGet\(url, edges, limits\)/);
  });
});
