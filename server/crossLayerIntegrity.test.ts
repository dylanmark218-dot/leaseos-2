/**
 * Does the whole thing connect? Two checks the gate did not make until now.
 *
 * 1. Every tRPC path the client calls exists on the server's appRouter. A client
 *    screen calling a procedure that was renamed or never wired is a runtime 404
 *    that typecheck cannot always see (string paths in utils.invalidate, lazy routes).
 * 2. The HTTP layer boots with the real router and context, and the auth gate
 *    engages over the wire: an anonymous HTTP request to a role-gated procedure is
 *    refused with UNAUTHORIZED, not served, not crashed.
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext } from "./_core/context";
import { appRouter } from "./routers";

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) files(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p); }
  return out;
}
const serverPaths = new Set(Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures));

describe("client ↔ server parity", () => {
  it("every tRPC path the client references exists on appRouter", () => {
    const refs = new Set<string>();
    for (const f of files("client/src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\btrpc\.([a-zA-Z_][a-zA-Z0-9_.]*)\.(useQuery|useMutation|useInfiniteQuery|useSubscription|query|mutate|fetch|prefetch)\(/g)) refs.add(m[1]!);
      for (const m of src.matchAll(/\butils\.([a-zA-Z_][a-zA-Z0-9_.]*)\.(invalidate|fetch|prefetch|setData|getData|cancel)\(/g)) refs.add(m[1]!);
    }
    expect(refs.size).toBeGreaterThan(50);
    const missing = Array.from(refs).filter(p => !serverPaths.has(p) && !Array.from(serverPaths).some(s => s.startsWith(p + ".")));   // a namespace reference (utils.x.invalidate) is fine
    expect(missing, `client references procedures the server does not mount: ${missing.join(", ")}`).toEqual([]);
  });
  it("the router mounts a stable, large surface", () => {
    expect(serverPaths.size).toBe(744);   // driver portfolio (0202–0204): +18 driverPortfolio.* (17 role-authorized + the public shareRedeem);   // Document Control A–C: +23 documentControl.{definitions,documents,series}.*;   // C1b-2b: +5 compliance.{requirementVerify,requirementSecondApprove,requirementWithdraw,verificationPolicySet,requirementProvenance}   // S1: +2 auth.{refresh,revokeAll} — the session family's own controls   // canonical assignment: +3 dispatch.{createPosting,addRole,listRoles} — the slot model had no production door, so dispatchPostings/dispatchRoles had zero INSERT paths anywhere;   // v22.40: +3 commercialOffice.{organizations.create,organizations.list,disposal.statements} (P7.9);   // v22.38: +9 commercialOffice.documents.* (P7.7);   // v22.36: +2 facilityDirectory.{hydrovac.import,duplicates};   // v22.35 (0143): +6 facilityDirectory.{arcgis.presets,arcgis.inspect,arcgis.importFeatures,arcgis.importFromLayer,arcgis.runs,lsdFind}; move on purpose   // v22.67: +6 automationPolicy.{resolve,set,setEntitlement,operationalOverride,history,snapshotFor} (P8.2) +1 hos.attestHours (P8.3), +1 hos.recordScannedLog, +8 restrictedVault.* (P8.5), +1 restrictedVault.restrictedIndex, +1 device.verifySeal (P1.2);   // readiness repair: +1 records.maintenance.resolveDefect — a defect can be resolved explicitly, which is what stopped readiness inferring it from release chronology
    expect(serverPaths.has("facilityDirectory.driverView")).toBe(true);
    expect(serverPaths.has("commercialOffice.approvals.requirement")).toBe(true);
  });
});

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("HTTP boot smoke", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
    server = createServer(app);
    await new Promise<void>(res => server.listen(0, "127.0.0.1", () => res()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/api/trpc`;
  });
  afterAll(async () => { await new Promise<void>(res => server.close(() => res())); });
  it("routes an anonymous request through the real router and context and refuses a role-gated procedure with UNAUTHORIZED", async () => {
    const r = await fetch(`${base}/facilityDirectory.licences.list`);
    const body = await r.json() as { error?: { json?: { data?: { code?: string } }; data?: { code?: string } } };
    const code = body.error?.json?.data?.code ?? body.error?.data?.code;
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(code).toBe("UNAUTHORIZED");
  });
  it("returns NOT_FOUND for a path that does not exist, so a stale client would fail loudly rather than silently", async () => {
    const r = await fetch(`${base}/nope.notHere`);
    expect(r.status).toBe(404);
  });
});
