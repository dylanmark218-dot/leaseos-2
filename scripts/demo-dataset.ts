/**
 * P5.4 — run the demonstration dataset against a database and print the walk.
 *
 * Not a test: this is for showing someone the chain on a real database. It calls the same
 * procedures a person would, as a caller holding real roles, and prints each step with what came
 * back — including the readiness refusal, which is the part worth showing.
 *
 *   DATABASE_URL=mysql://... pnpm exec tsx scripts/demo-dataset.ts
 */
import mysql from "mysql2/promise";
import { appRouter } from "../server/routers";
import { demoName, describeWalk, type DemoStep } from "../server/_core/demoDataset";

const URL = process.env.DATABASE_URL;
if (!URL) { console.error("DATABASE_URL is required; this writes labelled demonstration rows to it."); process.exit(1); }
const pool = mysql.createPool({ uri: URL, connectionLimit: 3 });
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
let seq = 341_000_000 + Math.floor(Math.random() * 50_000);
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });

async function main() {
  const tag = rnd();
  const userId = seq++;
  for (const role of ["management", "controller"]) {
    await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  }
  const c = caller(userId);
  const steps: DemoStep[] = [];
  const orgName = demoName("Hauling Customer", tag);
  const org = await c.commercialOffice.organizations.create({ name: orgName });
  steps.push({ step: "customer organization", outcome: "created", ref: org.orgRef });

  await c.fieldRoute.jobs.create({ jobCode: `DEMO-${tag}`, type: "hydrovac excavation", mode: "hydrovac", customer: orgName, location: demoName("Lease", tag), status: "dispatched" } as never);
  const [jobRow] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [`DEMO-${tag}`]);
  const jobId = Number(jobRow[0]!.id);
  steps.push({ step: "job", outcome: "created", ref: `DEMO-${tag}` });

  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`DEMO-U-${tag}`.slice(0, 20), "hydrovac"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [demoName("Operator", tag).slice(0, 40)]);
  steps.push({ step: "unit and operator, nothing on file", outcome: "created", ref: `${u.insertId}/${op.insertId}` });

  await c.fieldRoute.compliance.loads.create({ jobId, material: "produced water", isWaste: true, quantity: "about 8 m3 (approximate, driver stated)" } as never);
  steps.push({ step: "load, quantity stated as approximate", outcome: "created" });

  await c.fieldRoute.manifests.create({ manifestNumber: `DEMO-MAN-${tag}`, jobId, material: "produced water", unitId: Number(u.insertId) } as never);
  steps.push({ step: "manifest, no TDG classification invented", outcome: "left_unknown", ref: `DEMO-MAN-${tag}` });

  await c.fieldRoute.trips.create({ tripNumber: `DEMO-TRP-${tag}`, jobId, unitId: Number(u.insertId), operatorId: Number(op.insertId) } as never);
  steps.push({ step: "trip", outcome: "created", ref: `DEMO-TRP-${tag}` });

  try {
    const r = await c.dispatch.readiness({ operatorId: Number(op.insertId), unitId: Number(u.insertId), jobId } as never);
    const v = r as { verdict: string; blockers?: { code: string; detail?: string }[] };
    steps.push({ step: "dispatch readiness", outcome: v.verdict === "eligible" ? "created" : "refused", ref: v.verdict,
      detail: (v.blockers ?? []).map(b => b.detail ?? b.code).join("; ") || undefined });
  } catch (err) { steps.push({ step: "dispatch readiness", outcome: "refused", detail: err instanceof Error ? err.message : String(err) }); }

  console.log(`\nDemonstration dataset — ${describeWalk({ orgRef: org.orgRef, steps })}\n`);
  for (const s of steps) {
    console.log(`  ${s.outcome === "created" ? "+" : s.outcome === "refused" ? "x" : "?"} ${s.step.padEnd(40)} ${String(s.ref ?? "").padEnd(22)} ${s.detail ?? ""}`);
  }
  console.log("\nEvery row above is prefixed DEMO. Nothing here is a verified regulatory value.\n");
  await pool.end();
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
