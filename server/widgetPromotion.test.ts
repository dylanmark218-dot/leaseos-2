/**
 * P0.5 step 6 — every registered widget is resolved on purpose.
 *
 * The reader had a `default:` arm that answered "not promoted on this branch yet ... no reader has
 * been written for it". For eleven widgets that message was already stale, and for the twelfth it
 * was misleading: `syncStatus` is device-local by the registry's own offline classification, so the
 * right answer is not a server reader — it is the server saying it has no view of the device's
 * queue. A widget must now be handled deliberately: a real read, on demand, or device-local.
 *
 * This reads the reader's source. What each read returns is the business of widgetSources' own
 * suites; this only holds that nothing falls through unnoticed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WIDGET_DEFINITIONS } from "./_core/widgetRegistry";

const source = readFileSync("server/widgetSources.ts", "utf8");
const keys = Object.keys(WIDGET_DEFINITIONS).sort();

/** Handled deliberately, and how. Every registered key must appear here. */
const ON_DEMAND = ["search", "trackingLookup"];
const DEVICE_LOCAL = ["syncStatus"];

describe("every registered widget is resolved on purpose", () => {
  it("registers twelve widgets, the count the reconciliation matrix resolved", () => {
    expect(keys.length).toBe(12);
  });

  it("gives each one a branch in the reader, so none reaches the default arm", () => {
    const unhandled = keys.filter(k => !new RegExp(`case "${k}":`).test(source));
    expect(unhandled, "a registered widget with no branch in widgetSources — it would answer 'not promoted'").toEqual([]);
  });

  it("keeps the default arm as a fault for an unregistered key, not as a resting place", () => {
    expect(source).toContain("default:");
    expect(source).toMatch(/NOT_PROMOTED/);
    // The message must not claim a reader is owed when one is not: that is what sent the last
    // reader looking for a sync procedure to write.
    const deviceBranch = source.slice(source.indexOf('case "syncStatus":'), source.indexOf("default:"));
    expect(deviceBranch).toMatch(/on this device/);
    expect(deviceBranch).not.toMatch(/not promoted|no reader has been written/);
  });

  it("answers the device-local widget without inventing a server-side number", () => {
    for (const k of DEVICE_LOCAL) {
      expect(WIDGET_DEFINITIONS[k as keyof typeof WIDGET_DEFINITIONS].offline.kind, `${k} must be classified device_local in the registry`).toBe("device_local");
      const branch = source.slice(source.indexOf(`case "${k}":`), source.indexOf("default:"));
      expect(branch).toMatch(/state: "unknown"/);      // unknown, never failed: nothing failed
      expect(branch).not.toMatch(/counts|queueDepth|pending:/);   // no borrowed count
    }
  });

  it("answers the on-demand widgets with what the person must do, not with an empty result", () => {
    for (const k of ON_DEMAND) expect(source).toMatch(new RegExp(`case "${k}":`));
    const branch = source.slice(source.indexOf('case "search":'), source.indexOf('case "syncStatus":'));
    expect(branch).toMatch(/state: "unknown"/);
    expect(branch).toMatch(/type a query|tracking number/);
  });
});
