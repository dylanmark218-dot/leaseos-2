import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeMechanicRelease,
  authorizeRecordScope,
  isDomainRole,
  permissionForProcedure,
  permissionsFor,
  UNIVERSAL_PERMISSIONS,
  EVIDENCE_READ_CATEGORIES,
  SENSITIVE_PERMISSIONS,
  isSensitivePermission,
  RECORDS_PROCEDURE_PERMISSIONS,
  type DomainRole,
  type Permission,
} from "./recordsAuthorization";

const ALL_ROLES: DomainRole[] = [
  "driver", "dispatcher", "mechanic", "shop_lead", "safety",
  "office", "management", "hr", "legal", "auditor",
];

const U = 42;

describe("fails closed", () => {
  it("denies an unauthenticated caller before looking at roles", () => {
    const r = authorize({ userId: null, roles: ["management"], permission: "billing.read" });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_unauthenticated");
  });

  it("denies a user holding no domain role at all", () => {
    const r = authorize({ userId: U, roles: [], permission: "evidence.read_own" });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_no_role");
    expect(r.detail).toContain("no domain role");
  });

  it("discards unrecognized role strings rather than trusting them", () => {
    // A typo, or a role from a migration that has not shipped, grants nothing.
    const r = authorize({
      userId: U,
      roles: ["superuser", "Management", "admin"],
      permission: "billing.read",
    });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_no_role");
    expect(r.effectiveRoles).toEqual([]);
    expect(isDomainRole("superuser")).toBe(false);
    expect(isDomainRole("management")).toBe(true);
  });

  it("keeps recognized roles when mixed with junk", () => {
    const r = authorize({
      userId: U,
      roles: ["nonsense", "safety"],
      permission: "incident.review",
    });
    expect(r.allowed).toBe(true);
    expect(r.effectiveRoles).toEqual(["safety"]);
  });

  it("names what was missing instead of a bare refusal", () => {
    const r = authorize({ userId: U, roles: ["driver"], permission: "legal_hold.place" });
    expect(r.allowed).toBe(false);
    expect(r.detail).toContain("legal_hold.place");
    expect(r.detail).toContain("driver");
  });
});

describe("the shop is walled off from commercial and personnel data", () => {
  it("gives the shop maintenance reads and no commercial read at all", () => {
    // B20.3 replaced the broad grant with categories. The shop is not denied
    // commercial access after being given everything — it was never given it,
    // so a new sensitive category reaches nobody until deliberately granted.
    expect(
      authorize({ userId: U, roles: ["mechanic"], permission: "evidence.read_maintenance" }).allowed
    ).toBe(true);
    expect(
      authorize({ userId: U, roles: ["mechanic"], permission: "evidence.read_commercial" }).allowed
    ).toBe(false);
    expect(
      authorize({ userId: U, roles: ["mechanic"], permission: "evidence.read_personnel" }).allowed
    ).toBe(false);

    // The explicit denial stays as defence in depth.
    const billing = authorize({ userId: U, roles: ["mechanic"], permission: "billing.read" });
    expect(billing.allowed).toBe(false);
    expect(billing.detail).toContain("explicitly denied");
  });

  it("keeps every read category reachable by someone and by not everyone", () => {
    for (const cat of EVIDENCE_READ_CATEGORIES) {
      const holders = ALL_ROLES.filter(
        r => authorize({ userId: U, roles: [r], permission: cat }).allowed
      );
      expect(holders.length, `nobody holds ${cat}`).toBeGreaterThan(0);
      expect(holders.length, `everybody holds ${cat}`).toBeLessThan(ALL_ROLES.length);
    }
  });

  it("keeps personnel and legal reads off the operational roles", () => {
    for (const role of ["driver", "dispatcher", "mechanic", "shop_lead", "office"] as const) {
      expect(
        authorize({ userId: U, roles: [role], permission: "evidence.read_personnel" }).allowed,
        role
      ).toBe(false);
      expect(
        authorize({ userId: U, roles: [role], permission: "evidence.read_legal" }).allowed,
        role
      ).toBe(false);
    }
  });

  it("denies shop and dispatch the incident investigation", () => {
    for (const role of ["mechanic", "shop_lead", "dispatcher", "driver"] as const) {
      const r = authorize({ userId: U, roles: [role], permission: "incident.read_investigation" });
      expect(r.allowed, `${role} should not read investigations`).toBe(false);
    }
  });

  it("still lets dispatch see that a unit is affected", () => {
    // Knowing a unit is unavailable is a dispatch fact. Knowing why the
    // operator is in hospital is not.
    expect(
      authorize({ userId: U, roles: ["dispatcher"], permission: "incident.read_summary" }).allowed
    ).toBe(true);
  });

  it("reserves payroll to HR alone", () => {
    // Management holds broad operational authority and still does not get
    // payroll by default. Seniority is not a reason to widen a data category;
    // needing it for the job is, and management does not.
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: U, roles: [r], permission: "payroll.read" }).allowed
    );
    expect(holders).toEqual(["hr"]);
  });
});

