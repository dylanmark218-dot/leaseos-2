import { describe, expect, it } from "vitest";
import {
  addressRefusal, checkEgressUrl, EgressRefused, guardedGet, hostNameRefusal,
  type EgressLimits, type EgressTransport, type ResolvedAddress, type TransportResponse,
} from "./egressGuard";

const LIMITS: EgressLimits = { timeoutMs: 1_000, maxBytes: 1024, maxRedirects: 3, accept: "application/json", contentTypes: ["application/json", "text/plain"] };
/** Stands for any public address; nothing here connects to it. */
const PUBLIC = "142.165.1.1";
const LAYER = "https://gis.example.ca/arcgis/rest/services/Petroleum/FeatureServer/17?f=pjson";

/** A DNS that knows only what the test tells it, and remembers what it was asked. */
function dns(table: Record<string, string[] | "hang">) {
  const asked: string[] = [];
  const resolve = (host: string): Promise<ResolvedAddress[]> => {
    asked.push(host);
    const answers = table[host];
    if (answers === "hang") return new Promise(() => undefined);
    if (!answers) return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
    return Promise.resolve(answers.map(address => ({ address, family: address.includes(":") ? 6 as const : 4 as const })));
  };
  return { resolve, asked };
}

type Reply = { status?: number; headers?: Record<string, string>; chunks?: string[]; body?: AsyncIterable<Uint8Array> } | "hang" | Error;

/** One reply per URL; every request sent is recorded, and every close counted. */
function web(routes: Record<string, Reply>) {
  const sent: { url: string; addresses: string[]; headers: Record<string, string> }[] = [];
  let closed = 0;
  const transport: EgressTransport = {
    async get({ url, addresses, headers }) {
      sent.push({ url: url.href, addresses: addresses.map(a => a.address), headers });
      const reply = routes[url.href];
      if (reply === undefined) throw new Error(`no route for ${url.href}`);
      if (reply === "hang") return new Promise<TransportResponse>(() => undefined);
      if (reply instanceof Error) throw reply;
      const chunks = reply.chunks ?? ["{}"];
      const body = reply.body ?? (async function* () { for (const c of chunks) yield new TextEncoder().encode(c); })();
      return { status: reply.status ?? 200, headers: reply.headers ?? { "content-type": "application/json" }, body, close: () => { closed++; } };
    },
  };
  return { transport, sent, closed: () => closed };
}

/** A body whose first chunk arrives and whose second never does. */
const stalled = (): AsyncIterable<Uint8Array> => {
  let first = true;
  return { [Symbol.asyncIterator]: () => ({ next: () => (first ? (first = false, Promise.resolve({ done: false, value: new Uint8Array(8) })) : new Promise(() => undefined)) }) };
};

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e, "expected a refusal").toBeInstanceOf(EgressRefused);
  return e as EgressRefused;
};

describe("addresses", () => {
  it.each([
    ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["::1", "loopback"],
    ["10.0.0.1", "private network (10/8)"], ["172.16.0.1", "private network (172.16/12)"], ["172.31.255.255", "private network (172.16/12)"], ["192.168.1.1", "private network (192.168/16)"],
    ["169.254.169.254", "cloud metadata endpoint"], ["169.254.1.1", "link-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"],
    ["fc00::1", "unique-local"], ["fdff:ffff::1", "unique-local"], ["fd00:ec2::254", "cloud metadata endpoint"], ["100.100.100.200", "cloud metadata endpoint"],
    ["0.0.0.0", "this network"], ["0.1.2.3", "this network"], ["::", "unspecified"],
    ["100.64.0.1", "shared address space"], ["224.0.0.1", "multicast"], ["255.255.255.255", "reserved"], ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"], ["::ffff:a9fe:a9fe", "cloud metadata endpoint, IPv4-mapped"], ["64:ff9b::a9fe:a9fe", "cloud metadata endpoint, NAT64"],
    ["2001:db8::1", "documentation"], ["2001:0:4136:e378::1", "Teredo"], ["2002:7f00:1::1", "6to4"],
    ["fe80::1%eth0", "link-local"], ["010.0.0.1", "not an IP address"], ["1.2.3.256", "not an IP address"], ["::1::2", "not an IP address"], ["gis.example.ca", "not an IP address"],
  ])("refuses %s (%s)", (address, why) => {
    expect(addressRefusal(address)).toContain(why);
  });

  it.each(["8.8.8.8", PUBLIC, "172.15.255.255", "172.32.0.1", "11.0.0.1", "100.63.255.255", "100.128.0.1", "169.253.255.255", "192.169.0.1", "223.255.255.255",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"])("lets the public address %s through", address => {
    expect(addressRefusal(address)).toBeNull();
  });
});

