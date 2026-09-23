/**
 * The chooser and its neighbouring states, rendered.
 *
 * Every option here comes from props, and the props come from `portals.mine`.
 * The assertions worth making are therefore about what the screen does with the
 * server's answer — never about a list this file keeps.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

import {
  NoPortalAvailable,
  OrganizationSelectionRequired,
  PortalChooser,
  type ChooserOption,
} from "./PortalChooser";

const option = (portal: string, displayName: string): ChooserOption => ({
  portal,
  displayName,
  purpose: `what ${displayName} is for`,
});

const held = [
  option("field_workforce", "Field Workforce"),
  option("fleet_maintenance", "Fleet Maintenance"),
];

describe("the chooser", () => {
  it("offers exactly what it was given, with each portal's own purpose", () => {
    render(<PortalChooser options={held} onChoose={vi.fn()} />);
    expect(screen.getByText("Field Workforce")).toBeTruthy();
    expect(screen.getByText("Fleet Maintenance")).toBeTruthy();
    expect(screen.getByText("what Field Workforce is for")).toBeTruthy();
  });

  it("offers nothing the server did not list", () => {
    render(<PortalChooser options={held} onChoose={vi.fn()} />);
    expect(screen.queryByText("Administration")).toBeNull();
    expect(screen.queryByText("Executive")).toBeNull();
  });

  it("reports the portal key, not the label, when one is chosen", () => {
    // The key is what the route and the server understand. A label would be a
    // second identifier that translation or a rename could break.
    const onChoose = vi.fn();
    render(<PortalChooser options={held} onChoose={onChoose} />);
    fireEvent.click(screen.getByText("Fleet Maintenance"));
    expect(onChoose).toHaveBeenCalledWith("fleet_maintenance");
  });

  it("says when a link pointed at a workspace this session does not hold", () => {
    render(
      <PortalChooser options={held} rejectedRequest="executive" onChoose={vi.fn()} />
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("do not have access");
    // The refused key is not echoed back into the page.
    expect(alert.textContent).not.toContain("executive");
  });

  it("says when a saved preference was declined", () => {
    render(
      <PortalChooser options={held} rejectedDefault="executive" onChoose={vi.fn()} />
    );
    expect(screen.getByRole("status").textContent).toContain("no longer available");
  });

  it("says neither when there is nothing to say", () => {
    render(<PortalChooser options={held} onChoose={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the workspaces this session does not reach rather than leaving a gap", () => {
    render(
      <PortalChooser
        options={held}
        notReached={[option("safety_compliance", "Safety and Compliance")]}
        onChoose={vi.fn()}
      />
    );
    expect(screen.getByText("Safety and Compliance")).toBeTruthy();
  });

  it("gives every option a real button, so a keyboard reaches all of them", () => {
    render(<PortalChooser options={held} onChoose={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(held.length);
  });
});

describe("a session with no workspace", () => {
  it("says so and does not offer one", () => {
    render(<NoPortalAvailable />);
    expect(screen.getByText("No workspace available")).toBeTruthy();
    expect(screen.queryByText("Field Workforce")).toBeNull();
  });

  it("offers a way out when one is supplied", () => {
    const onSignOut = vi.fn();
    render(<NoPortalAvailable onSignOut={onSignOut} />);
    fireEvent.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe("two live organization memberships", () => {
  it("says selection is required without pretending switching exists", () => {
    render(<OrganizationSelectionRequired detail="member of 2 organizations" />);
    expect(screen.getByText("Organization selection required")).toBeTruthy();
    expect(screen.getByText(/does not yet support choosing between them/)).toBeTruthy();
    // No control that would imply a choice can be made here.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
