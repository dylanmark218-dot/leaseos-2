import "dotenv/config";
import { startProductionWorker } from "./productionWorker";

// No top-level await: the project tsconfig has no ES2022 target, so the
// entrypoint runs through an explicit async main.
async function main(): Promise<void> {
  const worker = await startProductionWorker();
  if (!worker) throw new Error("Workflow worker did not start: DATABASE_URL is missing or WORKFLOW_WORKER_DISABLED=true");
  console.log(`[worker] started ${worker.lifecycle.workerId}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await worker.close(); process.exit(0); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

main().catch((err) => { console.error("[worker] fatal", err); process.exit(1); });
