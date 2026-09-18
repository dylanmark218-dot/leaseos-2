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

/*
 * The status words a row may carry. Stated, because they were ad hoc and that is why the guard
 * could not tell "done" from "in progress": P8.1 read WIRED INTO ALL THREE CONSUMERS, which is
 * true, informative and invisible to a check looking for DONE. A new word now has to be added here
 * deliberately rather than invented in a row nobody re-reads.
 */
const STATUS_VOCABULARY = ["DONE", "PARTLY DONE", "PARTIAL", "STAGED", "STARTED", "CORE BUILT"] as const;

describe("the register does not understate the branch either", () => {
  it("uses only status words the guard knows, so a new one is a deliberate act", () => {
    const offenders: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("| P")) continue;
      const marker = /\*\*([A-Z][A-Z /]{2,40})/.exec(line);
      if (!marker) continue;   // a row with no marker is simply open, which is a legitimate state
      const word = marker[1]!.trim();
      if (!STATUS_VOCABULARY.some(v => word.startsWith(v))) offenders.push(`${rowId(line)} → "${word}"`);
    }
    expect(offenders, "a register row invented a status word the guard cannot read").toEqual([]);
  });

  /** Work whose artefacts are on the branch: the row must not still read as undone. */
  /*
   * Every checkpoint whose artefacts are on the branch. The list was six rows, and that was the
   * bug: P4.1 sat reading "IN PROGRESS - router 3 done" for twenty versions after it closed,
   * because an edit targeting the wrong row title matched nothing and nobody checked. A guard that
   * only watches the rows you remembered to list is a guard against the mistakes you did not make.
   */
  const LANDED: { row: string; artefact: string }[] = [
    { row: "P0.5", artefact: "server/widgetPromotion.test.ts" },
    { row: "P4.1", artefact: "drizzle/0149_vendor_book_scope.sql" },
    { row: "P4.4", artefact: "drizzle/0151_passage_basis_correction.sql" },
    { row: "P5.1", artefact: "client/src/showcase/panelSource.ts" },
    { row: "P5.2", artefact: "client/src/portal/panelContract.ts" },
    { row: "P5.3", artefact: "client/src/a11y/axeHarness.ts" },
    { row: "P8.1", artefact: "server/_core/interEngineStatus.ts" },
    { row: "P8.2", artefact: "drizzle/0153_automation_policy.sql" },
    { row: "P8.3", artefact: "drizzle/0155_hos_attestation.sql" },
    { row: "P8.5", artefact: "drizzle/0156_restricted_records_vault.sql" },
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
      if (!new RegExp(`\\*\\*(${STATUS_VOCABULARY.join("|")})`).test(line!)) silent.push(row);
    }
    expect(silent, "work that is on the branch but whose register row still reads as undone").toEqual([]);
  });
});
