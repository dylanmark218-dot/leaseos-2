/**
 * RH-4 — liveness and readiness, kept apart on purpose.
 *
 * The server had neither. A probe could only do a bare TCP check, which cannot tell
 * "still booting" from "bound the wrong port" from "wedged" — the three states an
 * orchestrator most needs to distinguish.
 *
 * `/healthz` answers *is this process alive*. It touches nothing: no database, no worker,
 * no provider. That is not laziness — a liveness probe that consults a dependency turns a
 * database blip into a mass restart of healthy application processes, which is how a brief
 * outage becomes a long one.
 *
 * `/readyz` answers *should this process be sent work right now*, and it is the one that
 * moves: false while starting, true once bound, false again the moment shutdown begins.
 *
 * Driven against a real Express app over a real socket rather than a mocked
 * request/response, because the status code and the exact body are the contract an
 * orchestrator reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadinessState, registerHealthRoutes } from "./health";

const open: Server[] = [];

async function serve(readiness = createReadinessState()) {
  const app = express();
  registerHealthRoutes(app, readiness);
  const server = createServer(app);
  open.push(server);
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;

  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: await response.json() };
  };

  return { readiness, get };
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))
  );
});

describe("H1/H2 — before startup completes, alive is not the same as ready", () => {
  it("H1. /healthz answers 200 even though readiness has not been marked", async () => {
    const { get } = await serve();
    expect(await get("/healthz")).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("H2. /readyz answers 503 until startup completes", async () => {
    const { get } = await serve();
    expect(await get("/readyz")).toEqual({ status: 503, body: { status: "not_ready" } });
  });
});

describe("H3/H4 — readiness follows the process lifecycle", () => {
  it("H3. becomes ready once marked", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();
    expect(await get("/readyz")).toEqual({ status: 200, body: { status: "ready" } });
  });

  it("H4. becomes unready again when shutdown begins", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();
    readiness.markNotReady();

    expect(await get("/readyz")).toEqual({ status: 503, body: { status: "not_ready" } });
  });

  it("stays alive while unready — a draining process is not a dead one", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();
    readiness.markNotReady();

    expect((await get("/healthz")).status, "marking unready must not trip the liveness probe into a restart").toBe(200);
  });

  it("the state object reports what the endpoint reports", () => {
    const readiness = createReadinessState();
    expect(readiness.isReady()).toBe(false);
    readiness.markReady();
    expect(readiness.isReady()).toBe(true);
    readiness.markNotReady();
    expect(readiness.isReady()).toBe(false);
  });
});

describe("H5 — the responses carry a status and nothing else", () => {
  /*
   * Health endpoints are usually the most exposed routes a service has: unauthenticated by
   * necessity, and often reachable from further away than intended. Anything they disclose
   * is disclosed to whoever can reach them.
   */
  it("returns exactly one field", async () => {
    const { get, readiness } = await serve();
    expect(Object.keys((await get("/healthz")).body)).toEqual(["status"]);
    expect(Object.keys((await get("/readyz")).body)).toEqual(["status"]);
    readiness.markReady();
    expect(Object.keys((await get("/readyz")).body)).toEqual(["status"]);
  });

  it("leaks no configuration, secret, identifier or stack trace", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();

    const bodies = [
      JSON.stringify((await get("/healthz")).body),
      JSON.stringify((await get("/readyz")).body),
    ].join(" ");

    for (const forbidden of [
      "DATABASE_URL", "mysql://", "JWT_SECRET", "OAUTH", "secret", "token",
      "worker", "at ", "Error", "node_modules", "password", "appId",
    ]) {
      expect(bodies.toLowerCase(), `health output must not mention ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });

  it("says nothing different about why it is not ready", async () => {
    // A probe gets a yes or a no. Explaining the reason to an unauthenticated caller
    // describes the system's internal state to anyone who can reach the port.
    const { get } = await serve();
    expect((await get("/readyz")).body).toEqual({ status: "not_ready" });
  });
});

describe("H6 — the probes need no credentials", () => {
  it("answers with no cookie, no bearer token and no session", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();

    expect((await get("/healthz")).status).toBe(200);
    expect((await get("/readyz")).status).toBe(200);
  });

  it("ignores a credential if one is sent, rather than validating it", async () => {
    const { get, readiness } = await serve();
    readiness.markReady();

    const withJunk = { headers: { authorization: "Bearer not-a-real-token", cookie: "app_session_id=nonsense" } };
    expect((await get("/healthz", withJunk)).status).toBe(200);
    expect((await get("/readyz", withJunk)).status).toBe(200);
  });
});