describe("deny beats grant across combined roles", () => {
  it("does not let a second role wash out a denial attached to the first", () => {
    // Someone who is both a mechanic and an auditor still cannot read billing:
    // collecting roles must not be a way to launder a denial.
    const r = authorize({
      userId: U,
      roles: ["mechanic", "auditor"],
      permission: "billing.read",
    });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_permission");
  });

  it("omits denied permissions from the effective permission set", () => {
    const perms = permissionsFor(["mechanic", "auditor"]);
    expect(perms).not.toContain("billing.read");
    expect(perms).not.toContain("payroll.read");
    expect(perms).not.toContain("incident.read_investigation");
    expect(perms).not.toContain("evidence.read_commercial");
    expect(perms).toContain("maintenance.record_release");
  });

  it("grants the union where nothing is denied", () => {
    const perms = permissionsFor(["safety", "legal"]);
    expect(perms).toContain("incident.review");
    expect(perms).toContain("legal_hold.release");
  });

  it("returns nothing for an unrecognized role set", () => {
    expect(permissionsFor(["wizard"])).toEqual([]);
  });
});

describe("governance permissions are narrow", () => {
  it("lets management place a legal hold but not release one", () => {
    expect(authorize({ userId: U, roles: ["management"], permission: "legal_hold.place" }).allowed).toBe(true);
    // Releasing a hold is deliberately narrower than placing one — an admin
    // must not be able to lift it casually.
    expect(authorize({ userId: U, roles: ["management"], permission: "legal_hold.release" }).allowed).toBe(false);
  });

  it("reserves hold release to legal", () => {
    const holders = ALL_ROLES.filter(
      r => authorize({ userId: U, roles: [r], permission: "legal_hold.release" }).allowed
    );
    expect(holders).toEqual(["legal"]);
  });

  it("reserves retention disposition and role granting to management", () => {
    for (const p of ["retention.dispose", "roles.grant"] as Permission[]) {
      const holders = ALL_ROLES.filter(
        r => authorize({ userId: U, roles: [r], permission: p }).allowed
      );
      expect(holders, p).toEqual(["management"]);
    }
  });

  it("does not let an auditor write anything", () => {
    for (const p of ["evidence.seal", "evidence.amend", "incident.review", "maintenance.record_release", "retention.dispose"] as Permission[]) {
      expect(authorize({ userId: U, roles: ["auditor"], permission: p }).allowed, p).toBe(false);
    }
    expect(authorize({ userId: U, roles: ["auditor"], permission: "evidence.export" }).allowed).toBe(true);
  });
});

describe("record scope", () => {
  const driver = { userId: U, operatorId: 7, roles: ["driver"] as const };

  it("lets a driver reach their own record", () => {
    const r = authorizeRecordScope({
      ...driver,
      permission: "evidence.read_own",
      subject: { ownerOperatorId: 7 },
    });
    expect(r.allowed).toBe(true);
  });

  it("stops a driver reaching another operator's record", () => {
    const r = authorizeRecordScope({
      ...driver,
      permission: "evidence.read_own",
      subject: { ownerOperatorId: 9 },
    });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_scope");
    expect(r.detail).toContain("another operator");
  });

  it("stops a driver reaching an unowned record by default", () => {
    // No owner recorded is not the same as "yours".
    const r = authorizeRecordScope({
      ...driver,
      permission: "evidence.read_own",
      subject: {},
    });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_scope");
  });

  it("does not scope-limit a holder of a category read", () => {
    const r = authorizeRecordScope({
      userId: U,
      operatorId: null,
      roles: ["office"],
      permission: "evidence.read_job_operational",
      subject: { ownerOperatorId: 9 },
    });
    expect(r.allowed).toBe(true);
  });
});