describe("the URL, before any lookup", () => {
  it.each(["http://gis.saskatchewan.ca/egis/rest/services/Economy/Petroleum/FeatureServer/17", "ftp://gis.example.ca/", "file:///etc/passwd", "gopher://gis.example.ca/", "ws://gis.example.ca/", "data:text/plain,hi", "javascript:alert(1)"])(
    "refuses %s: https only", url => {
      expect(() => checkEgressUrl(url)).toThrow(expect.objectContaining({ code: "scheme" }));
    });

  it.each([
    "https://10.0.0.1/", "https://172.16.0.1/", "https://192.168.1.1/", "https://127.0.0.1:8443/", "https://0.0.0.0/", "https://100.100.100.200/",
    "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://[fe80::1]/", "https://[fc00::1]/", "https://[fd00:ec2::254]/", "https://[::]/",
    "https://[::ffff:127.0.0.1]/", "https://[::ffff:169.254.169.254]/", "https://[64:ff9b::169.254.169.254]/",
    // The URL parser normalises these to 127.0.0.1 before the guard sees them.
    "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/",
  ])("refuses the private or special address literal %s", url => {
    expect(() => checkEgressUrl(url)).toThrow(expect.objectContaining({ code: "blocked_address", destination: true }));
  });

  it("names the metadata endpoint when that is what was asked for", () => {
    expect(() => checkEgressUrl("https://169.254.169.254/latest/meta-data/iam/security-credentials/")).toThrow(/cloud metadata endpoint/);
  });

  it.each(["https://localhost/", "https://localhost./", "https://api.localhost/", "https://metadata.google.internal/computeMetadata/v1/", "https://printer.local/", "https://router.home.arpa/", "https://intranet/"])(
    "refuses %s by name, without looking it up", url => {
      expect(() => checkEgressUrl(url)).toThrow(expect.objectContaining({ code: "blocked_host" }));
    });

  it("refuses credentials in the URL, and a string that is not a URL", () => {
    expect(() => checkEgressUrl("https://reviewer:hunter2@gis.example.ca/")).toThrow(expect.objectContaining({ code: "credentials_in_url" }));
    expect(() => checkEgressUrl("gis.example.ca/FeatureServer/17")).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });

  it("accepts a public https URL, on any port, and hands back a copy", () => {
    const given = new URL("https://gis.saskatchewan.ca:6443/egis/rest/services/Economy/Petroleum/FeatureServer/17");
    const checked = checkEgressUrl(given);
    expect(checked.href).toBe(given.href);
    expect(checked).not.toBe(given);
    expect(hostNameRefusal("gis.saskatchewan.ca")).toBeNull();
  });
});

