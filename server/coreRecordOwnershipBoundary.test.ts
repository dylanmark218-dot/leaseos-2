import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gateway = readFileSync("server/integrationRouter.ts", "utf8");
const schema = readFileSync("drizzle/schema.ts", "utf8");

describe("legacy core ownership boundary", () => {
  it("has one authoritative owner mapping for legacy records", () => {
    expect(schema).toContain('mysqlTable("coreRecordOwnership"');
    expect(schema).toContain('uniqueIndex("coreRecordOwnership_record_unique")');
    expect(schema).toContain('["unit", "operator", "load", "financial_entity"]');
  });

  it("does not trust a machine payload for organization ownership", () => {
    expect(gateway).not.toMatch(/orgRef:\s*z\./);
    expect(gateway).toContain('recordBelongsToOrganization(db, i.orgRef, "unit"');
    expect(gateway).toContain('recordBelongsToOrganization(db, i.orgRef, "operator"');
    expect(gateway).toContain('recordBelongsToOrganization(db, i.orgRef, "load"');
    expect(gateway).toContain('recordBelongsToOrganization(db, i.orgRef, "financial_entity"');
  });

  it("keeps ownership assignment on a human role-gated surface", () => {
    expect(gateway).toContain('ownershipAssign: roleProcedure("integration.clientRegister")');
    expect(gateway).not.toContain('ownershipAssign: integrationProcedure');
  });
});
