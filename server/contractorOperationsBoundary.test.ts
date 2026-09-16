import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const src=readFileSync("server/contractorOperationsRouter.ts","utf8");
const schema=readFileSync("drizzle/schema.ts","utf8");
describe("contractor and owner-operator architecture boundary",()=>{
  it("models nested organizations instead of pretending relationships are roles",()=>{ expect(schema).toContain('organizationRelationships'); expect(schema).toContain('"SUBCONTRACTOR"'); expect(schema).toContain('"LEASED_OWNER_OPERATOR"'); });
  it("keeps co-drivers distinct and declares individual HOS policy",()=>{ expect(schema).toContain('coDriverWorkerRef'); expect(src).toContain('INDIVIDUAL_PER_DRIVER'); expect(src).toContain('Primary driver and co-driver must be different workers'); });
  it("keeps rate schedules private to owner/counterparty organizations",()=>{ expect(schema).toContain('privateRateSchedules'); expect(src).toContain('ownerOrgRef'); expect(src).toContain('counterpartyOrgRef'); });
  it("requires the performing organization to create a nested subcontract",()=>{ expect(src).toContain('p.performingOrgRef!==assigningOrgRef'); });
  it("uses roleProcedure rather than generic authenticated procedures",()=>{ expect(src).not.toContain('protectedProcedure'); // Wired by PROCEDURE name (the census requires it); the permission is resolved through the map.
    expect(src).toContain('roleProcedure("contractorOperations.payableApprove")');
    expect(src).not.toContain('roleProcedure("contractor.approve")'); });
});
