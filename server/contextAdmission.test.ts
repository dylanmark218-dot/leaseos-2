/**
 * v22.20 — nothing becomes model-readable because it looks right.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  admitSource, AdmissionRefused, authenticatedUserBlock, project, projectionOmits,
  systemPromptBlock, type ActingContext, type ContextResolver, type ResolvedSource,
} from "./_core/contextAdmission";
import { assembleContext } from "./_core/contextAssembly";

const AT = new Date("2026-09-13T12:00:00Z");
const acting: ActingContext = { userId: 7, tenantId: "ORG-A", heldPermissions: ["job.read"], multiTenant: false };

/** A resolver standing in for a real table lookup. */
const resolverFor = (rows: Record<string, ResolvedSource | null>): ContextResolver => ({
  resolverKey: "test-resolver",
  resolve: async (ref) => rows[ref] ?? null,
});
const registry = (r: ContextResolver, kind = "job") => new Map([[kind, r]]);

const jobRow = (o: Partial<ResolvedSource> = {}): ResolvedSource => ({
  sourceRef: "J-1", kind: "record_data", proof: { kind: "row", tenantId: "ORG-A" },
  permission: "job.read", text: "jobCode: J-1", ...o,
});

describe("a foreign reference is indistinguishable from a made-up one", () => {
  it("answers the same for a record that does not exist and one belonging elsewhere", async () => {
    const resolvers = registry(resolverFor({
      "J-MINE": jobRow(),
      "J-THEIRS": jobRow({ sourceRef: "J-THEIRS", proof: { kind: "row", tenantId: "ORG-B" } }),
    }));
    const args = { resolvers, sourceKind: "job", acting, at: AT, blockRef: "B1" };

    let missing = "", foreign = "";
    try { await admitSource({ ...args, sourceRef: "J-NOTHING" }); } catch (e) { missing = (e as Error).message; }
    try { await admitSource({ ...args, sourceRef: "J-THEIRS" }); } catch (e) { foreign = (e as Error).message; }
    // Knowing a real reference from another organization must teach nothing.
    expect(missing).toBe("No such job");
    expect(foreign).toBe(missing);
  });

  it("admits a record the principal may read, with the proof attached", async () => {
    const b = await admitSource({
      resolvers: registry(resolverFor({ "J-1": jobRow() })), sourceKind: "job",
      sourceRef: "J-1", acting, at: AT, blockRef: "B1",
    });
    expect(b.kind).toBe("record_data");
    expect(b.admission).toMatchObject({ principalUserId: 7, tenantId: "ORG-A", resolverKey: "test-resolver", permission: "job.read" });
    expect(b.admission.proof).toEqual({ kind: "row", tenantId: "ORG-A" });
  });

  it("refuses a source kind no resolver covers rather than loading it on trust", async () => {
    await expect(admitSource({
      resolvers: registry(resolverFor({}), "job"), sourceKind: "payrollRecord",
      sourceRef: "P-1", acting, at: AT, blockRef: "B1",
    })).rejects.toThrow(/An unresolvable source is refused rather than loaded on trust/);
  });

  it("refuses a record whose declared permission the principal does not hold", async () => {
    // The receipt recorded this permission and admitted the block anyway, so a
    // resolver could say "requires payroll.read" and a dispatcher would read it
    // — with the receipt then looking like evidence of a check.
    const restricted = jobRow({ permission: "payroll.read" });
    await expect(admitSource({
      resolvers: registry(resolverFor({ "J-1": restricted })), sourceKind: "job",
      sourceRef: "J-1", acting, at: AT, blockRef: "B1",
    })).rejects.toThrow(/No such job/);
  });

  it("admits it once the principal holds that permission", async () => {
    const restricted = jobRow({ permission: "payroll.read" });
    const b = await admitSource({
      resolvers: registry(resolverFor({ "J-1": restricted })), sourceKind: "job",
      sourceRef: "J-1", acting: { ...acting, heldPermissions: ["job.read", "payroll.read"] },
      at: AT, blockRef: "B1",
    });
    expect(b.admission.permission).toBe("payroll.read");
  });

  it("refuses a missing permission in the same words as a missing record", async () => {
    const restricted = jobRow({ permission: "payroll.read" });
    let forbidden = "", missing = "";
    try {
      await admitSource({ resolvers: registry(resolverFor({ "J-1": restricted })), sourceKind: "job", sourceRef: "J-1", acting, at: AT, blockRef: "B" });
    } catch (e) { forbidden = (e as Error).message; }
    try {
      await admitSource({ resolvers: registry(resolverFor({})), sourceKind: "job", sourceRef: "J-NOTHING", acting, at: AT, blockRef: "B" });
    } catch (e) { missing = (e as Error).message; }
    // Holding a real reference to something you may not read teaches nothing.
    expect(forbidden).toBe(missing);
  });

  it("leaves the resolver to refuse a same-tenant record the principal may not read", async () => {
    // The resolver returns null for an unauthorized row; admission reports it
    // exactly as absent.
    const resolvers = registry(resolverFor({ "P-1": null }));
    await expect(admitSource({ resolvers, sourceKind: "job", sourceRef: "P-1", acting, at: AT, blockRef: "B1" }))
      .rejects.toThrow(/No such job/);
  });
});

