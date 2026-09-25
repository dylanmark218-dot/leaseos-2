/**
 * Liveness and readiness — two different questions, deliberately not merged.
 *
 * `/healthz` asks *is this process alive*. It consults nothing: no database, no worker, no
 * provider. That is a decision, not an omission. A liveness probe that checks a dependency
 * converts a brief database blip into a simultaneous restart of every healthy application
 * process, which is how a short outage becomes a long one. If the HTTP server can answer,
 * the process is alive; whether it can currently do useful work is the other question.
 *
 * `/readyz` asks *should this process be sent work right now*, and it is the one that
 * moves: not ready while starting, ready once the port is bound, not ready again the
 * instant shutdown begins. That last transition is what lets a load balancer stop sending
 * requests before the existing shutdown machinery closes the server underneath them.
 *
 * NO DEPENDENCY POLICY IS INVENTED HERE. Readiness reflects this process's own startup and
 * shutdown state and nothing else. The startup contract already requires the worker and the
 * secret check to complete *before* the port is bound, so a bound port already implies
 * them. Adding a database ping would be a new policy with real failure modes — a
 * slow query making a healthy process unready — and RH-4 is not the place to decide it.
 *
 * Both routes are unauthenticated by necessity, so they disclose exactly one field. See
 * the tests for why nothing else may be added to the body.
 */
import type { Express } from "express";

export type ReadinessState = {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
};

/** Starts not ready. Nothing should receive work before startup says so. */
export function createReadinessState(): ReadinessState {
  let ready = false;
  return {
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
    markNotReady: () => {
      ready = false;
    },
  };
}

/**
 * Register the operational probes.
 *
 * Call this early — before authentication, the tRPC mount and the static/Vite handlers —
 * so the probes answer during startup and are never subject to application authorization.
 * A readiness endpoint that requires a session cannot report that sessions are unavailable.
 */
export function registerHealthRoutes(app: Express, readiness: ReadinessState): void {
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", (_req, res) => {
    if (readiness.isReady()) {
      res.status(200).json({ status: "ready" });
      return;
    }
    // 503, not 200-with-a-flag: an orchestrator routes on the status code, and a body it
    // has to parse to discover the answer is a body that will eventually be ignored.
    res.status(503).json({ status: "not_ready" });
  });
}