describe("mechanic release must be signed by the technician who did it", () => {
  it("accepts a release recorded by the performing technician", () => {
    const r = authorizeMechanicRelease({ userId: 113, roles: ["mechanic"], technicianUserId: 113 });
    expect(r.allowed).toBe(true);
  });

  it("refuses a release recorded on another technician's behalf", () => {
    const r = authorizeMechanicRelease({ userId: 200, roles: ["shop_lead"], technicianUserId: 113 });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_scope");
    expect(r.detail).toContain("not on their behalf");
  });

  it("refuses an office user regardless of who is named", () => {
    const r = authorizeMechanicRelease({ userId: 5, roles: ["office"], technicianUserId: 5 });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_permission");
  });

  it("refuses management too — signing off is not the same as performing", () => {
    expect(
      authorizeMechanicRelease({ userId: 5, roles: ["management"], technicianUserId: 5 }).allowed
    ).toBe(false);
  });

  it("lets management revoke a release without being able to grant one", () => {
    expect(authorize({ userId: 5, roles: ["management"], permission: "maintenance.revoke_release" }).allowed).toBe(true);
    expect(authorize({ userId: 5, roles: ["management"], permission: "maintenance.record_release" }).allowed).toBe(false);
  });
});

describe("procedure permission map", () => {
  it("maps every declared records procedure to a permission", () => {
    for (const [name, perm] of Object.entries(RECORDS_PROCEDURE_PERMISSIONS)) {
      expect(permissionForProcedure(name), name).toBe(perm);
    }
  });

  it("returns null for an unmapped procedure so wiring fails loudly", () => {
    // roleProcedure() throws on null rather than degrading to authenticated-only.
    expect(permissionForProcedure("records.evidence.deleteEverything")).toBeNull();
  });

  it("has at least one role able to reach every mapped procedure", () => {
    // A permission no role can hold is a procedure nobody can call — almost
    // always a mistake rather than a deliberate lockout.
    for (const perm of Object.values(RECORDS_PROCEDURE_PERMISSIONS)) {
      const holders = ALL_ROLES.filter(
        r => authorize({ userId: U, roles: [r], permission: perm }).allowed
      );
      expect(holders.length, `nobody can use ${perm}`).toBeGreaterThan(0);
    }
  });

  it("keeps driver-facing field procedures reachable by a driver", () => {
    for (const p of ["evidence.seal", "evidence.send", "roadside.open", "incident.create"] as Permission[]) {
      expect(authorize({ userId: U, roles: ["driver"], permission: p }).allowed, p).toBe(true);
    }
  });
});


