/**
 * C1b-3 — one document-validity decision, and a census that keeps it that way.
 *
 * Numbered cases are the owner's required list (document validity 1–10; source census, Part N).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimValidity, complianceDocumentValidity, governingClaim } from "./_core/complianceDocumentValidity";
import { evaluateRequirement } from "./_core/compliancePassport";
import { credentialBlocker } from "./_core/dispatchReadiness";
import { readExpiry, validityOf, type DocumentVersion } from "./_core/documentValidity";
import { credentialState } from "./readinessComposer";
import { expiryState } from "./widgetSources";

const AT = new Date("2026-10-15T12:00:00Z");
const D = 86_400_000;
const at = (ms: number) => new Date(AT.getTime() + ms);
const claim = (expiresAt: Date | null, verificationStatus: "verified" | "needs_review" | "rejected" = "verified") =>
  ({ docType: "d", expiresAt, verificationStatus });
const read = (f: string) => readFileSync(path.resolve(__dirname, f), "utf8");

describe("the canonical decision", () => {
  it("2/4. future is current, past is expired, and the days are whole days", () => {
    expect(readExpiry(at(400 * D), AT, 30)).toEqual({ expiry: "current", daysRemaining: 400 });
    expect(readExpiry(at(-10 * D), AT, 30)).toEqual({ expiry: "expired", daysRemaining: -10 });
    expect(readExpiry(at(30.5 * D), AT, 30)).toEqual({ expiry: "expiring", daysRemaining: 30 });
    expect(claimValidity([claim(at(400 * D))], AT).state).toBe("in_force");
    expect(claimValidity([claim(at(-10 * D))], AT).state).toBe("expired");
  });

  it("3. the exact boundary is deterministic: in force at the instant, expired one millisecond later", () => {
    expect(readExpiry(AT, AT, 30).expiry).toBe("expiring");
    expect(readExpiry(AT, AT, 0).expiry).toBe("current");
    expect(readExpiry(at(-1), AT, 30).expiry).toBe("expired");
    expect(readExpiry(at(1000), AT, 0).expiry).toBe("current");
    // A warning window of zero or less never warns.
    expect(readExpiry(at(3600_000), AT, 0).expiry).toBe("current");
  });

  it("5. a missing expiry is reported as such; each caller's policy for it stays its own", () => {
    expect(readExpiry(null, AT, 30)).toEqual({ expiry: "no_expiry", daysRemaining: null });
    expect(claimValidity([claim(null)], AT).state).toBe("in_force");
    // Dispatch: expiry unknown. Passport: satisfied. Tile: current. (Unchanged by C1b-3.)
    expect(credentialBlocker(credentialState([claim(null) as never], ["d"], "Doc", AT), AT, "operator", "doc")?.code).toBe("doc_unknown");
    expect(expiryState({ id: 1, ownerType: "operator", ownerId: 1, docType: "d", title: "t", expiresAt: null, verificationStatus: "verified" }, AT, 30)).toBe("current");
  });

  it("6. an unverified document is unverified, and its expiry is still reported for the caller's precedence", () => {
    const v = claimValidity([claim(at(-5 * D), "needs_review")], AT);
    expect(v).toMatchObject({ state: "unverified", expiry: "expired", daysRemaining: -5 });
    // The tile names the missing check first; the passport and dispatch name the expiry first.
    expect(expiryState({ id: 1, ownerType: "operator", ownerId: 1, docType: "d", title: "t", expiresAt: at(-5 * D), verificationStatus: "needs_review" }, AT, 30)).toBe("unverified");
  });

  it("7. rejected and superseded: a rejected row never governs over another; a superseded version yields to its successor", () => {
    expect(governingClaim([claim(at(900 * D), "rejected"), claim(at(10 * D), "needs_review")])?.verificationStatus).toBe("needs_review");
    expect(claimValidity([claim(at(900 * D), "rejected")], AT).state).toBe("rejected");
    const v = (version: number, state: DocumentVersion["state"], days: number): DocumentVersion => ({
      documentRef: "x", version, type: "tdg_certificate" as never, subjectRef: "s", state, effectiveFrom: null, expiresAt: at(days * D),
      verifiedByUserId: 1, verifiedAt: AT, supersededByVersion: null, uploadedAt: AT,
    });
    expect(validityOf([v(1, "superseded", 400), v(2, "verified", -1)], AT)).toMatchObject({ state: "expired", version: 2 });
  });

  it("8. a date-only expiry is midnight UTC; a local end-of-day is an absolute instant", () => {
    expect(readExpiry(new Date("2026-10-15"), AT, 30).expiry).toBe("expired");
    expect(readExpiry(new Date("2026-10-15T23:59:59-07:00"), AT, 30)).toEqual({ expiry: "expiring", daysRemaining: 0 });
    expect(readExpiry(new Date("2026-10-16"), AT, 0)).toEqual({ expiry: "current", daysRemaining: 0 });
  });

  it("9. the tile's words change nothing about the decision underneath", () => {
    const WORD = { in_force: "current", expiring: "expiring", expired: "expired", unverified: "unverified", rejected: "rejected", none: "missing" } as const;
    for (const days of [-10, -0.001, 0, 0.3, 29, 30.5, 400]) for (const v of ["verified", "needs_review", "rejected"] as const) {
      const e = at(days * D);
      const tile = expiryState({ id: 1, ownerType: "operator", ownerId: 1, docType: "d", title: "t", expiresAt: e, verificationStatus: v }, AT, 30);
      expect(tile, `${days}/${v}`).toBe(WORD[complianceDocumentValidity([claim(e, v)], "d", AT, 30).state]);
    }
  });

  it("the passport's verdict is the canonical one, worded", () => {
    const requirement = {
      requirementKey: "r", version: 1, family: "f", title: "Doc", subjectType: "operator" as const, jurisdiction: "*",
      satisfiedByDocTypes: ["d"], warnDaysBeforeExpiry: 30, missingSeverity: "blocked" as const, verificationStatus: "verified" as const, effectiveFrom: new Date(0),
    };
    for (const [days, status] of [[400, "satisfied"], [10, "expiring"], [-1, "expired"], [0, "expiring"]] as const) {
      const p = evaluateRequirement({ requirement, credentials: [{ ...claim(at(days * D)), privateDetail: false }], now: AT });
      expect(p.status, String(days)).toBe(status);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Census (Part N)                                                      */
