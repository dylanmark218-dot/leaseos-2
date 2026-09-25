/**
 * The webhook dispatcher's real transport refuses an internal destination.
 *
 * This file exists because every other webhook test injects a poster with `setWebhookPoster`,
 * so none of them ever runs the one that talks to the network — the delivery path could have
 * been a bare `fetch` to anywhere and the whole suite would have stayed green. It did: until
 * this change `defaultPoster` called `fetch` directly, and `integration.webhookSubscribe`
 * checked only that the URL began with `https://`.
 *
 * So these cases take the poster the module actually ships with, through
 * `currentWebhookPoster()`, and hand it the destinations an attacker would choose. Nothing
 * here reaches the network: every address below is refused before a socket is opened, which
 * is the property being pinned.
 */
import { describe, expect, it } from "vitest";
import { currentWebhookPoster } from "./webhookDispatchService";

const deliver = (url: string) =>
  currentWebhookPoster()(url, JSON.stringify({ event: "fixture" }), { "content-type": "application/json" });

/** The poster reports a refusal the same way it reports a dead endpoint: as this attempt's error. */
const refusalFrom = async (url: string) => {
  const r = await deliver(url);
  expect(r, `expected ${url} to be refused, got a status`).not.toHaveProperty("status");
  return (r as { error: string }).error;
};

describe("the shipped webhook transport", () => {
  it("refuses the cloud metadata endpoint", async () => {
    expect(await refusalFrom("https://169.254.169.254/latest/meta-data/iam/security-credentials/")).toMatch(/metadata/i);
  });

  it("refuses loopback, including the IPv6 and IPv4-mapped spellings that slip past a v4-only check", async () => {
    for (const url of ["https://127.0.0.1/admin", "https://[::1]/admin", "https://[::ffff:127.0.0.1]/admin"]) {
      expect(await refusalFrom(url), url).toMatch(/loopback/i);
    }
  });

  it("refuses private and link-local ranges — the database host is one of these", async () => {
    for (const url of ["https://10.0.0.7/", "https://172.16.0.5/", "https://192.168.1.4/", "https://169.254.0.9/"]) {
      expect(await refusalFrom(url), url).toMatch(/private|link-local/i);
    }
  });

  it("refuses plain http and a URL carrying credentials", async () => {
    expect(await refusalFrom("http://example.com/hook")).toMatch(/https/i);
    expect(await refusalFrom("https://user:pass@example.com/hook")).toMatch(/credential/i);
  });

  it("reports a refusal as an error rather than throwing, so the attempt is recorded and retried", async () => {
    // The dispatcher records `{ error }` against the attempt and retries on the schedule. A
    // throw here would escape into the send loop instead, where it is nobody's failure.
    await expect(deliver("https://127.0.0.1/admin")).resolves.toMatchObject({ error: expect.any(String) });
  });
});
