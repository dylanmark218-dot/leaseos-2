/**
 * P1.5 — the manifest, and the two rules it exists to hold.
 *
 * Every case is a state a truck genuinely reaches: a job with no dangerous goods, an SDS that was
 * never fetched, a route cached on Monday for a Thursday run, a file on the device that nobody can
 * date.
 */
import { describe, expect, it } from "vitest";
import { evaluateDeparture, manifestFor, type CacheItem, type CachedState } from "./preDepartureCache";

const NOW = new Date("2026-09-18T08:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const JOB = {
  jobCode: "JOB-08421", tripRef: "TR-2026-000812", routeApprovalRef: "RA-991",
  dangerousGoods: [] as { unNumber: string; shippingName: string }[],
  destinationFacilities: [] as { facilityRef: string; name: string }[],
  permits: [] as { permitRef: string; kind: string }[],
  leaseLocation: "04-12-055-20W4", hasCommunicationDeadZones: false,
};

const allCached = (fetchedAt: Date | null = minutesAgo(5)) => (): CachedState => ({ present: true, fetchedAt } as CachedState);

describe("the manifest is derived from the job's own facts", () => {
  it("asks for no SDS when the job carries no dangerous goods", () => {
    const kinds = manifestFor(JOB).map(i => i.kind);
    expect(kinds).not.toContain("sds");
    expect(kinds).not.toContain("emergency_plan");
    // A list padded with items this job cannot need teaches drivers that half of it is noise,
    // after which the half that matters is noise too.
    expect(kinds).toContain("job");
    expect(kinds).toContain("route");
  });

  it("asks for the SDS and the ERP once the load carries a UN number, naming it", () => {
    const items = manifestFor({ ...JOB, dangerousGoods: [{ unNumber: "UN1267", shippingName: "Petroleum crude oil" }] });
    const sds = items.find(i => i.kind === "sds")!;
    expect(sds.label).toBe("SDS — Petroleum crude oil (UN1267)");
    expect(sds.necessity).toBe("required_to_depart");
    expect(sds.because).toMatch(/exactly where there is no signal/);
    expect(items.find(i => i.kind === "emergency_plan")!.because).toMatch(/not a plan/);
  });

  it("asks for map tiles only when there is a route to read", () => {
    expect(manifestFor({ ...JOB, routeApprovalRef: null }).map(i => i.kind)).not.toContain("map_tiles");
    expect(manifestFor(JOB).map(i => i.kind)).toContain("map_tiles");
  });

  it("separates what holds the truck from what is needed on site", () => {
    const items = manifestFor({ ...JOB, destinationFacilities: [{ facilityRef: "FAC-7", name: "West Ridge Disposal" }] });
    expect(items.find(i => i.kind === "facility")!.necessity).toBe("required_on_site");
    expect(items.find(i => i.kind === "route")!.necessity).toBe("required_to_depart");
  });

  it("adds the comms plan only where the route crosses known dead zones", () => {
    expect(manifestFor(JOB).map(i => i.kind)).not.toContain("communications");
    const withDead = manifestFor({ ...JOB, hasCommunicationDeadZones: true });
    expect(withDead.find(i => i.kind === "communications")!.because).toMatch(/not something to look up once you are in one/);
  });
});

describe("missing is named, never counted", () => {
  it("names the item and why this job needs it", () => {
    const items = manifestFor({ ...JOB, dangerousGoods: [{ unNumber: "UN1267", shippingName: "Petroleum crude oil" }] });
    const v = evaluateDeparture(items, (i: CacheItem) => i.kind === "sds" ? { present: false } : { present: true, fetchedAt: minutesAgo(5) }, NOW);
    expect(v.mayDepart).toBe(false);
    expect(v.blocking.map(i => i.kind)).toEqual(["sds"]);
    expect(v.explanation).toMatch(/SDS — Petroleum crude oil \(UN1267\) \(missing\)/);
    // Not a percentage, not "3 of 8 items". Something a driver can act on in the yard.
    expect(v.explanation).not.toMatch(/%|\d+ of \d+/);
  });

  it("lets the truck leave when only an on-site item is missing, and still says so", () => {
    const items = manifestFor({ ...JOB, destinationFacilities: [{ facilityRef: "FAC-7", name: "West Ridge Disposal" }] });
    const v = evaluateDeparture(items, (i: CacheItem) => i.kind === "facility" ? { present: false } : { present: true, fetchedAt: minutesAgo(5) }, NOW);
    expect(v.mayDepart).toBe(true);                       // a closed-gate risk is not a reason to hold the yard
    expect(v.neededOnSite.map(i => i.kind)).toEqual(["facility"]);
    expect(v.explanation).toMatch(/will be needed on site and are not cached: West Ridge Disposal/);
  });

  it("says plainly when everything is there", () => {
    const v = evaluateDeparture(manifestFor(JOB), allCached(), NOW);
    expect(v.mayDepart).toBe(true);
    expect(v.explanation).toBe("Everything this job needs is on the device.");
  });
});

describe("cached is not current", () => {
  it("blocks on a route cached longer ago than it may be trusted", () => {
    // Cached Monday, driving Thursday. The file is there; what it says is three days old.
    const v = evaluateDeparture(manifestFor(JOB), (i: CacheItem) => ({ present: true, fetchedAt: i.kind === "route" ? minutesAgo(60 * 24 * 3) : minutesAgo(5) }), NOW);
    expect(v.mayDepart).toBe(false);
    const route = v.blocking.find(i => i.kind === "route")!;
    expect(route.status).toBe("stale");
    expect(route.detail).toMatch(/trusted for 720\. Fetch it again before leaving/);
  });

  it("treats an undateable file as unverifiable, not as fresh", () => {
    const v = evaluateDeparture(manifestFor(JOB), allCached(null), NOW);
    expect(v.mayDepart).toBe(false);
    expect(v.blocking.every(i => i.status === "age_unknown")).toBe(true);
    expect(v.blocking[0]!.detail).toMatch(/nothing here can say whether it is still true/);
  });

  it("leaves an item alone when it genuinely does not go stale", () => {
    const items: CacheItem[] = [{ kind: "job", label: "A closed record", ref: "X", necessity: "required_to_depart", because: "test", staleAfterMinutes: null }];
    const v = evaluateDeparture(items, () => ({ present: true, fetchedAt: minutesAgo(60 * 24 * 365) }), NOW);
    expect(v.mayDepart).toBe(true);
    expect(v.items[0]!.detail).toMatch(/does not go stale/);
  });
});
