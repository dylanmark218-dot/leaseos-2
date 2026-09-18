/**
 * The register's claims are checked, not trusted.
 *
 * `docs/REMAINING_BUILD_REGISTER.md` is the document handed over at the end of every session, and
 * a row claiming DONE names the artefacts that make it true — a migration number, a file path, a
 * commit. This reads those claims and fails if an artefact does not exist. It cannot tell whether
 * a capability works; the suites do that. It can tell that a claim points at something real, which
 * is the failure mode a hand-maintained document actually has.
 *
 * It also caught the opposite failure, which is why the second test exists: the P7 rows for work
 * that HAD landed (0134-0137, commercialOffice.*) still read as undone, so the register was
 * understating the branch. A row is wrong in both directions and both are worth failing on.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REGISTER = "docs/REMAINING_BUILD_REGISTER.md";
const text = readFileSync(REGISTER, "utf8");
const claimingRows = text.split("\n").filter(l => l.startsWith("|") && /\*\*(DONE|PARTLY DONE)/.test(l));

const tokens = (line: string) => Array.from(line.matchAll(/`([^`]+)`/g)).map(m => m[1]!);
const rowId = (line: string) => line.split("|")[1]?.trim() ?? "?";

describe("every DONE claim in the register points at something that exists", () => {
  it("has claiming rows to check at all", () => {
    expect(claimingRows.length).toBeGreaterThan(20);
  });

  it("names a migration only if that migration file is on the branch", () => {
    const missing: string[] = [];
    for (const row of claimingRows) {
      for (const t of tokens(row)) {
        if (!/^0\d{3}$/.test(t)) continue;
        if (!existsSync(`drizzle`) ) continue;
        const found = execSync(`ls drizzle/${t}_*.sql 2>/dev/null || true`, { encoding: "utf8" }).trim();
        if (!found) missing.push(`${rowId(row)} → migration ${t}`);
      }
    }
    expect(missing, "a row claims a migration that is not in drizzle/").toEqual([]);
  });

  it("names a file only if that file is on the branch", () => {
    const missing: string[] = [];
    for (const row of claimingRows) {
      for (const t of tokens(row)) {
        if (!/^(server|client|scripts|drizzle|docs|data|archive)\//.test(t)) continue;
        const path = t.replace(/\/$/, "");
        if (!existsSync(path)) missing.push(`${rowId(row)} → ${t}`);
      }
    }
    expect(missing, "a row claims a path that does not exist").toEqual([]);
  });

  it("names a commit only if that commit is in this history", () => {
    const missing: string[] = [];
    for (const row of claimingRows) {
      for (const t of tokens(row)) {
        if (!/^[0-9a-f]{7,40}$/.test(t)) continue;
        try { execSync(`git cat-file -e ${t}^{commit}`, { stdio: "ignore" }); }
        catch { missing.push(`${rowId(row)} → commit ${t}`); }
      }
    }
    expect(missing, "a row claims a commit this branch does not contain").toEqual([]);
  });
});

describe("the register does not understate the branch either", () => {
  /** Work whose artefacts are on the branch: the row must not still read as undone. */
  const LANDED: { row: string; artefact: string }[] = [
    { row: "P7.2", artefact: "drizzle/0134_organization_record_links.sql" },
    { row: "P7.3", artefact: "drizzle/0135_facility_statements.sql" },
    { row: "P7.4", artefact: "drizzle/0136_commercial_approval_ledger.sql" },
    { row: "P7.5", artefact: "drizzle/0137_vendor_bill_ledger.sql" },
    { row: "P7.7", artefact: "drizzle/0144_commercial_document_registry.sql" },
    { row: "P7.8", artefact: "drizzle/0145_audit_package_vendor_kind.sql" },
  ];

  it("marks a row whose artefacts are on the branch", () => {
    const silent: string[] = [];
    for (const { row, artefact } of LANDED) {
      expect(existsSync(artefact), `${row}: the artefact this check is built on moved`).toBe(true);
      const line = text.split("\n").find(l => l.startsWith(`| ${row} `));
      expect(line, `${row} is not in the register`).toBeTruthy();
      if (!/\*\*(DONE|PARTLY DONE|STAGED)/.test(line!)) silent.push(row);
    }
    expect(silent, "work that is on the branch but whose register row still reads as undone").toEqual([]);
  });
});
