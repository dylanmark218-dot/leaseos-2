import "dotenv/config";
import { startProductionWorker } from "./productionWorker";

const worker = await startProductionWorker();
if (!worker) throw new Error("Workflow worker did not start: DATABASE_URL is missing or WORKFLOW_WORKER_DISABLED=true");
console.log(`[worker] started ${worker.lifecycle.workerId}`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await worker.close(); process.exit(0); };
process.on("SIGTERM", close);
process.on("SIGINT", close);
