/**
 * Structural guard: credentialVerificationService is the only code that changes a compliance
 * credential's verification state. A new writer must go through it (or be added here deliberately,
 * with the reason), so a second, unguarded verify path cannot arrive by accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function serverFiles(dir = "server"): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return serverFiles(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}
const sources = serverFiles().map(f => ({ f, src: readFileSync(f, "utf8") }));

describe("one verification door for compliance credentials", () => {
  it("only the verification service updates complianceDocuments", () => {
    const writers = sources.filter(({ src }) => /\.update\(\s*complianceDocuments\s*\)/.test(src) || /UPDATE\s+`?complianceDocuments`?/i.test(src)).map(x => x.f);
    expect(writers).toEqual(["server/credentialVerificationService.ts"]);
  });

  it("the old unguarded review helper is gone", () => {
    expect(sources.filter(({ src }) => /function\s+reviewComplianceDocument\b/.test(src)).map(x => x.f)).toEqual([]);
  });

  it("every procedure that decides a credential calls the service", () => {
    const at = (f: string) => sources.find(x => x.f === f)!.src;
    const body = (src: string, from: string) => src.slice(src.indexOf(from), src.indexOf(from) + 1500);
    expect(body(at("server/complianceRouter.ts"), 'credentialVerify: roleProcedure("compliance.credentialVerify")')).toContain("decideComplianceCredential(");
    expect(body(at("server/driverPortfolioRouter.ts"), 'credentialVerify: roleProcedure("driverPortfolio.credentialVerify")')).toContain("decideComplianceCredential(");
    expect(body(at("server/routers.ts"), 'review: roleProcedure("documents.review")')).toContain("decideComplianceCredential(");
  });

  it("a credential inserted already verified is minted only by workforce, after the shared separation-of-duties rule", () => {
    // An insert into complianceDocuments that sets verificationStatus "verified".
    const minters = sources.filter(({ src }) => /insert\(\s*complianceDocuments\s*\)\.values\(\{[^;]*verificationStatus:\s*"verified"/.test(src)).map(x => x.f);
    expect(minters).toEqual(["server/workforceRouter.ts"]);
    const wf = sources.find(x => x.f === "server/workforceRouter.ts")!.src;
    for (const proc of ['taskVerify: roleProcedure("workforce.taskVerify")', 'trainingVerify: roleProcedure("workforce.trainingVerify")']) {
      const start = wf.indexOf(proc);
      const body = wf.slice(start, wf.indexOf("writeCredential(", start));
      expect(body, proc).toContain("assertMayDecide(");
    }
  });

  it("every insert into complianceDocuments records who entered it", () => {
    for (const { f, src } of sources) {
      for (const m of src.matchAll(/insert\(\s*complianceDocuments\s*\)\.values\(/g)) {
        const call = src.slice(m.index!, m.index! + 1400);
        // db.ts's generic insert takes the caller's row; its only caller passes recordedByUserId (pinned below).
        if (f === "server/db.ts") continue;
        expect(call.includes("recordedByUserId"), `${f} at ${m.index}`).toBe(true);
      }
    }
    const routers = sources.find(x => x.f === "server/routers.ts")!.src;
    expect(routers).toMatch(/createComplianceDocument\(\{ \.\.\.input, verificationStatus: "needs_review", recordedByUserId: ctx\.user\.id, privateDetail \}/);
  });
});
