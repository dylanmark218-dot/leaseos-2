/**
 * Fleet/Unit Security CP1.5 — the structural guard behind the unit-scope sweep.
 *
 * `roleProcedure` checks a role, never a tenant, so a mutation that takes a unit id from the request
 * and does not check it writes whatever unit it is given (docs/register/UNIT_SCOPE_SWEEP_2026-09-25.md
 * found twenty). This reads every router mutation whose input — inline or through a named schema —
 * names a unit, and requires its handler to call a canonical scope check. A new mutation that takes a
 * unit and forgets fails here, before it can be merged; one that genuinely need not check is listed
 * below with the reason, where a reviewer sees it.
 *
 * The canonical checks all rest on `unitInScope` (db.ts): `server/unitScope.ts` (the refusal every
 * CP1.5 fix uses), and the older call sites that already refused as not found in the same words.
 * `recordBelongsToOrganization` is not one: it treats an id that does not exist as the historical
 * tenant's, so it is refused as a mutation's unit check.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UNIT_KEYS = /\b(unitId|trailerId|unitIds|trailerUnitId|approvedUnitIds|assignedUnitId|equipmentId)\s*:/;
const CANONICAL = /\b(requireCallerUnits|requireUnitInScope|requireUnitsInScope|unitInScope|workOrderInScope|fieldTicketInScope|assertReadinessSubjectInScope|unitOrNotFound|unitInCallerScope)\(/;

/** Mutations that name a unit and need not check it, each with the reason. Keep this short. */
const NEED_NOT: Record<string, string> = {
  "gps.submitBreadcrumb": "`unitId` is REFUSED in its input; the unit is the one on the caller's in-scope trip",
  "commercialSetup.pricingDecide": "`unitId` only selects which of the caller's entity's rates applies; nothing is written against the unit",
  "fuel.dispenseRecord#equipmentId": "`equipmentId` is shop equipment, not a unit; the unit it names is checked",
};

/**
 * Mutations whose unit check lives in a helper they call. Each helper's own source is required to
 * make a canonical check, so moving the check out of the helper fails here too.
 */
const DELEGATES: Record<string, { calls: string; file: string; fn: string }> = {
  "dispatch.setRoleAssignment": { calls: "setRoleAssignment(", file: "server/dispatchRoleService.ts", fn: "async function applyBinding" },
  "manifestCustody.bind": { calls: "resolveParties(", file: "server/manifestCustodyRouter.ts", fn: "async function resolveParties" },
  "manifestCustody.amend": { calls: "resolveParties(", file: "server/manifestCustodyRouter.ts", fn: "async function resolveParties" },
};

/** The text of the balanced (...) that opens at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

type Mutation = { file: string; procedure: string; input: string; body: string };

function mutations(): Mutation[] {
  const files = readdirSync("server").filter(f => (/Router\.ts$/.test(f) || f === "routers.ts") && !f.endsWith(".test.ts")).map(f => `server/${f}`);
  const out: Mutation[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Named schemas: `const X = z.object(...)`, taken to their balanced close.
    const named = new Map<string, string>();
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*z\.(?:object|array)\(/g)) named.set(m[1]!, balanced(src, m.index! + m[0].length - 1));
    // Every procedure builder ends the previous procedure — a machine or portal procedure after the last
    // role procedure in a file is not part of it.
    const boundaries = Array.from(src.matchAll(/\b(?:roleProcedure|integrationProcedure|externalProcedure|publicProcedure|protectedProcedure|adminProcedure)\b/g)).map(b => b.index!);
    const starts = Array.from(src.matchAll(/roleProcedure\(\s*"([^"]+)"\s*\)/g));
    starts.forEach(m => {
      const end = boundaries.find(b => b > m.index!) ?? src.length;
      const chunk = src.slice(m.index!, end);
      const at = chunk.indexOf(".mutation(");
      if (at < 0) return;
      const head = chunk.slice(0, at);
      const inputAt = head.indexOf(".input(");
      let input = inputAt >= 0 ? balanced(head, inputAt + ".input".length) : "";
      for (const [name, text] of Array.from(named)) if (new RegExp(`\\b${name}\\b`).test(input)) input += text;
      out.push({ file, procedure: m[1]!, input, body: chunk.slice(at) });
    });
  }
  return out;
}

describe("a router mutation that names a unit checks it through the canonical scope", () => {
  const all = mutations();
  const unitTaking = all.filter(m => UNIT_KEYS.test(m.input));

  it("finds the mutations the sweep found (the guard is reading what it claims to)", () => {
    const names = new Set(unitTaking.map(m => m.procedure));
    for (const p of ["roadside.open", "enforcement.eventConfirm", "records.incident.capture", "comms.unitCapabilitySet", "jobUnits.create", "manifestCustody.bind", "trips.create"]) expect(names, p).toContain(p);
    expect(unitTaking.length).toBeGreaterThanOrEqual(45);
  });

  it("every one calls a canonical unit-scope check, or is listed with the reason it need not", () => {
    const unguarded = unitTaking
      .filter(m => !CANONICAL.test(m.body))
      .filter(m => !NEED_NOT[m.procedure])
      .filter(m => !(DELEGATES[m.procedure] && m.body.includes(DELEGATES[m.procedure]!.calls)))
      .map(m => `${m.procedure} (${m.file})`);
    expect(unguarded, "A mutation takes a unit id and never checks it. Call requireCallerUnits / requireUnitInScope (server/unitScope.ts).").toEqual([]);
  });

  it("no mutation uses recordBelongsToOrganization as its unit check — it passes an id that does not exist", () => {
    const offenders = all.filter(m => /recordBelongsToOrganization\([^)]*"unit"/.test(m.body)).map(m => m.procedure);
    expect(offenders).toEqual([]);
  });

  it("each helper a mutation delegates its unit check to makes that check itself", () => {
    for (const [procedure, d] of Object.entries(DELEGATES)) {
      const src = readFileSync(d.file, "utf8");
      const at = src.indexOf(d.fn);
      expect(at, `${procedure}: ${d.fn} not found in ${d.file}`).toBeGreaterThanOrEqual(0);
      const next = src.indexOf("\nasync function ", at + 1), nextExport = src.indexOf("\nexport ", at + 1);
      const body = src.slice(at, Math.min(...[next, nextExport, src.length].filter(i => i > at)));
      expect(CANONICAL.test(body), `${procedure}: ${d.fn} no longer makes a canonical unit check`).toBe(true);
    }
  });

  it("the exceptions are real and still take a unit", () => {
    for (const key of Object.keys(NEED_NOT)) {
      const procedure = key.split("#")[0]!;
      expect(all.some(m => m.procedure === procedure), `${procedure} is excused but no longer exists`).toBe(true);
    }
  });
});
