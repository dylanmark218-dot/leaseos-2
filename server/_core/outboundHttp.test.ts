import { describe, expect, it } from "vitest";
import { allowedHostsFromEnv, forbiddenAddressReason, guardedLookup, outboundRequest, OutboundRefused, validateOutboundUrl } from "./outboundHttp";

const fakeResolver = (answers: Record<string, string[]>) => (hostname: string, cb: (err: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) => {
  const list = answers[hostname];
  if (!list) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), []);
  cb(null, list.map(address => ({ address, family: address.includes(":") ? 6 : 4 })));
};

describe("forbiddenAddressReason", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", // IPv4-mapped
    "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
    "2002:7f00:1::", // 6to4 of 127.0.0.1
  ])("refuses %s", addr => {
    expect(forbiddenAddressReason(addr)).not.toBeNull();
  });

  it.each(["8.8.8.8", "142.250.72.14", "172.32.0.1", "2607:f8b0:4004:800::200e"])("allows public %s", addr => {
    expect(forbiddenAddressReason(addr)).toBeNull();
  });
});

describe("validateOutboundUrl", () => {
  const ok = (u: string) => validateOutboundUrl(u, { allowedHosts: null });
  const refused = (u: string, allowedHosts: string[] | null = null) => expect(() => validateOutboundUrl(u, { allowedHosts })).toThrow(OutboundRefused);

  it("accepts a public https URL", () => {
    expect(ok("https://gis.saskatchewan.ca/egis/rest/services/x/FeatureServer/17").hostname).toBe("gis.saskatchewan.ca");
    expect(ok("https://erp.example:443/hook").hostname).toBe("erp.example");
  });

  it("refuses non-https, other ports, and credentials", () => {
    refused("http://erp.example/hook");
    refused("ftp://erp.example/");
    refused("file:///etc/passwd");
    refused("https://erp.example:8443/hook");
    refused("https://user:pw@erp.example/hook");
    refused("not a url");
  });

  it("refuses literal private and metadata addresses in every spelling", () => {
    refused("https://127.0.0.1/");
    refused("https://169.254.169.254/latest/meta-data/");
    refused("https://[::1]/");
    refused("https://[::ffff:127.0.0.1]/");
    refused("https://2130706433/"); // decimal 127.0.0.1; WHATWG URL normalises it
    refused("https://0x7f.1/"); // hex 127.0.0.1
    refused("https://localhost/");
    refused("https://api.localhost/");
  });

  it("narrows to the allowlist, including subdomains, and never widens", () => {
    expect(validateOutboundUrl("https://gis.saskatchewan.ca/x", { allowedHosts: ["saskatchewan.ca"] }).hostname).toBe("gis.saskatchewan.ca");
    refused("https://evil.example/x", ["saskatchewan.ca"]);
    refused("https://notsaskatchewan.ca/x", ["saskatchewan.ca"]);
    refused("https://127.0.0.1/", ["127.0.0.1"]);
  });

  it("reads the allowlist from the environment", () => {
    expect(allowedHostsFromEnv({})).toBeNull();
    expect(allowedHostsFromEnv({ LEASEOS_OUTBOUND_ALLOWED_HOSTS: " A.example , *.b.example ," })).toEqual(["a.example", "b.example"]);
  });
});

describe("guardedLookup — the check is the connect", () => {
  const run = (resolver: ReturnType<typeof fakeResolver>, host: string, all = false) =>
    new Promise<{ err: unknown; result: unknown }>(resolve => {
      const lookup = guardedLookup(resolver) as unknown as (h: string, o: object, cb: (err: unknown, a?: unknown) => void) => void;
      lookup(host, { all }, (err, a) => resolve({ err, result: a }));
    });

  it("passes a public answer through", async () => {
    const { err, result } = await run(fakeResolver({ "erp.example": ["93.184.215.14"] }), "erp.example");
    expect(err).toBeNull();
    expect(result).toBe("93.184.215.14");
  });

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    const { err } = await run(fakeResolver({ "rebind.example": ["10.0.0.5"] }), "rebind.example");
    expect(err).toBeInstanceOf(OutboundRefused);
  });

  it("refuses when ANY answer is private, so round-robin cannot slip one through", async () => {
    const { err } = await run(fakeResolver({ "mixed.example": ["93.184.215.14", "169.254.169.254"] }), "mixed.example", true);
    expect(err).toBeInstanceOf(OutboundRefused);
  });

  it("passes resolver errors through unchanged", async () => {
    const { err } = await run(fakeResolver({}), "nowhere.example");
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("outboundRequest", () => {
  it("refuses a literal loopback before any socket opens", async () => {
    await expect(outboundRequest({ url: "https://127.0.0.1/", allowedHosts: null })).rejects.toBeInstanceOf(OutboundRefused);
  });

  it("refuses a hostname that resolves to a metadata address at connect time", async () => {
    await expect(
      outboundRequest({ url: "https://metadata.example/latest", allowedHosts: null, resolver: fakeResolver({ "metadata.example": ["169.254.169.254"] }) })
    ).rejects.toBeInstanceOf(OutboundRefused);
  });

  it("refuses a hostname that resolves to loopback", async () => {
    await expect(
      outboundRequest({ url: "https://sneaky.example/", method: "POST", body: "{}", allowedHosts: null, resolver: fakeResolver({ "sneaky.example": ["::1"] }) })
    ).rejects.toBeInstanceOf(OutboundRefused);
  });
});