describe("branch scope", () => {
  it("lets a global grant reach any branch", () => {
    for (const branch of ["GP", "EDM", null]) {
      expect(
        authorize({
          userId: U,
          grants: [{ role: "dispatcher", scopeRef: null }],
          permission: "maintenance.read_defect",
          resourceBranch: branch,
        }).allowed,
        String(branch)
      ).toBe(true);
    }
  });

  it("confines a branch grant to its own branch", () => {
    const gp = { role: "dispatcher", scopeRef: "GP" };
    expect(
      authorize({ userId: U, grants: [gp], permission: "maintenance.read_defect", resourceBranch: "GP" }).allowed
    ).toBe(true);

    const other = authorize({
      userId: U,
      grants: [gp],
      permission: "maintenance.read_defect",
      resourceBranch: "EDM",
    });
    expect(other.allowed).toBe(false);
    expect(other.outcome).toBe("denied_scope");
    expect(other.detail).toContain("EDM");
  });

  it("does not let a grant in one branch borrow a permission from another", () => {
    // Dispatcher in GP, office in EDM. Reading commercial data about a GP
    // resource must not succeed on the strength of the EDM office grant.
    const r = authorize({
      userId: U,
      grants: [
        { role: "dispatcher", scopeRef: "GP" },
        { role: "office", scopeRef: "EDM" },
      ],
      permission: "evidence.read_commercial",
      resourceBranch: "GP",
    });
    expect(r.allowed).toBe(false);
    expect(r.effectiveRoles).toEqual(["dispatcher"]);
  });

  it("applies a branch grant when the resource was RESOLVED to no branch — null, not undefined", () => {
    expect(
      authorize({
        userId: U,
        grants: [{ role: "safety", scopeRef: "GP" }],
        permission: "incident.review",
        resourceBranch: null,
      }).allowed
    ).toBe(true);
  });

  it("refuses a branch-confined grant when no branch was resolved — the generic gate never resolves one", () => {
    // v21.9.1 — before this, `undefined` and `null` were the same, nobody
    // outside this module supplied a branch, and every confined grant passed
    // every generic gate. A confined grant now needs the record loaded.
    const r = authorize({ userId: U, grants: [{ role: "safety", scopeRef: "GP" }], permission: "incident.review" });
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("denied_scope");
    expect(r.detail).toContain("did not resolve the resource's branch");
    // A global grant still passes the generic gate.
    expect(authorize({ userId: U, grants: [{ role: "safety" }], permission: "incident.review" }).allowed).toBe(true);
    // A universal, self-scoped permission is unaffected by branch confinement.
    expect(authorize({ userId: U, grants: [{ role: "driver", scopeRef: "GP" }], permission: "inbox.read_own" }).allowed).toBe(true);
  });

  it("holds the nine actions that were role-authorized but outside the fail-closed set — v21.9.1", () => {
    for (const p of ["dispatch.award", "dispatch.override.grant", "dispatch.enforcement.manage", "ifta.finalize", "period.close", "period.reopen", "gst.finalize", "ar.credit.decide", "ar.writeoff.decide"] as const) {
      expect(SENSITIVE_PERMISSIONS, p).toContain(p);
    }
  });
});

describe("sensitive permissions are declared, not guessed", () => {
  it("marks every irreversible or governance action sensitive", () => {
    for (const p of [
      "roles.grant", "legal_hold.place", "legal_hold.release",
      "retention.dispose", "maintenance.record_release",
      "maintenance.revoke_release", "evidence.amend", "evidence.export",
    ] as Permission[]) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });

  it("keeps invoicing and spatial truth-changing actions fail-closed", () => {
    for (const p of [
      "invoicing.void", "invoicing.dispute.resolve",
      "geo.import", "geo.locationVerifyFromGrid", "geo.access.decide",
      "spatial.structure.verify", "spatial.route.approve",
    ] as Permission[]) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });

  it("does not mark ordinary reads sensitive", () => {
    for (const p of ["evidence.read_own", "incident.read_summary", "roadside.open"] as Permission[]) {
      expect(isSensitivePermission(p), p).toBe(false);
    }
  });

  it("keeps the sensitive set free of duplicates", () => {
    expect(new Set(SENSITIVE_PERMISSIONS).size).toBe(SENSITIVE_PERMISSIONS.length);
  });
});

