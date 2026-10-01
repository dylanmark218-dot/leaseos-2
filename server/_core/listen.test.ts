/**
 * RH-4 — the port a deployment configured is the port it gets, or it does not start.
 *
 * `index.ts` searched for a free port: if 3000 was busy it quietly took 3001 and logged a
 * line. On a laptop that is a convenience. Under an orchestrator it is a crash loop that
 * reports itself as healthy — the container binds a port nothing routes to, the readiness
 * probe on the configured port never answers, the supervisor restarts it, and the log line
 * explaining why scrolls past in a stream nobody is reading during an incident.
 *
 * The second defect is quieter. `server.listen()` reports a bind failure through the
 * server's `error` event, not by throwing, so the `await` around it never rejected and the
 * existing `startServer().catch` — which exists precisely to exit non-zero — could not see
 * it. A failure to bind was unobservable to the supervisor.
 *
 * These pin both. The development fallback is kept deliberately, because there it really
 * is a convenience and nothing routes to a developer's port.
 */
import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { findAvailablePort, listenOnPort, resolveListenPort } from "./listen";

const open: Server[] = [];

/** A real listening server on a real ephemeral port. */
async function listening(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  open.push(server);
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))
  );
});

describe("P1 — production binds what it was told, and never goes looking", () => {
  it("returns the preferred port without consulting the finder", async () => {
    let consulted = false;
    const finder = async () => {
      consulted = true;
      return 3001;
    };

    const port = await resolveListenPort(3000, false, finder);

    expect(port).toBe(3000);
    expect(consulted, "a production process must not silently move to another port").toBe(false);
  });

  it("holds for any configured port, not just 3000", async () => {
    const finder = async () => 9999;
    expect(await resolveListenPort(8080, false, finder)).toBe(8080);
    expect(await resolveListenPort(80, false, finder)).toBe(80);
  });
});

describe("P2 — development keeps the fallback", () => {
  it("asks the finder, starting from the preferred port", async () => {
    const asked: number[] = [];
    const finder = async (start: number) => {
      asked.push(start);
      return 3002;
    };

    const port = await resolveListenPort(3000, true, finder);

    expect(port).toBe(3002);
    expect(asked).toEqual([3000]);
  });
});

describe("P3 — a bind collision rejects rather than vanishing", () => {
  /*
   * The whole point. `server.listen()` emits `error`; it does not throw. Before this,
   * awaiting the surrounding function caught nothing and the process carried on with no
   * server and a zero exit code.
   */
  it("rejects with EADDRINUSE when the port is taken", async () => {
    const { port } = await listening();

    const second = createServer();
    open.push(second);

    await expect(listenOnPort(second, port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("the rejection is reachable by an ordinary try/catch", async () => {
    const { port } = await listening();
    const second = createServer();
    open.push(second);

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await listenOnPort(second, port);
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught, "startServer().catch can only exit non-zero if the error arrives here").not.toBeNull();
    expect(caught!.code).toBe("EADDRINUSE");
  });
});

describe("P4 — a successful bind resolves once, after listening", () => {
  it("resolves only when the server is actually listening", async () => {
    const server = createServer();
    open.push(server);

    await listenOnPort(server, 0);

    expect(server.listening, "resolving before `listening` would let readiness lie").toBe(true);
  });

  it("leaves no startup listener behind once it has resolved", async () => {
    const server = createServer();
    open.push(server);

    /*
     * Measured against this server's own baseline, not against zero: `http.createServer()`
     * already carries an internal `listening` listener before anything here runs, so
     * asserting zero would be asserting something untrue of a fresh server. What must hold
     * is that `listenOnPort` adds nothing permanent.
     *
     * It matters because a leftover `error` listener would hand a later runtime error to
     * an already-settled promise — silently dropped, instead of reaching whatever the
     * application installs for it.
     */
    const base = {
      error: server.listenerCount("error"),
      listening: server.listenerCount("listening"),
    };

    await listenOnPort(server, 0);

    expect(server.listenerCount("error")).toBe(base.error);
    expect(server.listenerCount("listening")).toBe(base.listening);
  });

  it("leaves no startup listener behind after a failure either", async () => {
    const { port } = await listening();
    const second = createServer();
    open.push(second);

    const base = {
      error: second.listenerCount("error"),
      listening: second.listenerCount("listening"),
    };

    await expect(listenOnPort(second, port)).rejects.toBeTruthy();

    expect(second.listenerCount("error")).toBe(base.error);
    expect(second.listenerCount("listening")).toBe(base.listening);
  });
});

describe("findAvailablePort — the development-only search, unchanged in behaviour", () => {
  it("returns the starting port when it is free", async () => {
    const { server, port } = await listening();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await findAvailablePort(port)).toBe(port);
  });

  it("steps past a port that is taken", async () => {
    const { port } = await listening();
    const found = await findAvailablePort(port);
    expect(found).toBeGreaterThan(port);
  });
});
