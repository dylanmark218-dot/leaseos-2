import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { startProductionWorker } from "./productionWorker";
import { assertProductionSecrets } from "./env";

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
  // Before anything binds a port or starts a worker. A production server that
  // cannot sign a session safely should never reach the point of accepting a
  // request it would mis-authenticate.
  assertProductionSecrets();

  const app = express();
  const server = createServer(app);
  const worker = await startProductionWorker();
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
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
