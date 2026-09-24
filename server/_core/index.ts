import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { clientContractGate } from "./clientContractGate";
import { serveStatic, setupVite } from "./vite";
import { startProductionWorker } from "./productionWorker";
import { ENV, assertProductionSecrets } from "./env";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // One decision, read twice. Which bundle gets served and which configuration
  // must be present to serve it are the same question, and asking it twice is
  // how they drift: `ENV.isProduction` is `NODE_ENV === "production"`, while the
  // choice below serves the production bundle for anything that is not
  // "development". A deployment with NODE_ENV unset, or set to "staging", lands
  // in the gap — production assets, no secret check.
  const isDevelopment = process.env.NODE_ENV === "development";

  // Before anything binds a port or starts a worker: a server that cannot
  // authenticate anyone should not reach the point of accepting requests.
  assertProductionSecrets(ENV, !isDevelopment);

  const app = express();
  const server = createServer(app);
  const worker = await startProductionWorker();
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerOAuthRoutes(app);
  // tRPC API — installed clients declare their contract; see clientContractGate.ts
  app.use(
    "/api/trpc",
    clientContractGate(),
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (isDevelopment) {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    if (worker) console.log(`[worker] started ${worker.lifecycle.workerId}`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (worker) await worker.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startServer().catch(error => {
  // A refusal to start is not a background error to log and carry on from: the
  // process has no server, and exiting non-zero is what makes a supervisor or a
  // deploy pipeline report the failure rather than declare success.
  console.error(error);
  process.exitCode = 1;
});
