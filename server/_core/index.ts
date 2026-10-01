/**
 * The production entrypoint: `pnpm build` bundles this file into `dist/index.js`, and
 * `pnpm start` runs it with `NODE_ENV=production`.
 *
 * P0-C — it serves the built client and nothing else. The import graph below it reaches no
 * build or development tool: no `vite`, no Vite plugin, no `vite.config.ts`. Development serving
 * has its own entrypoint (`./dev.ts`), so the production bundle cannot carry an edge to Vite
 * whatever the process is configured with. `productionDependencyBoundary.test.ts` checks the
 * source graph; `scripts/prod-runtime-smoke.sh` boots the built artifact with production
 * dependencies alone.
 */
import "dotenv/config";
import { reportStartupFailure, startServer } from "./startup";
import { serveStatic } from "./staticAssets";

startServer(app => serveStatic(app)).catch(reportStartupFailure);
