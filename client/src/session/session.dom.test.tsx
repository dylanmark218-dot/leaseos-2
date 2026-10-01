/**
 * v23.26 — the login, chooser and refusal screens, under jsdom.
 *
 * These are client tests and they prove a client property: that the screen
 * offers exactly what the server sent and nothing else. They prove nothing
 * about authorization, and they are deliberately not written as though they
 * did — the refusal tests live in `server/sessionWorkspace.db.test.ts`, which
 * makes the same calls with no browser involved.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedView } from "./AccessDeniedView";
import { SignInView } from "./SignInView";
import { WorkspaceChooserView } from "./WorkspaceChooserView";
import { gateScreen, intendedLabel, workspaceFromPath, type ClientSessionContext } from "./sessionModel";

afterEach(cleanup);

const context = (over: Partial<ClientSessionContext> = {}): ClientSessionContext =>
  ({
    state: "ready",
    user: { id: 7, name: "Dana Reyes", email: "dana@example.ca" },
    activeOrganization: {
      orgRef: "ORG-A",
      name: "ABC Transport",
      membershipRef: "MEM-A",
      membershipType: "employee",
      branchId: null,
      derivedFrom: "membership",
    },
    availableOrganizations: [],
    availableWorkspaces: [
      { key: "field_workforce", label: "Field Workforce", description: "Perform daily work", landing: "/portal/field_workforce", capabilities: [] },
    ],
    activeWorkspace: "field_workforce",
    workspaceChoiceRequired: false,
    capabilities: [],
    roles: ["driver"],
    reason: null,
    ...over,
  }) as ClientSessionContext;

/* ================================================================== */

describe("the sign-in screen", () => {
  it("offers the deployment's real method and says nothing about who exists", () => {
    const onSelect = vi.fn();
    render(
      <SignInView
        methods={[{ key: "leaseos", label: "Sign in to LeaseOS", detail: "single sign-on", onSelect }]}
        notice="Your session has ended. Sign in to continue."
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to LeaseOS" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sign-in-notice").textContent).toContain("session has ended");
    // No account, organization or role is named anywhere on the screen.
    expect(screen.getByTestId("sign-in").textContent).not.toMatch(/ABC Transport|driver|ORG-/);
  });

  it("announces a failure without saying which half was wrong", () => {
    render(
      <SignInView
        methods={[{ key: "leaseos", label: "Sign in", detail: "sso", onSelect: () => {} }]}
        error="Sign-in could not be completed. Try again."
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("could not be completed");
    expect(alert.textContent).not.toMatch(/password|unknown user|no such account/i);
  });
});