describe("payroll and tax authorization boundaries", () => {
  const FINANCE_ROLES: DomainRole[] = [
    "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant",
  ];
  const EVERY_ROLE = [...ALL_ROLES, ...FINANCE_ROLES];

  it("keeps the legacy coarse payroll read with HR alone", () => {
    // B20.2 pinned this. Adding five finance roles must not quietly widen it.
    const holders = EVERY_ROLE.filter(
      r => authorize({ userId: U, roles: [r], permission: "payroll.read" }).allowed
    );
    expect(holders).toEqual(["hr"]);
  });

  it("gives every worker their own pay and nobody else's", () => {
    for (const role of ["driver", "mechanic", "shop_lead"] as const) {
      expect(authorize({ userId: U, roles: [role], permission: "payroll.read_own" }).allowed, role).toBe(true);
      expect(authorize({ userId: U, roles: [role], permission: "payroll.read_employee" }).allowed, role).toBe(false);
      expect(authorize({ userId: U, roles: [role], permission: "payroll.read_all" }).allowed, role).toBe(false);
    }
  });

  it("gives dispatch no payroll access, including their own — as specified", () => {
    // Built to the stated role direction ("Dispatcher -> none"). Flagged in the
    // checkpoint because it also means a dispatcher cannot open their own
    // payslip, which is probably not the intent. Pinned here so the decision is
    // visible and reversible rather than an accident of the grant table.
    for (const p of ["payroll.read_own", "payroll.read_employee", "payroll.read_all", "payroll.review"] as Permission[]) {
      expect(authorize({ userId: U, roles: ["dispatcher"], permission: p }).allowed, p).toBe(false);
    }
  });

  it("does not give management individual private payroll by default", () => {
    // Seniority is not a reason to widen a data category.
    for (const p of ["payroll.read_employee", "payroll.read_all", "payroll.read"] as Permission[]) {
      expect(authorize({ userId: U, roles: ["management"], permission: p }).allowed, p).toBe(false);
    }
  });

  it("holds banking and tax identifiers with nobody", () => {
    // Named so they can be denied under, and so adding a holder is a
    // deliberate, reviewable act rather than a side effect of a broad grant.
    for (const p of ["payroll.bank.read", "payroll.tax_identifier.read"] as Permission[]) {
      const holders = EVERY_ROLE.filter(
        r => authorize({ userId: U, roles: [r], permission: p }).allowed
      );
      expect(holders, p).toEqual([]);
    }
  });

  it("separates running payroll from approving it", () => {
    expect(authorize({ userId: U, roles: ["payroll_admin"], permission: "payroll.run" }).allowed).toBe(true);
    expect(authorize({ userId: U, roles: ["payroll_admin"], permission: "payroll.approve" }).allowed).toBe(false);
    expect(authorize({ userId: U, roles: ["controller"], permission: "payroll.approve" }).allowed).toBe(true);
    expect(authorize({ userId: U, roles: ["controller"], permission: "payroll.run" }).allowed).toBe(false);
  });

  it("separates reading a wage rate from changing one", () => {
    expect(authorize({ userId: U, roles: ["payroll_admin"], permission: "payroll.rate.read" }).allowed).toBe(true);
    expect(authorize({ userId: U, roles: ["payroll_admin"], permission: "payroll.rate.write" }).allowed).toBe(false);
    expect(authorize({ userId: U, roles: ["controller"], permission: "payroll.rate.write" }).allowed).toBe(true);
  });

  it("gives every authenticated person their own tax organizer", () => {
    // B20.9: this is a property of being a person, not of holding a job. The
    // previous split let a driver and an HR user open their own T4 while an
    // office or controller user could not — arbitrary, and flagged as such.
    for (const role of EVERY_ROLE) {
      expect(
        authorize({ userId: U, roles: [role], permission: "tax.read_personal_own" }).allowed,
        role
      ).toBe(true);
    }
  });

  it("still gives nobody access to another person's organizer", () => {
    // The permission is self-scoped in the procedure, which resolves the owner
    // from the session. There is no permission that reads someone else's.
    const anyOthersOrganizer = (Object.keys(
      RECORDS_PROCEDURE_PERMISSIONS
    ) as string[]).filter(k => /personal|organizer/i.test(k) && !/^finance\.my/.test(k));
    expect(anyOthersOrganizer).toEqual([]);
  });

  it("grants a universal only to someone holding a recognized role", () => {
    // Fail-closed still applies: no role, nothing at all.
    expect(
      authorize({ userId: U, roles: [], permission: "tax.read_personal_own" }).allowed
    ).toBe(false);
    expect(
      authorize({ userId: null, roles: ["driver"], permission: "tax.read_personal_own" }).allowed
    ).toBe(false);
  });

  it("keeps the universal list short and self-scoped", () => {
    // A permission belongs here only when it is self-scoped in code, not
    // merely self-scoped by intention. Two entries now: the tax organizer and
    // portal composition, both of which read only the session and nothing
    // the request could name.
    // Five now: the tax organizer, portal composition, and three device
    // permissions — enrol, rotate, push — that read only `ctx.user.id`.
    expect(UNIVERSAL_PERMISSIONS).toEqual([
      "tax.read_personal_own", "portal.compose_own",
      "device.enroll_own", "device.rotate_own", "sync.push_own",
      // v21.0 — your inbox, your day.
      "inbox.read_own", "myday.read_own",
      // v21.1 — your own readiness.
      "dispatch.readiness_own",
      "academy.read_own", "academy.progress_own", "academy.assessment_own",
      "academy.certificate.sign_own", "academy.direct_supervision_attest_own",
      // 0212 — the Driver Wallet: the caller's own operator record.
      "portfolio.read_own", "portfolio.submit_own", "portfolio.share_own",
      // SA1 — your own signature or decline; the signer row must name ctx.user.id.
      "attest.sign_own", "attest.decline_own",
      // 0206 — your own availability declaration.
      "shifts.availability_own",
      // 0228 — the policies a person must acknowledge, and their own signature on one.
      "safety_program.read_own", "safety_program.acknowledge_own",
      // Analytics Checkpoint B — your own numbers; the operator comes from the session.
      "analytics.read_own",
    ]);
  });

  it("reserves closing a fiscal year to the controller", () => {
    const holders = EVERY_ROLE.filter(
      r => authorize({ userId: U, roles: [r], permission: "tax.year_end.close" }).allowed
    );
    expect(holders).toEqual(["controller"]);
  });

  it("reserves tax.rules.manage to the controller alone", () => {
    // Deliberate reversal of the B20.5 position that nobody holds this.
    //
    // Loading an authority-sourced rule set is the act that turns UNKNOWN into
    // a number, so B20.5 left it unheld. But B20.7 exposed the procedure, and a
    // permission no role can hold is a procedure nobody can call — the system
    // could never leave UNKNOWN. Granted to exactly one role, still sensitive,
    // still audited, and the service independently refuses to store a rule as
    // verified unless its source is verified and names an authority.
    const holders = EVERY_ROLE.filter(
      r => authorize({ userId: U, roles: [r], permission: "tax.rules.manage" }).allowed
    );
    expect(holders).toEqual(["controller"]);
  });

  it("lets an external accountant read the books and nothing operational", () => {
    const a = (p: Permission) =>
      authorize({ userId: U, roles: ["external_accountant"], permission: p }).allowed;
    expect(a("tax.read_business")).toBe(true);
    expect(a("banking.read")).toBe(true);
    expect(a("evidence.export")).toBe(true);

    // Everything a fleet does is out of reach.
    for (const p of [
      "incident.read_investigation", "maintenance.record_release",
      "evidence.amend", "roles.grant", "legal_hold.release",
      "payroll.read_all", "payroll.bank.read", "roadside.open",
      "maintenance.write_work_order",
    ] as Permission[]) {
      expect(a(p), p).toBe(false);
    }
  });

  it("does not let a finance role launder an operational denial", () => {
    // Someone who is both a mechanic and a bookkeeper still cannot read
    // investigations, and still cannot write billing.
    const roles = ["mechanic", "bookkeeper"] as const;
    expect(authorize({ userId: U, roles, permission: "incident.read_investigation" }).allowed).toBe(false);
    expect(authorize({ userId: U, roles, permission: "billing.write" }).allowed).toBe(false);
    // But the bookkeeping reads they legitimately hold still work.
    expect(authorize({ userId: U, roles, permission: "tax.read_business" }).allowed).toBe(true);
  });

  it("marks every irreversible finance action sensitive", () => {
    for (const p of [
      "payroll.approve", "payroll.run", "payroll.adjust", "payroll.rate.write",
      "payroll.export", "payroll.bank.read", "payroll.tax_identifier.read",
      "tax.year_end.close", "tax.adjust", "tax.rules.manage", "tax.export",
      "banking.reconcile",
    ] as Permission[]) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });
});
