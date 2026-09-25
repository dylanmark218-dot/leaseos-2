/**
 * Which portal a session enters, and where a post-login redirect may go.
 *
 * Both are pure decisions over the server's own answers, so they are tested
 * here rather than in a browser — the same arrangement `portalViewModels.test.ts`
 * uses for the rest of the portal view-models.
 *
 * The rule under every case below: **a portal is presentation, never authority.**
 * `portals.mine` says which portals a session holds; nothing here may widen that
 * set, and every input that could try — a saved preference, a URL segment — is
 * checked against it rather than trusted. A stale `defaultWorkspace` row and a
 * hand-typed `/portal/executive` are the same class of input, and both fail
 * closed to the chooser.
 */
import { describe, expect, it } from "vitest";
import {
  isHeldPortal,
  resolvePortalEntry,
  safeReturnPath,
} from "../client/src/portal/entryModel";

const FIELD = "field_workforce";
const DISPATCH = "dispatch_operations";
const SAFETY = "safety_compliance";

describe("a session that holds no portal", () => {
  it("is offered nothing, rather than given something", () => {
    // The UX problem — a blank screen — is not solved by granting a portal.
    const entry = resolvePortalEntry({ held: [], notReached: [FIELD, DISPATCH] });
    expect(entry.kind).toBe("none");
    if (entry.kind !== "none") throw new Error("unreachable");
    expect(entry.notReached).toEqual([FIELD, DISPATCH]);
  });
});

describe("a session that holds exactly one portal", () => {
  it("enters it without a chooser", () => {
    expect(resolvePortalEntry({ held: [FIELD] })).toEqual({
      kind: "enter",
      portal: FIELD,
      because: "only_portal",
    });
  });

  it("enters it even when a stale default names a different portal", () => {
    // The default is a preference. It cannot promote a portal the session does
    // not hold, and it cannot override the only one it does.
    expect(resolvePortalEntry({ held: [FIELD], savedDefault: DISPATCH })).toEqual({
      kind: "enter",
      portal: FIELD,
      because: "only_portal",
    });
  });
});

describe("a session that holds several portals", () => {
  const held = [FIELD, DISPATCH, SAFETY];

  it("shows the chooser when there is no saved default", () => {
    const entry = resolvePortalEntry({ held });
    expect(entry).toEqual({ kind: "choose", options: held, rejectedDefault: null });
  });

  it("honours a saved default the session still holds", () => {
    expect(resolvePortalEntry({ held, savedDefault: SAFETY })).toEqual({
      kind: "enter",
      portal: SAFETY,
      because: "saved_default",
    });
  });

  it("refuses a saved default the session no longer holds, and says so", () => {
    // The role was revoked and the preference row outlived it. Honouring it
    // would put somebody in a portal their grants no longer compose.
    const entry = resolvePortalEntry({ held, savedDefault: "executive" });
    expect(entry).toEqual({ kind: "choose", options: held, rejectedDefault: "executive" });
  });

  it("refuses a saved default that is not a portal key at all", () => {
    // `defaultWorkspace` is a varchar. Anything at all can be in it.
    for (const junk of ["", "  ", "Field", "field-workspace", "../admin", "{}", "null"]) {
      const entry = resolvePortalEntry({ held, savedDefault: junk });
      expect(entry.kind, `${JSON.stringify(junk)} was accepted`).toBe("choose");
    }
  });
});

describe("a portal named in the URL", () => {
  const held = [FIELD, DISPATCH];

  it("is entered when the session holds it", () => {
    expect(resolvePortalEntry({ held, requested: DISPATCH })).toEqual({
      kind: "enter",
      portal: DISPATCH,
      because: "requested",
    });
  });

  it("never enters a portal the session does not hold", () => {
    // Typing /portal/executive is the client-side half of the attack. The
    // server half is portals.panelsFor, which refuses independently.
    const entry = resolvePortalEntry({ held, requested: "executive" });
    expect(entry.kind).toBe("choose");
    if (entry.kind !== "choose") throw new Error("unreachable");
    expect(entry.rejectedRequest).toBe("executive");
  });

  it("does not enter an unheld portal even when it is the saved default too", () => {
    const entry = resolvePortalEntry({
      held,
      requested: "executive",
      savedDefault: "executive",
    });
    expect(entry.kind).toBe("choose");
  });

  it("falls back to the single held portal rather than the unheld request", () => {
    expect(resolvePortalEntry({ held: [FIELD], requested: "executive" })).toMatchObject({
      kind: "enter",
      portal: FIELD,
      because: "only_portal",
    });
  });

  it("refuses an invented portal key", () => {
    for (const junk of ["admin", "ADMIN", "field_workforce ", "../executive", ""]) {
      expect(resolvePortalEntry({ held, requested: junk }).kind).toBe("choose");
    }
  });
});

describe("isHeldPortal", () => {
  it("requires both a canonical key and a held one", () => {
    expect(isHeldPortal(FIELD, [FIELD])).toBe(true);
    // Held but not canonical: the server would have to be returning junk, and
    // trusting it would make this function the weakest link rather than a check.
    expect(isHeldPortal("made_up", ["made_up"])).toBe(false);
    // Canonical but not held.
    expect(isHeldPortal("executive", [FIELD])).toBe(false);
    expect(isHeldPortal(null, [FIELD])).toBe(false);
    expect(isHeldPortal(undefined, [FIELD])).toBe(false);
  });
});

describe("where a post-login redirect may go", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeReturnPath("/portal/dispatch_operations")).toBe("/portal/dispatch_operations");
    expect(safeReturnPath("/comms/package?id=7")).toBe("/comms/package?id=7");
    expect(safeReturnPath("/jobs#top")).toBe("/jobs#top");
  });

  it("refuses another origin", () => {
    for (const hostile of [
      "https://evil.example/steal",
      "http://evil.example",
      "//evil.example/steal",
      "\\\\evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "  https://evil.example",
    ]) {
      expect(safeReturnPath(hostile), `${JSON.stringify(hostile)} was allowed`).toBe("/");
    }
  });

  it("refuses anything that is not a rooted path", () => {
    for (const bad of ["", "   ", "portal", "../admin", null, undefined]) {
      expect(safeReturnPath(bad)).toBe("/");
    }
  });

  it("refuses control characters used to smuggle a second header or URL", () => {
    expect(safeReturnPath("/portal\nLocation: https://evil.example")).toBe("/");
    expect(safeReturnPath("/portal\r\nSet-Cookie: x=1")).toBe("/");
    expect(safeReturnPath("/portal\u0000")).toBe("/");
  });

  it("is idempotent on what it returns", () => {
    // Whatever comes back must itself be acceptable, or a second pass through
    // a guard somewhere else could change the answer.
    for (const raw of ["/a", "https://evil.example", "//evil.example", "/b?c=1"]) {
      const once = safeReturnPath(raw);
      expect(safeReturnPath(once)).toBe(once);
    }
  });
});