describe("tenant proof is stated, not assumed", () => {
  it("accepts a legacy single-tenant row while only one organization exists", async () => {
    const legacy = jobRow({ proof: { kind: "legacy_single_tenant", tenantId: "ORG-A" } });
    const b = await admitSource({
      resolvers: registry(resolverFor({ "J-1": legacy })), sourceKind: "job",
      sourceRef: "J-1", acting, at: AT, blockRef: "B1",
    });
    expect(b.admission.proof.kind).toBe("legacy_single_tenant");
  });

  it("refuses that same row once a second organization exists", async () => {
    const legacy = jobRow({ proof: { kind: "legacy_single_tenant", tenantId: "ORG-A" } });
    // Today's honest limitation must not become tomorrow's invisible leak.
    await expect(admitSource({
      resolvers: registry(resolverFor({ "J-1": legacy })), sourceKind: "job",
      sourceRef: "J-1", acting: { ...acting, multiTenant: true }, at: AT, blockRef: "B1",
    })).rejects.toThrow(/not where unfinished multi-tenancy gets completed/);
  });

  it("accepts ownership proved through a parent", async () => {
    const child = jobRow({ proof: { kind: "parent", parentType: "job", parentRef: "J-1", tenantId: "ORG-A" } });
    const b = await admitSource({
      resolvers: registry(resolverFor({ "T-9": child })), sourceKind: "job",
      sourceRef: "T-9", acting, at: AT, blockRef: "B1",
    });
    expect(b.admission.proof).toMatchObject({ kind: "parent", parentRef: "J-1" });
  });
});

describe("a statement must be traceable", () => {
  it("refuses a document block with no source identity", async () => {
    const orphan = jobRow({ kind: "retrieved_document", sourceRef: "" });
    await expect(admitSource({
      resolvers: registry(resolverFor({ "D-1": orphan })), sourceKind: "job",
      sourceRef: "D-1", acting, at: AT, blockRef: "B1",
    })).rejects.toThrow(/cannot be traced afterwards/);
  });

  it("lets our own prompt carry no organization and no source", () => {
    const b = systemPromptBlock({ blockRef: "SYS", text: "You are...", at: AT });
    expect(b.tenantId).toBeNull();
    expect(b.admission.proof).toEqual({ kind: "system" });
  });

  it("takes a user's organization from their session, not their message", () => {
    const b = authenticatedUserBlock({ blockRef: "USR", text: "I work for ORG-B", acting, at: AT });
    // The request says what they asked, not who they are.
    expect(b.tenantId).toBe("ORG-A");
    expect(b.admission.principalUserId).toBe(7);
  });
});

describe("fields are projected, not trimmed", () => {
  const employee = { employeeRef: "E-1", displayName: "Jordan", availability: "on shift", payRate: 48.5, homeAddress: "12 Elm St" };

  it("includes only the named fields", () => {
    const text = project(employee, ["employeeRef", "displayName", "availability"]);
    expect(text).toContain("displayName: Jordan");
    expect(projectionOmits(text, ["48.5", "Elm St"])).toBe(true);
  });

  it("leaves a column added later out by default", () => {
    // Deleting sensitive keys would opt every future column in.
    const withNewColumn = { ...employee, disciplinaryNote: "verbal warning 2026-03" };
    const text = project(withNewColumn, ["employeeRef", "displayName", "availability"]);
    expect(text).not.toContain("verbal warning");
  });

  it("skips a named field that is absent rather than printing null", () => {
    expect(project({ a: "x", b: null }, ["a", "b"])).toBe("a: x");
  });
});

describe("the model boundary takes admitted blocks only", () => {
  it("assembles from admitted blocks", async () => {
    const rec = await admitSource({
      resolvers: registry(resolverFor({ "J-1": jobRow() })), sourceKind: "job",
      sourceRef: "J-1", acting, at: AT, blockRef: "B2",
    });
    const r = assembleContext({
      tenantId: "ORG-A",
      blocks: [systemPromptBlock({ blockRef: "SYS", text: "sys", at: AT }), authenticatedUserBlock({ blockRef: "USR", text: "q", acting, at: AT }), rec],
    });
    expect(r.blocks).toHaveLength(3);
    expect(r.instructingBlocks).toEqual(["SYS", "USR"]);
  });

  it("rejects a hand-built block at compile time", () => {
    // Tests are excluded from tsconfig, so this is asserted against the source:
    // a raw object is a compile error in production code (TS2739, verified).
    const src = readFileSync("server/_core/contextAssembly.ts", "utf8");
    expect(src).toContain("blocks: readonly AdmittedContextBlock[]");
    const admission = readFileSync("server/_core/contextAdmission.ts", "utf8");
    expect(admission).toContain("declare const admitted: unique symbol");
    // And there is no generic admit(kind, tenantId, text) to go around it.
    expect(admission).not.toMatch(/export function admit\b/);
  });

  it("still refuses a context mixing organizations", async () => {
    const mine = await admitSource({
      resolvers: registry(resolverFor({ "J-1": jobRow() })), sourceKind: "job",
      sourceRef: "J-1", acting, at: AT, blockRef: "B1",
    });
    const theirs = await admitSource({
      resolvers: registry(resolverFor({ "J-2": jobRow({ sourceRef: "J-2", proof: { kind: "row", tenantId: "ORG-B" } }) })),
      sourceKind: "job", sourceRef: "J-2", acting: { ...acting, tenantId: "ORG-B" }, at: AT, blockRef: "B2",
    });
    expect(() => assembleContext({ tenantId: "ORG-A", blocks: [mine, theirs] })).toThrow();
  });
});
