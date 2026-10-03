/**
 * S2-E Phase 2A — print the webhook cutover preflight for the database and keys in the environment.
 *
 *   DATABASE_URL=… LEASEOS_KEY_WEBHOOK_V1=… LEASEOS_PORTAL_MFA_KEY=… pnpm tsx scripts/webhook-cutover-preflight.ts
 *
 * Exit 0 only when `cutoverAllowed` is true. The output carries counts, categories and blockers —
 * never a secret, an envelope or a `secretRef`. Expect it to say BLOCKED until a managed key provider
 * exists and the fleet can be observed; that is the report doing its job, not failing at it.
 *
 * S2-KMS-A: the keys come from the same configuration and bootstrap the server and worker use
 * (`LEASEOS_SECRET_KEYS_SOURCE`, `LEASEOS_MANAGED_KEYS`). An operator never copies a DEK into a
 * shell to run this; under a managed source the backend unwraps it here exactly as at startup, and
 * a failed bootstrap exits 1 rather than reporting on environment keys.
 */
import { webhookCutoverPreflightFromEnvironment } from "../server/webhookCutoverPreflight";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const report = await webhookCutoverPreflightFromEnvironment();
  console.log(JSON.stringify(report, null, 2));
  // S2-FLEET-A: the fleet line an operator reads first. Observed from the runtime registry; `converged`
  // needs external deployment evidence the observation service does not yet have a source for.
  console.log(
    `fleet: ${report.fleet.state} — live servers ${report.fleet.liveServers}, live workers ${report.fleet.liveWorkers}, ` +
      `live builds ${report.fleet.liveBuilds.length}, live incompatible ${report.fleet.liveIncompatible.length}, stale ${report.fleet.stale}, ` +
      `external confirmation ${report.fleet.externalConfirmation}`
  );
  console.log(report.cutoverAllowed ? "S2-E cutover: ALLOWED" : `S2-E cutover: BLOCKED (${report.blockers.length} blocker(s))`);
  process.exit(report.cutoverAllowed ? 0 : 3);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