describe("a guarded GET", () => {
  it("fetches a public https URL once, from the addresses it checked, with three fixed headers and no cookie or credential", async () => {
    const d = dns({ "gis.example.ca": [PUBLIC] });
    const w = web({ [LAYER]: { headers: { "content-type": "text/plain; charset=UTF-8" }, chunks: ['{"name":"Facil', 'ities","fields":[]}'] } });
    const res = await guardedGet(LAYER, { resolve: d.resolve, transport: w.transport }, LIMITS);
    expect(res).toMatchObject({ ok: true, status: 200, url: LAYER, hops: [LAYER], contentType: "text/plain; charset=UTF-8" });
    expect(res.json()).toEqual({ name: "Facilities", fields: [] });
    expect(d.asked).toEqual(["gis.example.ca"]);
    expect(w.sent).toEqual([{ url: LAYER, addresses: [PUBLIC], headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "LeaseOS" } }]);
    expect(w.closed()).toBe(1);
  });

  it("hands the transport every checked answer for a name, IPv4 and IPv6, and nothing else", async () => {
    const w = web({ [LAYER]: {} });
    await guardedGet(LAYER, { resolve: dns({ "gis.example.ca": ["2606:4700:78::90:0:40", PUBLIC] }).resolve, transport: w.transport }, LIMITS);
    expect(w.sent[0]!.addresses).toEqual(["2606:4700:78::90:0:40", PUBLIC]);
  });

  it("refuses a host name that resolves to a private address, and sends nothing", async () => {
    const w = web({});
    const e = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": ["10.0.0.7"] }).resolve, transport: w.transport }, LIMITS));
    expect(e).toMatchObject({ code: "blocked_address", destination: true });
    expect(e.message).not.toContain("10.0.0.7");
    expect(w.sent).toEqual([]);
  });

  it.each([[[PUBLIC, "127.0.0.1"]], [["::ffff:169.254.169.254"]], [["fd00:ec2::254"]]])("refuses a name that answers %j", async answers => {
    const w = web({});
    const e = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": answers }).resolve, transport: w.transport }, LIMITS));
    expect(e.code).toBe("blocked_address");
    expect(w.sent).toEqual([]);
  });

  it("says the same thing for a name that does not resolve as for one that resolves inside", async () => {
    const w = web({});
    const missing = await refusal(guardedGet(LAYER, { resolve: dns({}).resolve, transport: w.transport }, LIMITS));
    const inside = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": ["192.168.0.10"] }).resolve, transport: w.transport }, LIMITS));
    expect(missing.code).toBe("unresolvable");
    expect(missing.message).toBe(inside.message);
    expect(w.sent).toEqual([]);
  });

  it.each([
    ["an https redirect", "https://169.254.169.254/latest/meta-data/iam/security-credentials/", "blocked_address"],
    ["an http redirect", "http://169.254.169.254/latest/meta-data/", "scheme"],
    ["an IPv4-mapped redirect", "https://[::ffff:a9fe:a9fe]/latest/meta-data/", "blocked_address"],
  ])("refuses %s to 169.254.169.254, and never contacts it", async (_label, location, code) => {
    const d = dns({ "gis.example.ca": [PUBLIC] });
    const w = web({ [LAYER]: { status: 302, headers: { location } } });
    const e = await refusal(guardedGet(LAYER, { resolve: d.resolve, transport: w.transport }, LIMITS));
    expect(e.code).toBe(code);
    expect(w.sent.map(s => s.url)).toEqual([LAYER]);
    expect(w.closed()).toBe(1);
  });

  it("looks a redirect's host up again, and refuses one that resolves to the metadata endpoint", async () => {
    const d = dns({ "gis.example.ca": [PUBLIC], "cdn.attacker.example": ["169.254.169.254"] });
    const w = web({ [LAYER]: { status: 301, headers: { location: "https://cdn.attacker.example/latest/meta-data/" } } });
    const e = await refusal(guardedGet(LAYER, { resolve: d.resolve, transport: w.transport }, LIMITS));
    expect(e.code).toBe("blocked_address");
    expect(d.asked).toEqual(["gis.example.ca", "cdn.attacker.example"]);
    expect(w.sent).toHaveLength(1);
  });

  it("follows a relative redirect and checks the new hop from the start", async () => {
    const moved = "https://gis.example.ca/arcgis/rest/services/Petroleum/v2/FeatureServer/17?f=pjson";
    const d = dns({ "gis.example.ca": [PUBLIC] });
    const w = web({ [LAYER]: { status: 308, headers: { location: "/arcgis/rest/services/Petroleum/v2/FeatureServer/17?f=pjson" } }, [moved]: { chunks: ['{"name":"v2"}'] } });
    const res = await guardedGet(LAYER, { resolve: d.resolve, transport: w.transport }, LIMITS);
    expect(res).toMatchObject({ ok: true, url: moved, hops: [LAYER, moved] });
    expect(d.asked).toEqual(["gis.example.ca", "gis.example.ca"]);
    expect(w.closed()).toBe(2);
  });

  it("stops after the redirect limit", async () => {
    const hop = (n: number) => `https://gis.example.ca/${n}`;
    const w = web(Object.fromEntries([0, 1, 2, 3, 4].map(n => [hop(n), { status: 302, headers: { location: hop(n + 1) } }])));
    const e = await refusal(guardedGet(hop(0), { resolve: dns({ "gis.example.ca": [PUBLIC] }).resolve, transport: w.transport }, LIMITS));
    expect(e).toMatchObject({ code: "too_many_redirects", destination: false });
    expect(w.sent).toHaveLength(LIMITS.maxRedirects + 1);
  });

  it("refuses a body declared over the size limit without reading it", async () => {
    const w = web({ [LAYER]: { headers: { "content-type": "application/json", "content-length": "4096" }, body: stalled() } });
    const e = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": [PUBLIC] }).resolve, transport: w.transport }, LIMITS));
    expect(e.code).toBe("too_large");
    expect(w.closed()).toBe(1);
  });

  it("refuses a streamed body at the size limit rather than after it", async () => {
    const w = web({ [LAYER]: { chunks: ["a".repeat(600), "b".repeat(600), "c".repeat(600)] } });
    const e = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": [PUBLIC] }).resolve, transport: w.transport }, LIMITS));
    expect(e).toMatchObject({ code: "too_large", destination: false });
    expect(w.closed()).toBe(1);
  });

  it.each([
    ["a lookup that never answers", { "gis.example.ca": "hang" as const }, {}],
    ["a server that never answers", { "gis.example.ca": [PUBLIC] }, { [LAYER]: "hang" as const }],
    ["a body that never finishes", { "gis.example.ca": [PUBLIC] }, { [LAYER]: { body: stalled() } }],
  ])("gives up on %s at the deadline", async (_label, table, routes) => {
    const started = Date.now();
    const e = await refusal(guardedGet(LAYER, { resolve: dns(table).resolve, transport: web(routes).transport }, { ...LIMITS, timeoutMs: 50 }));
    expect(e).toMatchObject({ code: "timeout", destination: false });
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("refuses a content type it was not asked to accept, and a compressed body", async () => {
    const d = dns({ "gis.example.ca": [PUBLIC] });
    const html = web({ [LAYER]: { headers: { "content-type": "text/html; charset=utf-8" } } });
    expect((await refusal(guardedGet(LAYER, { resolve: d.resolve, transport: html.transport }, LIMITS))).code).toBe("content_type");
    const none = web({ [LAYER]: { headers: {} } });
    expect((await refusal(guardedGet(LAYER, { resolve: d.resolve, transport: none.transport }, LIMITS))).code).toBe("content_type");
    const gzip = web({ [LAYER]: { headers: { "content-type": "application/json", "content-encoding": "gzip" } } });
    expect((await refusal(guardedGet(LAYER, { resolve: d.resolve, transport: gzip.transport }, LIMITS))).code).toBe("content_encoding");
  });

  it("returns a non-2xx answer with its body unread and its connection closed", async () => {
    const w = web({ [LAYER]: { status: 404, headers: { "content-type": "text/html" }, body: stalled() } });
    const res = await guardedGet(LAYER, { resolve: dns({ "gis.example.ca": [PUBLIC] }).resolve, transport: w.transport }, LIMITS);
    expect(res).toMatchObject({ ok: false, status: 404 });
    expect(res.bytes).toHaveLength(0);
    expect(w.closed()).toBe(1);
  });

  it("reports a failed connection as a refusal of the answer, not of the destination", async () => {
    const w = web({ [LAYER]: new Error(`connect ECONNREFUSED ${PUBLIC}:443`) });
    const e = await refusal(guardedGet(LAYER, { resolve: dns({ "gis.example.ca": [PUBLIC] }).resolve, transport: w.transport }, LIMITS));
    expect(e).toMatchObject({ code: "transport", destination: false });
    expect(e.message).toContain("gis.example.ca");
  });
});
