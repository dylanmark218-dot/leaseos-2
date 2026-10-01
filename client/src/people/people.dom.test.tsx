/**
 * B23.2 — the People & Access screen, under jsdom.
 *
 * What this file is for and what it is NOT for.
 *
 * It checks that the screen renders what the server sent, offers only the
 * controls that make sense, and says scope out loud where scope matters — that
 * removing access names the organization rather than the person, that a role
 * list comes from the server's catalogue, that a workspace preview follows the
 * ticks.
 *
 * It is not an authorization test. Nothing here proves anybody may do anything:
 * `peopleAccess.db.test.ts` asks those questions through the real server with no
 * client in the path, and it would still refuse if every control on this screen
 * were re-enabled by hand.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleAccessView, type PeopleAccessViewProps, type RoleOption } from "./PeopleAccessView";
import {
  defaultWorkspaceChoices,
  invitationTone,
  partitionPeople,
  rolesChanged,
  sectionCount,
  shortDate,
  sortInvitations,
  type InvitationRow,
  type PersonRow,
} from "./peopleModel";

afterEach(cleanup);

const CATALOGUE: RoleOption[] = [
  { role: "driver", description: "Field jobs, trips and field paperwork.", workspaces: [{ key: "field_workforce", label: "Field Workforce" }] },
  { role: "mechanic", description: "Maintenance work and work orders.", workspaces: [{ key: "fleet_maintenance", label: "Fleet Maintenance" }] },
  { role: "management", description: "Organization administration.", workspaces: [{ key: "management", label: "Management" }] },
];

const dylan: PersonRow = {
  userId: 123,
  displayName: "Dylan Hutchings",
  membershipStatus: "active",
  membershipType: "employee",
  roles: ["driver"],
  workspaces: ["field_workforce"],
  defaultWorkspace: "field_workforce",
  effectiveFrom: "2026-01-04T00:00:00Z",
  effectiveTo: null,
  live: true,
};

const gone: PersonRow = {
  ...dylan,
  userId: 456,
  displayName: "Former Person",
  membershipStatus: "ended",
  roles: [],
  workspaces: [],
  live: false,
  effectiveTo: "2026-08-01T00:00:00Z",
};

const props = (over: Partial<PeopleAccessViewProps> = {}): PeopleAccessViewProps => ({
  organizationName: "ABC Transport",
  people: [dylan, gone],
  invitations: [],
  needsResolution: [],
  roleCatalogue: CATALOGUE,
  ...over,
});

describe("Active People", () => {
  it("lists live members and keeps former ones out of the active section", () => {
    render(<PeopleAccessView {...props()} />);
    expect(screen.getAllByText("Dylan Hutchings").length).toBeGreaterThan(0);
    expect(screen.queryByText("Former Person")).toBeNull();
  });

  it("names the organization, so nobody mistakes this for a global user list", () => {
    render(<PeopleAccessView {...props()} />);
    expect(screen.getByRole("heading", { name: /People & Access/i })).toBeTruthy();
    expect(screen.getByText(/ABC Transport/)).toBeTruthy();
    expect(screen.getByText(/apply to this organization only/i)).toBeTruthy();
  });

  it("shows the roles and workspaces the server sent, and invents neither", () => {
    render(<PeopleAccessView {...props()} />);
    // Rendered twice by design (table on wide screens, cards on phones).
    expect(screen.getAllByText("driver").length).toBeGreaterThan(0);
    expect(screen.getAllByText("field_workforce").length).toBeGreaterThan(0);
  });

  it("says so plainly when nobody has joined yet", () => {
    render(<PeopleAccessView {...props({ people: [] })} />);
    expect(screen.getByText(/Nobody has accepted an invitation yet/i)).toBeTruthy();
  });

  it("moves between sections with the arrow keys, as a tab set should", () => {
    const onSection = vi.fn();
    render(<PeopleAccessView {...props({ onSection })} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onSection).toHaveBeenCalledWith("invitations");
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(onSection).toHaveBeenCalledWith("former");
  });

  it("puts former people in their own section with the date access ended", () => {
    render(<PeopleAccessView {...props({ section: "former" })} />);
    expect(screen.getAllByText("Former Person").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-08-01").length).toBeGreaterThan(0);
  });
});

describe("Person detail", () => {
  const selected = { person: dylan, workspaceOptions: [{ key: "field_workforce", label: "Field Workforce" }] };

  it("builds the role controls from the server catalogue, with a description each", () => {
    render(<PeopleAccessView {...props({ selected })} />);
    const region = screen.getByRole("region", { name: "Dylan Hutchings" });
    for (const r of CATALOGUE) {
      const box = within(region).getByRole("checkbox", { name: new RegExp(r.role) });
      expect(box).toBeTruthy();
      expect(within(region).getByText(r.description)).toBeTruthy();
    }
    // Ticked for what they hold, clear for what they do not.
    expect((within(region).getByRole("checkbox", { name: /driver/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(region).getByRole("checkbox", { name: /management/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps Save disabled until the selection actually differs", () => {
    render(<PeopleAccessView {...props({ selected })} />);
    const region = screen.getByRole("region", { name: "Dylan Hutchings" });
    const save = within(region).getByRole("button", { name: /Save access/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(region).getByRole("checkbox", { name: /mechanic/ }));
    expect((within(region).getByRole("button", { name: /Save access/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("previews the workspaces the ticked roles open, and updates as they change", () => {
    render(<PeopleAccessView {...props({ selected })} />);
    const region = screen.getByRole("region", { name: "Dylan Hutchings" });
    // The preview specifically, not the <option> of the same name in the
    // default-workspace select.
    const preview = () => within(region).getByText("Resulting workspaces").parentElement!.querySelector("[aria-live]")!;
    expect(preview().textContent).toContain("Field Workforce");
    fireEvent.click(within(region).getByRole("checkbox", { name: /mechanic/ }));
    expect(preview().textContent).toContain("Fleet Maintenance");
    // Untick everything and the screen says what that means rather than going blank.
    fireEvent.click(within(region).getByRole("checkbox", { name: /driver/ }));
    fireEvent.click(within(region).getByRole("checkbox", { name: /mechanic/ }));
    expect(within(region).getByText(/no workspace/i)).toBeTruthy();
  });

  it("sends the selection the administrator made, not the one they started with", () => {
    const onSaveRoles = vi.fn();
    render(<PeopleAccessView {...props({ selected, onSaveRoles })} />);
    const region = screen.getByRole("region", { name: "Dylan Hutchings" });
    fireEvent.click(within(region).getByRole("checkbox", { name: /mechanic/ }));
    fireEvent.click(within(region).getByRole("button", { name: /Save access/i }));
    expect(onSaveRoles).toHaveBeenCalledWith(123, ["driver", "mechanic"]);
  });

  it("offers only workspaces the person holds as a landing page, plus no preference", () => {
    render(<PeopleAccessView {...props({ selected })} />);
    const select = screen.getByLabelText(/Default workspace/i) as HTMLSelectElement;
    const options = Array.from(select.options).map(o => o.textContent);
    expect(options).toEqual(["No preference", "Field Workforce"]);
    expect(options).not.toContain("Management");
  });

  it("asks before removing access, and names the organization rather than the person", () => {
    const onRemoveAccess = vi.fn();
    render(<PeopleAccessView {...props({ selected, onRemoveAccess })} />);
    const region = screen.getByRole("region", { name: "Dylan Hutchings" });
    // The heading is about the relationship, never "delete Dylan" — the account
    // may belong to another employer.
    expect(within(region).getByText(/Remove access to ABC Transport/i)).toBeTruthy();
    expect(within(region).getByText(/LeaseOS account and any access at another employer are untouched/i)).toBeTruthy();
    expect(region.textContent).not.toMatch(/delete/i);

    fireEvent.click(within(region).getByRole("button", { name: /Remove access/i }));
    expect(onRemoveAccess).not.toHaveBeenCalled();
    fireEvent.click(within(region).getByRole("button", { name: /Yes, remove .* access to ABC Transport/i }));
    expect(onRemoveAccess).toHaveBeenCalledWith(123);
  });

  it("says when a membership is not live, rather than drawing it as normal", () => {
    render(<PeopleAccessView {...props({ selected: { person: gone, workspaceOptions: [] } })} />);
    expect(screen.getByText(/cannot work for this organization/i)).toBeTruthy();
  });
});

describe("Pending invitations", () => {
  const invitations: InvitationRow[] = [
    { invitationRef: "INV-1", emailHint: "new@example.test", displayNameHint: "R. Cardinal", roles: ["driver"], view: "pending", expiresAt: "2027-10-01T00:00:00Z", invitedAt: "2026-01-02T00:00:00Z" },
    { invitationRef: "INV-2", emailHint: "old@example.test", displayNameHint: null, roles: ["office"], view: "expired", expiresAt: "2026-01-01T00:00:00Z", invitedAt: "2026-08-01T00:00:00Z" },
  ];

  it("explains that the email is a label and not the thing that proves identity", () => {
    render(<PeopleAccessView {...props({ section: "invitations", invitations })} />);
    expect(screen.getByText(/claimed with the link and a LeaseOS sign-in, not/i)).toBeTruthy();
  });

  it("refuses to send with no role chosen", () => {
    render(<PeopleAccessView {...props({ section: "invitations" })} />);
    expect((screen.getByRole("button", { name: /Send invitation/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /driver/ }));
    expect((screen.getByRole("button", { name: /Send invitation/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends what was typed", () => {
    const onInvite = vi.fn();
    render(<PeopleAccessView {...props({ section: "invitations", onInvite })} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "R. Cardinal" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /driver/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));
    expect(onInvite).toHaveBeenCalledWith({ email: "new@example.test", displayName: "R. Cardinal", roles: ["driver"] });
  });

  it("shows the link once, and says it is not stored", () => {
    render(<PeopleAccessView {...props({ section: "invitations", issuedLink: { invitationRef: "INV-1", token: "tok_abc123" } })} />);
    expect(screen.getByText(/shown once and is not stored/i)).toBeTruthy();
    expect(screen.getByText(/tok_abc123/)).toBeTruthy();
    // It also says plainly that nothing was emailed, because nothing was.
    expect(screen.getByText(/LeaseOS does not send email/i)).toBeTruthy();
  });

  it("offers Cancel on a pending invitation and not on a dead one", () => {
    const onCancelInvitation = vi.fn();
    render(<PeopleAccessView {...props({ section: "invitations", invitations, onCancelInvitation })} />);
    const buttons = screen.getAllByRole("button", { name: /Cancel invitation/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onCancelInvitation).toHaveBeenCalledWith("INV-1");
  });

  it("states each invitation's condition in words, not only in colour", () => {
    render(<PeopleAccessView {...props({ section: "invitations", invitations })} />);
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
  });
});

describe("Access needs resolution", () => {
  const rows = [{ legacyGrantId: 88, userId: 123, displayName: "Dylan Hutchings", role: "mechanic", grantedAt: "2025-03-02T00:00:00Z" }];

  it("says the grant authorizes nothing, and offers one deliberate re-issue", () => {
    const onResolve = vi.fn();
    render(<PeopleAccessView {...props({ section: "resolution", needsResolution: rows, onResolve })} />);
    expect(screen.getByText(/authorize nothing until you re-issue them/i)).toBeTruthy();
    expect(screen.getByText(/authorizes nothing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Re-issue mechanic here/i }));
    expect(onResolve).toHaveBeenCalledWith(88);
  });

  it("offers no bulk action, because attribution is the thing that was unsafe", () => {
    render(<PeopleAccessView {...props({ section: "resolution", needsResolution: rows })} />);
    expect(screen.queryByRole("button", { name: /resolve all/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Re-issue/i })).toHaveLength(1);
  });

  it("says nothing is waiting when nothing is", () => {
    render(<PeopleAccessView {...props({ section: "resolution" })} />);
    expect(screen.getByText(/Nothing needs resolution/i)).toBeTruthy();
  });
});

describe("errors", () => {
  it("shows the server's own refusal, as an alert", () => {
    render(<PeopleAccessView {...props({ error: "This is the last management access in ABC Transport." })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/last management access/i);
  });
});

describe("the view model decides nothing an administrator could be surprised by", () => {
  it("splits live from former, and counts each section", () => {
    const { active, former } = partitionPeople([dylan, gone]);
    expect(active.map(p => p.userId)).toEqual([123]);
    expect(former.map(p => p.userId)).toEqual([456]);
    const counts = { active: 1, former: 1, pendingInvitations: 2, resolution: 0 };
    expect(sectionCount("active", counts)).toBe(1);
    expect(sectionCount("invitations", counts)).toBe(2);
    // Zero is information, not an absence to hide.
    expect(sectionCount("resolution", counts)).toBe(0);
  });

  it("treats a reordered role list as unchanged", () => {
    expect(rolesChanged(["driver", "mechanic"], ["mechanic", "driver"])).toBe(false);
    expect(rolesChanged(["driver"], ["driver", "mechanic"])).toBe(true);
    expect(rolesChanged(["driver"], [])).toBe(true);
  });

  it("puts the invitations that need action first", () => {
    const rows: InvitationRow[] = [
      { invitationRef: "a", emailHint: null, displayNameHint: null, roles: [], view: "accepted", expiresAt: "", invitedAt: "" },
      { invitationRef: "b", emailHint: null, displayNameHint: null, roles: [], view: "pending", expiresAt: "", invitedAt: "" },
      { invitationRef: "c", emailHint: null, displayNameHint: null, roles: [], view: "expired", expiresAt: "", invitedAt: "" },
    ];
    expect(sortInvitations(rows).map(r => r.view)).toEqual(["pending", "expired", "accepted"]);
  });

  it("always offers 'no preference' alongside the real workspaces", () => {
    expect(defaultWorkspaceChoices([{ key: "field_workforce", label: "Field" }])).toEqual([
      { key: null, label: "No preference" },
      { key: "field_workforce", label: "Field" },
    ]);
  });

  it("pairs every invitation state with a word", () => {
    for (const view of ["pending", "accepted", "cancelled", "expired"] as const) {
      expect(invitationTone(view).label.length).toBeGreaterThan(3);
    }
  });

  it("renders a missing date as an em dash rather than Invalid Date", () => {
    expect(shortDate(null)).toBe("—");
    expect(shortDate("not a date")).toBe("—");
    expect(shortDate("2026-08-01T00:00:00Z")).toBe("2026-08-01");
  });
});
