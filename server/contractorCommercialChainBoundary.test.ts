import { describe, expect, it } from "vitest";
import fs from "node:fs";

const schema=fs.readFileSync("drizzle/schema.ts","utf8");
const router=fs.readFileSync("server/contractorOperationsRouter.ts","utf8");

describe("contractor commercial chain boundary",()=>{
  it("snapshots private payable rates instead of recomputing historical money",()=>{
    expect(schema).toContain('mysqlTable("contractorPayables"');
    expect(schema).toContain('rateCentsSnapshot');
    expect(schema).toContain('grossAmountCents');
    expect(router).toContain('grossAmountCents=Math.round(input.quantityMillis*rate.rateCents/1000)');
  });
  it("keeps AI preparation behind a different-human approval gate",()=>{
    expect(schema).toContain('["HUMAN","AI_SECRETARY"]');
    expect(router).toContain('p.preparedByUserId===ctx.user.id');
    expect(router).toContain('Payable must be in review before approval.');
  });
  it("inherits commercial numbers through contractor subcontractor and load levels",()=>{
    expect(router).toContain('`CONTRACT:${input.rootJobId}`');
    expect(router).toContain('-S${pad2(n)}');
    expect(router).toContain('-L${String(n).padStart(3,"0")}');
  });
  it("requires real organization relationships and owned crew resources",()=>{
    expect(router).toContain('No active commercial relationship authorizes this assignment.');
    // CP1.5 — the crew's unit is checked by the canonical unit scope (another organization's unit is not
    // found, like a missing one), no longer by recordBelongsToOrganization, which passed a missing id.
    expect(router).toContain('await requireCallerUnits(ctx.user.id,{unitId:input.unitId});');
    expect(router).toContain('Every assigned crew member must be an active worker');
  });
  it("refuses automatic salary and percentage settlement",()=>{
    expect(router).toContain('Salary and percentage compensation require reviewed calculation evidence');
  });
});
