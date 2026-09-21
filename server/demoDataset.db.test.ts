/**
 * P5.4 — the demonstration dataset walks the chain through the real procedures.
 *
 * Not a fixture dump: every row here is created by the procedure a person would call, as a caller
 * holding a real role, so the walk cannot produce a state the API would refuse. Where the API does
 * refuse — a unit with no inspection is not dispatchable — the refusal is recorded as the result,
 * because that refusal is the product working, and a demo that bypassed it would be a lie.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { DEMO_MARK, NEVER_SEEDED, created, demoName, describeWalk, refusals, type DemoResult, type DemoStep } from "./_core/demoDataset";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 331_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

/** The walk. Each step records what happened; nothing is smoothed over. */
async function walkTheChain(): Promise<DemoResult> {
  const steps: DemoStep[] = [];
  const tag = rnd();
  const office = await member(null, ["management", "controller"]);
  const c = callerFor(office);

  // 1. The customer organization, named as a demonstration in the row itself.
  const orgName = demoName("Hauling Customer", tag);
  const org = await c.commercialOffice.organizations.create({ name: orgName });
  steps.push({ step: "customer organization", outcome: "created", ref: org.orgRef });

  // 2. The job. Its customer is the labelled organization, not a real account.
  const job = await c.fieldRoute.jobs.create({
    jobCode: `DEMO-${tag}`, type: "hydrovac excavation", mode: "hydrovac",
    customer: orgName, location: demoName("Lease", tag), status: "dispatched",
  } as never);
  steps.push({ step: "job", outcome: "created", ref: (job as { jobCode?: string }).jobCode ?? null });
  const [jobRow] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [`DEMO-${tag}`]);
  const jobId = Number(jobRow[0]!.id);

  // 3. A unit and an operator with nothing on file — the ordinary starting state of a real yard.
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`DEMO-U-${tag}`.slice(0, 20), "hydrovac"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [demoName("Operator", tag).slice(0, 40)]);
  steps.push({ step: "unit and operator", outcome: "created", ref: `${u.insertId}/${op.insertId}` });

  // 4. The load, with an approximate quantity stated as approximate.
  const load = await c.fieldRoute.compliance.loads.create({ jobId, material: "produced water", isWaste: true, quantity: "about 8 m3 (approximate, driver stated)" } as never);
  steps.push({ step: "load", outcome: "created", ref: (load as { loadNumber?: string }).loadNumber ?? null });

  // 5. The manifest. No UN number, no placard, no packing group: this dataset invents no
  //    dangerous-goods classification, so the TDG fields stay empty for a person to decide.
  const manifest = await c.fieldRoute.manifests.create({ manifestNumber: `DEMO-MAN-${tag}`, jobId, material: "produced water", unitId: Number(u.insertId) } as never);
  steps.push({ step: "manifest (no TDG classification invented)", outcome: "left_unknown", ref: (manifest as { manifestNumber?: string }).manifestNumber ?? `DEMO-MAN-${tag}` });

  // 6. The trip, linking job, unit and operator.
  const trip = await c.fieldRoute.trips.create({ tripNumber: `DEMO-TRP-${tag}`, jobId, unitId: Number(u.insertId), operatorId: Number(op.insertId) } as never);
  steps.push({ step: "trip", outcome: "created", ref: (trip as { tripNumber?: string }).tripNumber ?? `DEMO-TRP-${tag}` });

  // 7. Dispatch readiness. The unit has no inspection, registration or insurance on file, so the
  //    engine refuses it. That refusal is the point: a demo that dispatched anyway would teach a lie.
  try {
    const readiness = await c.dispatch.readiness({ operatorId: Number(op.insertId), unitId: Number(u.insertId), jobId } as never);
    const r = readiness as { verdict: string; blockers?: { code: string; detail?: string }[] };
    steps.push({
      step: "dispatch readiness", outcome: r.verdict === "eligible" ? "created" : "refused", ref: r.verdict,
      detail: (r.blockers ?? []).map(b => b.detail ?? b.code).join("; ") || `verdict ${r.verdict}`,
    });
  } catch (err) {
    steps.push({ step: "dispatch readiness", outcome: "refused", detail: err instanceof Error ? err.message : String(err) });
  }
  return { orgRef: org.orgRef, steps };
}

d("the demonstration dataset", () => {
  let result: DemoResult;
  beforeAll(async () => { result = await walkTheChain(); }, 90_000);

  it("walks the chain through the real procedures and creates a linked set of records", () => {
    expect(created(result.steps).map(s => s.step), describeWalk(result)).toEqual(
      expect.arrayContaining(["customer organization", "job", "unit and operator", "load", "trip"]));
    expect(result.orgRef).toMatch(/^ORG-/);
  });

  it("marks every row it writes as a demonstration, so a row found later says what it is", async () => {
    const [orgs] = await pool.query<mysql.RowDataPacket[]>("SELECT name FROM organizations WHERE orgRef = ?", [result.orgRef]);
    expect(String(orgs[0]!.name).startsWith(DEMO_MARK)).toBe(true);
    for (const [table, col, ref] of [["jobs", "jobCode", "DEMO-"], ["units", "unitNumber", "DEMO-U-"], ["trips", "tripNumber", "DEMO-TRP-"]] as const) {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ?`, [`${ref}%`]);
      expect(rows.length, `${table}.${col}`).toBeGreaterThan(0);
    }
  });

  it("meets the readiness engine rather than stepping around it", () => {
    // A walk that refused nothing never reached a decision worth demonstrating.
    expect(refusals(result.steps).length, describeWalk(result)).toBeGreaterThan(0);
    const readiness = result.steps.find(s => s.step === "dispatch readiness")!;
    expect(readiness.outcome).toBe("refused");
    expect(readiness.detail, "the refusal is recorded verbatim").toBeTruthy();
    // A missing procedure is not a refusal. The first run of this walk called a path that did not
    // exist and the exception counted as the engine refusing — a green that meant nothing. The
    // refusal must carry an engine verdict, and must not be a routing or validation error.
    // The guard is against a routing or validation error masquerading as a refusal — not against the
    // word "unknown", which is a legitimate blocker code (hos_unknown) and the invariant working.
    expect(readiness.detail).not.toMatch(/No procedure found|Invalid input/i);
    expect(readiness.detail, "named blockers, not a bare state").toMatch(/_missing|_unknown|_expired|_not_/);
    expect(String(readiness.ref), "the engine's own verdict, not an exception").toMatch(/^(ineligible|blocked|eligible_review|review)/i);
  });

  it("invents no regulatory figure and no dangerous-goods classification", async () => {
    const manifestStep = result.steps.find(s => s.step.startsWith("manifest"))!;
    expect(manifestStep.outcome).toBe("left_unknown");
    const [man] = await pool.query<mysql.RowDataPacket[]>("SELECT unNumber, material FROM manifests WHERE manifestNumber = ?", [manifestStep.ref]);
    expect(man[0]!.unNumber, "a UN number is a classification a person makes, never a seed").toBeNull();
    // And the module says out loud what it must never seed.
    expect(NEVER_SEEDED.length).toBeGreaterThan(5);
  });
});
