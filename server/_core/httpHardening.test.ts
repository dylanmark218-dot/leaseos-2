import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { allowedOriginsFromEnv, crossSiteGuard, rateLimit, securityHeaders, trustProxySetting } from "./httpHardening";

const servers: { close: () => void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(r => server.once("listening", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("securityHeaders", () => {
  it("sets the baseline headers and no framing ban unless asked", async () => {
    const app = express();
    app.use(securityHeaders({ hsts: true }));
    app.get("/", (_req, res) => { res.send("ok"); });
    const r = await fetch(await serve(app));
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("permissions-policy")).toContain("camera=(self)");
    expect(r.headers.get("permissions-policy")).toContain("geolocation=(self)");
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("content-security-policy")).toBeNull();
    // Plain http: HSTS would be ignored at best and a lock-out at worst.
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });

  it("sends HSTS only on a secure request, as judged through a trusted proxy", async () => {
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(securityHeaders({ hsts: true, frameAncestors: "'self' https://host.example" }));
    app.get("/", (_req, res) => { res.send("ok"); });
    const r = await fetch(await serve(app), { headers: { "x-forwarded-proto": "https" } });
    expect(r.headers.get("strict-transport-security")).toBe("max-age=15552000");
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://host.example");
  });
});

describe("crossSiteGuard", () => {
  const app = (allowedOrigins: string[] | null) => {
    const a = express();
    a.use("/api", crossSiteGuard({ allowedOrigins }));
    a.use(express.json());
    a.all("/api/x", (_req, res) => { res.json({ reached: true }); });
    return a;
  };

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])(
    "refuses a POST sent as %j — the types a cross-site page can send without a preflight",
    async ct => {
      const base = await serve(app(null));
      const r = await fetch(`${base}/api/x`, { method: "POST", body: "{}", headers: ct ? { "content-type": ct } : {} });
      expect(r.status).toBe(415);
    }
  );

  it("lets JSON mutations and all reads through", async () => {
    const base = await serve(app(null));
    expect((await fetch(`${base}/api/x`, { method: "POST", body: "{}", headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
    expect((await fetch(`${base}/api/x`)).status).toBe(200);
  });

  it("enforces the origin allowlist only when one is configured", async () => {
    const base = await serve(app(["https://app.example"]));
    const post = (origin?: string) => fetch(`${base}/api/x`, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } });
    expect((await post("https://app.example")).status).toBe(200);
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("null")).status).toBe(403);
    // No Origin: a server-to-server client, not a browser.
    expect((await post()).status).toBe(200);
  });

  it("parses the allowlist", () => {
    expect(allowedOriginsFromEnv({})).toBeNull();
    expect(allowedOriginsFromEnv({ LEASEOS_ALLOWED_ORIGINS: "https://a.example/, https://b.example" })).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("rateLimit", () => {
  it("allows max per window, refuses the next with Retry-After, and resets", async () => {
    let t = 0;
    const a = express();
    a.use(rateLimit({ windowMs: 60_000, max: 3, now: () => t }));
    a.get("/", (_req, res) => { res.send("ok"); });
    const base = await serve(a);
    for (let i = 0; i < 3; i++) expect((await fetch(base)).status).toBe(200);
    const refused = await fetch(base);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    t = 60_000;
    expect((await fetch(base)).status).toBe(200);
  });
});

describe("trustProxySetting", () => {
  it("maps the environment onto what Express accepts", () => {
    expect(trustProxySetting({})).toBeNull();
    expect(trustProxySetting({ LEASEOS_TRUST_PROXY: "1" })).toBe(1);
    expect(trustProxySetting({ LEASEOS_TRUST_PROXY: "true" })).toBe(true);
    expect(trustProxySetting({ LEASEOS_TRUST_PROXY: "loopback, 10.0.0.0/8" })).toBe("loopback, 10.0.0.0/8");
  });
});
