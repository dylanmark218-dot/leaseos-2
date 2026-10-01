/**
 * The development entrypoint: `pnpm dev` runs this file through tsx with `NODE_ENV=development`.
 *
 * P0-C — the one place Vite is reached from. The startup is the same as production's
 * (`./startup.ts`); only the client is served differently, by Vite in middleware mode with HMR
 * over this server (`./vite.ts`). This file is not part of the production build.
 */
import "dotenv/config";
import { reportStartupFailure, startServer } from "./startup";
import { setupVite } from "./vite";

startServer((app, server) => setupVite(app, server)).catch(reportStartupFailure);
