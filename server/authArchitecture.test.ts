/**
 * There is still one of each.
 *
 * This checkpoint added a `/login` route, a chooser and a portal-entry model.
 * Every one of them is the kind of addition that, done carelessly, becomes a
 * second system: a login page grows a password field, a chooser grows its own
 * portal list, an entry model grows its own idea of who holds what. None of
 * those would fail a unit test — each would work — and the damage only shows up
 * later, when the two copies disagree.
 *
 * Reconciled with the auth workspace (#64), which the owner ruled governs the
 * client: the chooser and the portal-entry model this checkpoint added were
 * retired in favour of `SessionGate`, which renders a workspace the SERVER has
 * already resolved (`resolveSessionContext`). The guards that read the retired
 * files now read their replacements and hold them to the same promises: the
 * chooser keeps no list of its own, the gate model grants nothing, and the
 * shell never picks a portal by default.
 *
 * So these read the source. They are structural on purpose, and they strip
 * comments first, because several of the files below discuss the very thing
 * being searched for and a guard that cannot tell a citation from a call fails
 * on its own documentation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (body: string) =>
  body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });

const code = (p: string) => strip(readFileSync(p, "utf8"));

const clientSources = () => walk("client/src");
const serverSources = () => walk("server");

describe("one authentication boundary", () => {
  it("starts the OAuth flow from exactly one place", () => {
    // `startLogin` in client/src/const.ts mints the one-time state nonce. A
    // second minting site would overwrite an in-flight login's cookie and the
    // callback would reject it.
    const definers = clientSources().filter(p =>
      /export\s+const\s+startLogin\s*=/.test(code(p))
    );
    expect(definers).toEqual(["client/src/const.ts"]);
  });

  it("verifies the callback in exactly one place", () => {
    const callbacks = serverSources().filter(p =>
      /["'`]\/api\/oauth\/callback["'`]/.test(code(p))
    );
    expect(callbacks).toEqual(["server/_core/oauth.ts"]);
  });

  it("resolves the request's user in exactly one place", () => {
    const resolvers = serverSources().filter(p =>
      /authenticateRequest\s*\(/.test(code(p)) && !p.endsWith("sdk.ts")
    );
    expect(resolvers).toEqual(["server/_core/context.ts"]);
  });

  it("has no password field, hash or credential table in the application", () => {
    // The checkpoint that adds a login screen is exactly when one of these
    // arrives "just for local development".
    //
    // `client/src/showcase/` and ComponentShowcase are excluded by name: they
    // are the design-system gallery, which renders every shadcn control
    // including a password input, calls nothing and submits nowhere. Scoping
    // this to the application is the difference between a guard that is exact
    // and one somebody switches off the first time it cries wolf.
    const GALLERY = /^client\/src\/(showcase\/|pages\/ComponentShowcase\.tsx$)/;
    const credential =
      /type=["']password["']|bcrypt|argon2|scrypt|passwordHash|password_hash/i;
    const offenders = [...clientSources(), ...serverSources()]
      .filter(p => !GALLERY.test(p))
      .filter(p => credential.test(code(p)));
    expect(offenders).toEqual([]);
  });

  it("has no password column in the schema", () => {
    expect(/password/i.test(strip(readFileSync("drizzle/schema.ts", "utf8")))).toBe(false);
  });
});

describe("one portal composition system", () => {
  it("composes a session in exactly one place", () => {
    const composers = serverSources().filter(p =>
      /export\s+function\s+composeSession\s*\(/.test(code(p))
    );
    expect(composers).toEqual(["server/_core/portalComposition.ts"]);
  });

  it("declares the canonical portal list in exactly one place on the server", () => {
    const registries = serverSources().filter(p =>
      /export\s+const\s+PORTALS\s*:/.test(code(p))
    );
    expect(registries).toEqual(["server/_core/portalComposition.ts"]);
  });

  it("keeps the client's label map in step with the server's registry", () => {
    // The client needs labels before a portal is settled, so the two lists
    // exist. They may not disagree about which portals there are.
    const server = [
      ...strip(readFileSync("server/_core/portalComposition.ts", "utf8")).matchAll(
        /^\s*portal:\s*"([a-z_]+)",/gm
      ),
    ].map(m => m[1]);
    // PORTAL_LABELS packs several keys onto one line, so this matches anywhere
    // in the block rather than at a line start.
    const labels = strip(readFileSync("client/src/portal/viewModels.ts", "utf8"))
      .split("PORTAL_LABELS")[1]
      ?.split("};")[0] ?? "";
    const client = [...labels.matchAll(/([a-z_]+):\s*"/g)].map(m => m[1]);
    expect(server.length).toBeGreaterThan(10);
    for (const key of server) {
      expect(client, `${key} has no client label`).toContain(key);
    }
  });

  it("builds the chooser's options from the server contract, not a local list", () => {
    // A hand-kept array here would be a second definition of what a portal is.
    const chooser = code("client/src/session/WorkspaceChooserView.tsx");
    for (const key of ["field_workforce", "dispatch_operations", "executive"]) {
      expect(chooser, `${key} is hard-coded in the chooser`).not.toContain(key);
    }
  });
});

describe("one acting-scope resolver", () => {
  it("resolves the acting organization in exactly one place", () => {
    const resolvers = serverSources().filter(p =>
      /export\s+async\s+function\s+resolveActingScope\s*\(/.test(code(p))
    );
    expect(resolvers).toEqual(["server/_core/actingScope.ts"]);
  });

  it("still refuses an ambiguous organization rather than picking one", () => {
    const source = code("server/_core/actingScope.ts");
    expect(source).toContain("throw new AmbiguousOrganization");
  });

  it("never derives the acting organization from request input", () => {
    // The precise invariant, which an earlier version of this test got wrong.
    // `orgRef` in an input is not automatically a hole: `commercialOffice`
    // takes one to name a COUNTERPARTY — the vendor or customer a commercial
    // role is being assigned to — while its own acting organization still comes
    // from `resolveActingScope(ctx.user.id)`. Two different things share the
    // column name, and only one of them may never come from the client.
    //
    // So this checks the resolver's argument rather than the presence of a
    // field: every call establishes the caller from the session.
    const calls = serverSources().flatMap(p =>
      [...code(p).matchAll(/resolveActingScope\s*\(([^)]*)\)/g)].map(m => ({
        file: p,
        args: m[1].replace(/\s+/g, " ").trim(),
      }))
    );
    expect(calls.length).toBeGreaterThan(3);
    // A user id, under any of the names it travels as. `commercialApprovalService`
    // receives `args.actorUserId`, which its four callers all fill with
    // `ctx.user.id` — asserted transitively below, since a named argument is
    // only as good as what is put in it.
    const offenders = calls.filter(c => !/user[._]?id/i.test(c.args));
    expect(offenders.map(o => `${o.file}: ${o.args}`)).toEqual([]);

    // And none of them passes anything off the request body.
    const fromInput = calls.filter(c => /\binput\b/.test(c.args));
    expect(fromInput.map(o => `${o.file}: ${o.args}`)).toEqual([]);
  });

  it("fills the approval service's actor from the session at every call site", () => {
    // The transitive half. `decide()` resolves the acting scope from whatever
    // `actorUserId` it is handed, so a caller that passed an input value would
    // choose the organization from the request — through one extra hop.
    //
    // Scoped to calls of that service, not to every occurrence of the field
    // name: `actorUserId` is also an ordinary audit column on several event
    // tables, and asserting about those would be the same conflation this file
    // already corrected once for `orgRef`.
    const sites = serverSources().flatMap(p =>
      [...code(p).matchAll(/ledgerDecide\s*\([^)]*?actorUserId:\s*([^,}]+)/g)].map(m => ({
        file: p,
        value: m[1].trim(),
      }))
    );
    expect(sites.length).toBeGreaterThan(0);
    const notFromSession = sites.filter(s => !/^ctx\.user\.id$/.test(s.value));
    expect(notFromSession.map(s => `${s.file}: ${s.value}`)).toEqual([]);
  });
});

describe("one canonical permission system", () => {
  it("maps procedures to permissions in exactly one place", () => {
    const maps = serverSources().filter(p =>
      /export\s+const\s+RECORDS_PROCEDURE_PERMISSIONS\s*=/.test(code(p))
    );
    expect(maps).toEqual(["server/_core/recordsAuthorization.ts"]);
  });

  it("gates every portal procedure through roleProcedure", () => {
    const source = code("server/portalFundingRouter.ts");
    const mounted = [...source.matchAll(/^\s{2}([a-zA-Z]+):\s*(\w+)\(/gm)].map(m => [m[1], m[2]]);
    expect(mounted.length).toBeGreaterThan(0);
    for (const [name, procedure] of mounted) {
      expect(procedure, `${name} is not a roleProcedure`).toBe("roleProcedure");
    }
  });

  it("does not let the client supply roles or portals to portals.mine", () => {
    // "Whose portals" is not an input. A session that could name its own roles
    // would compose whatever it liked.
    const mine = code("server/portalFundingRouter.ts").split("panelsFor")[0];
    expect(mine).not.toMatch(/mine:\s*roleProcedure\([^)]*\)\s*\.input\(/);
  });
});

describe("the client does not decide access", () => {
  it("keeps the gate model free of any grant of its own", () => {
    // The screen decision (`gateScreen`) replaced the entry model. It may read
    // the workspaces the server said are open; it may never add to them.
    const gate = code("client/src/session/sessionModel.ts");
    expect(gate).not.toMatch(/\b(open|availableWorkspaces)\s*\.\s*(push|concat|unshift|add)\b/);
    // It reaches no network and no storage: a decision that fetched something
    // would be a second, quieter source of truth about access.
    expect(gate).not.toMatch(/\bfetch\s*\(|\btrpc\b|localStorage|sessionStorage/);
    // It enters exactly one way, and what it enters is the server's answer or
    // a route the server's own list was checked for first.
    const enters = [...gate.matchAll(/return\s*\{\s*kind:\s*"ready"/g)].length;
    expect(enters).toBe(1);
    expect(gate).toMatch(/workspace:\s*args\.requestedWorkspace\s*\?\?\s*c\.activeWorkspace/);
    expect(gate).toMatch(/args\.requestedWorkspace\s*&&\s*!open\.has\(args\.requestedWorkspace\)/);
  });

  it("routes the portal shell through the session gate rather than a bare default", () => {
    const shell = code("client/src/portal/PortalShell.tsx");
    // The workspace arrives from SessionGate, which has it from the server.
    expect(shell).toContain("<SessionGate");
    // defaultPortal picked a portal with no reference to what was requested or
    // saved, which is what made the :portal segment decorative.
    expect(shell).not.toMatch(/\bdefaultPortal\s*\(/);
  });
});
