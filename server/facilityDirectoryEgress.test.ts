/**
 * The regulator-layer procedures reach the network only through the egress guard.
 *
 * `egressGuard.test.ts` proves the rules; this proves the three procedures use them. A
 * reviewer holds `facility.directory.review` (the grant is the only thing stubbed: no
 * database is needed, because every refusal here happens before one is touched), and
 * each procedure is handed a URL the guard must refuse without a lookup or a request.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  // The gate reads the acting organization's grants (B23.1), not the account's.
  listRoleGrantsInActingOrganization: async () => ({
    grants: [{ role: "safety", scopeType: "organization", orgRef: "default", scopeRef: null }],
    organization: "default",
  }),
  recordAuthorizationDecision: async () => 1,
}));

import { facilityDirectoryRouter } from "./facilityDirectoryRouter";

const reviewer = () => facilityDirectoryRouter.createCaller({ req: {} as never, res: {} as never, user: { id: 1, role: "user" } as never });
const layer = { source: "sk_facilities", licenceKey: "sk_unrestricted_use_v2", mapping: { id: "LICENCENUM" } };

let bareFetch: ReturnType<typeof vi.fn>;
beforeEach(() => { bareFetch = vi.fn(async () => { throw new Error("a bare fetch was reached"); }); vi.stubGlobal("fetch", bareFetch); });
afterEach(() => { expect(bareFetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("facilityDirectory.arcgis — every layer URL goes through the egress guard", () => {
  it("inspect refuses the metadata endpoint and a plain-http layer, as the caller's error", async () => {
    await expect(reviewer().arcgis.inspect({ layerUrl: "https://169.254.169.254/latest/meta-data/" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^Refused: .*cloud metadata endpoint/) });
    await expect(reviewer().arcgis.inspect({ layerUrl: "http://gis.saskatchewan.ca/egis/rest/services/Economy/Petroleum/FeatureServer/17" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("https only") });
  });

  it("importFromLayer refuses a localhost service and an IPv4-mapped private address", async () => {
    await expect(reviewer().arcgis.importFromLayer({ ...layer, layerUrl: "https://localhost:6443/arcgis/rest/services/x/FeatureServer/0" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(reviewer().arcgis.importFromLayer({ ...layer, layerUrl: "https://[::ffff:10.0.0.5]/arcgis/rest/services/x/FeatureServer/0" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("importFeatures fetches nothing, but will not record a URL the server would refuse to fetch — and says so before the database", async () => {
    await expect(reviewer().arcgis.importFeatures({ ...layer, layerUrl: "https://10.1.2.3/arcgis/rest/services/x/FeatureServer/0", wkid: 2957, layerFields: ["LICENCENUM"], features: [] }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("private network") });
  });

  it("has no bare fetch left in the router", () => {
    const source = readFileSync("server/facilityDirectoryRouter.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
