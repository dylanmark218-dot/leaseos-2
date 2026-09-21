import { appRouter } from "./server/routers";
const machine = (k: string | null) => appRouter.createCaller({ req: { headers: k ? { "x-integration-key": k } : {} } as never, res: {} as never, user: null as never });
async function go() {
  const r1 = await machine("x").inbound.ingest({ feed: "fuel_transaction", idempotencyKey: "a", payload: {} });
  const probe: never = r1.resultRef;
  return probe;
}
go();