describe("the chooser", () => {
  it("offers exactly the workspaces it was given, and marks the current one without relying on colour (19)", () => {
    const onSelectWorkspace = vi.fn();
    render(
      <WorkspaceChooserView
        displayName="Dana Reyes"
        workspaces={[
          { key: "field_workforce", label: "Field", description: "Driver operations, jobs, routes and paperwork" },
          { key: "fleet_maintenance", label: "Mechanic", description: "Work orders, repairs and vehicle maintenance" },
        ]}
        activeWorkspace="field_workforce"
        onSelectWorkspace={onSelectWorkspace}
      />
    );
    expect(screen.getByTestId("workspace-field_workforce")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-fleet_maintenance")).toBeInTheDocument();
    // Never rendered, so never pressable: the chooser holds no list of its own.
    expect(screen.queryByTestId("workspace-management")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-customer")).not.toBeInTheDocument();
    // The current one is named in the text as well as marked for assistive tech.
    expect(screen.getByTestId("workspace-field_workforce")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("workspace-field_workforce").textContent).toContain("current");

    fireEvent.click(screen.getByTestId("workspace-fleet_maintenance"));
    expect(onSelectWorkspace).toHaveBeenCalledWith("fleet_maintenance");
  });

  it("asks for the organization first when there is more than one, and hides the workspaces until it is answered", () => {
    render(
      <WorkspaceChooserView
        organizations={[
          { orgRef: "ORG-A", name: "ABC Transport", membershipType: "employee" },
          { orgRef: "ORG-B", name: "Northern Hauling", membershipType: "contractor" },
        ]}
        activeOrgRef={null}
        workspaces={[]}
        onSelectWorkspace={() => {}}
      />
    );
    expect(screen.getByTestId("organization-ORG-A")).toBeInTheDocument();
    expect(screen.getByTestId("organization-ORG-B")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-list")).not.toBeInTheDocument();
  });

  it("says so plainly when nothing is open here", () => {
    render(<WorkspaceChooserView workspaces={[]} onSelectWorkspace={() => {}} />);
    expect(screen.getByTestId("workspace-chooser").textContent).toContain("No workspace is open here");
  });
});

describe("the refusal screens", () => {
  it("says what to do and names no record, organization or role", () => {
    render(<AccessDeniedView kind="workspace_not_open" />);
    expect(screen.getByTestId("access-denied-title").textContent).toContain("not open to your account");
    const body = screen.getByTestId("access-denied-body").textContent ?? "";
    expect(body).toMatch(/ask an administrator/i);
    expect(body).not.toMatch(/ORG-|JOB-|management|dispatcher/);
  });

  it("prefers the server's own sentence when it sent one", () => {
    render(<AccessDeniedView kind="no_workspace" reason="No LeaseOS workspace is assigned to you yet." />);
    expect(screen.getByTestId("access-denied-body").textContent).toBe(
      "No LeaseOS workspace is assigned to you yet."
    );
  });

  it("offers a way out of every refusal", () => {
    const onGoToWorkspace = vi.fn();
    render(
      <AccessDeniedView kind="workspace_not_open" onGoToWorkspace={onGoToWorkspace} workspaceLabel="Field" onSignOut={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to Field" }));
    expect(onGoToWorkspace).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("which screen the shell shows", () => {
  it("shows the sign-in screen for an expired session and never the application", () => {
    expect(gateScreen({ context: undefined, error: { code: "UNAUTHORIZED" } })).toMatchObject({
      kind: "signin",
    });
  });

  it("fails closed on any other error, including one it has never seen", () => {
    for (const code of ["INTERNAL_SERVER_ERROR", "TIMEOUT", "SOMETHING_NEW"]) {
      expect(gateScreen({ context: context(), error: { code } })).toMatchObject({
        kind: "denied",
        denial: "authorization_unavailable",
      });
    }
  });

  it("enters directly for one job and asks for two (4, 5)", () => {
    expect(gateScreen({ context: context() })).toEqual({ kind: "ready", workspace: "field_workforce" });
    expect(
      gateScreen({
        context: context({
          workspaceChoiceRequired: true,
          availableWorkspaces: [
            { key: "field_workforce", label: "Field", description: "d", landing: "/portal/field_workforce", capabilities: [] },
            { key: "fleet_maintenance", label: "Mechanic", description: "d", landing: "/portal/fleet_maintenance", capabilities: [] },
          ],
        } as never),
      })
    ).toEqual({ kind: "chooser" });
  });

  it("refuses a route naming a workspace the server did not offer, rather than silently swapping screens (7)", () => {
    expect(gateScreen({ context: context(), requestedWorkspace: "management" })).toMatchObject({
      kind: "denied",
      denial: "workspace_not_open",
    });
  });

  it("renders no application for a state it does not recognize", () => {
    expect(gateScreen({ context: context({ state: "something_else" } as never) })).toMatchObject({
      kind: "denied",
      denial: "authorization_unavailable",
    });
    expect(gateScreen({ context: context({ activeWorkspace: null }) })).toMatchObject({
      kind: "denied",
      denial: "no_workspace",
    });
  });

  it("reads the workspace out of a LeaseOS route and out of nothing else", () => {
    expect(workspaceFromPath("/portal/fleet_maintenance")).toBe("fleet_maintenance");
    expect(workspaceFromPath("/portal/fleet_maintenance/work-orders/123")).toBe("fleet_maintenance");
    expect(workspaceFromPath("/portal")).toBeNull();
    expect(workspaceFromPath("/showcase/fleet")).toBeNull();
    expect(workspaceFromPath("https://evil.example/portal/management")).toBeNull();
  });

  it("shows a destination without echoing an attacker's URL back at the person (17)", () => {
    expect(intendedLabel("/portal/fleet_maintenance")).toContain("/portal/fleet_maintenance");
    expect(intendedLabel("https://evil.example")).toBeNull();
    expect(intendedLabel("/")).toBeNull();
    expect(intendedLabel(null)).toBeNull();
  });
});