/* ------------------------------------------------------------------ */

const productionFiles = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) { if (f !== "node_modules") walk(full); continue; }
      if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(full);
    }
  };
  walk(path.resolve(__dirname));
  walk(path.resolve(__dirname, "../client/src"));
  return out;
})();
const rel = (f: string) => path.relative(path.resolve(__dirname, ".."), f);

describe("census", () => {
  it("1. the four former duplicates decide through the canonical engine", () => {
    expect(read("widgetSources.ts")).toMatch(/complianceDocumentValidity\(\[claim\]/);
    expect(read("_core/compliancePassport.ts")).toContain("claimValidity(candidates, args.now, r.warnDaysBeforeExpiry)");
    expect(read("readinessComposer.ts")).toMatch(/export function credentialState[\s\S]{0,400}complianceDocumentValidity\(rows, docTypes, at\)/);
    expect(read("_core/dispatchReadiness.ts")).toContain('readExpiry(c.expiresAt, asOf, 0).expiry === "expired"');
    expect(read("_core/complianceDocumentValidity.ts")).toContain('from "./documentValidity"');
  });

  it("10. no document- or credential-expiry arithmetic is left in the files that used to carry it", () => {
    // The duplication pattern: an expiry compared with a moment, or day arithmetic on an expiry. Each
    // allowed line is a different question, named here so a new one cannot hide among them.
    const ALLOWED: Record<string, string> = {
      // Medical eligibility for dispatch uses `<=` at the exact instant. Moving it to the canonical `<`
      // would change dispatch at that instant, which C1b-3 may not do — a recorded follow-up (C2).
      "credential.expiresAt && credential.expiresAt <= now": "medicalFitnessForDispatch — dispatch-affecting, deferred",
      // Academy requirement bindings in force: a binding window, not a document.
      "(!b.expiresAt || b.expiresAt > now)": "academy binding window",
      // Academy qualification acceptance inside the dispatch composer: qualification validity, dispatch-owned.
      'q.status === "current" && (!q.expiresAt || q.expiresAt > now)': "composer academy acceptance — dispatch-affecting, deferred",
      // The calendar's window filter: which events fall in the view, not whether anything is valid.
      "(q.expiresAt < args.from || q.expiresAt > args.to)": "calendar window",
    };
    const files = ["widgetSources.ts", "_core/compliancePassport.ts", "_core/dispatchReadiness.ts", "readinessComposer.ts",
      "readinessRouter.ts", "openShiftsRouter.ts", "crewRouter.ts", "calendarRouter.ts", "_core/complianceDocumentValidity.ts"];
    const hits: string[] = [];
    for (const f of files) {
      read(f).split("\n").forEach((line, i) => {
        if (!/(expiresAt|licenseExpiresAt)[^;]*(86_?400_?000|getTime\(\)\s*[<>]|\s[<>]=?\s)/.test(line)) return;
        if (Object.keys(ALLOWED).some((a) => line.includes(a))) return;
        hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
    // documentValidity itself is the one place that does day arithmetic on an expiry.
    expect(read("_core/documentValidity.ts")).toContain("export function readExpiry(");
  });

  it("the four qualification readers no longer read workerQualifications; only the adapter does", () => {
    for (const f of ["readinessRouter.ts", "openShiftsRouter.ts", "crewRouter.ts", "calendarRouter.ts"]) {
      expect(read(f), f).not.toContain("workerQualifications");
      expect(read(f), f).toContain('from "./qualificationReads"');
    }
    const readers = productionFiles.filter((f) => /from\(workerQualifications\)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(readers).toEqual(["server/qualificationReads.ts"]);
  });

  it("24. no production writer of workerQualifications exists, and none was added", () => {
    const writers = productionFiles.filter((f) => /insert\(workerQualifications\)|update\(workerQualifications\)|INTO\s+`?workerQualifications/.test(readFileSync(f, "utf8"))).map(rel);
    expect(writers).toEqual([]);
  });

  it("operatorCapabilities gained no reader or writer, and no second qualification authority exists", () => {
    const touching = productionFiles.filter((f) => readFileSync(f, "utf8").includes("operatorCapabilities")).map(rel);
    expect(touching).toEqual([]);
    // The adapter reads the stores; it writes none of them.
    expect(read("qualificationReads.ts")).not.toMatch(/\.(insert|update|delete)\(/);
  });
});
