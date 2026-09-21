// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B26 — the picker, rendered, with offers from the real authorization path.
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddWidgetPicker } from "./AddWidgetPicker";
import { listOfferable } from "../../../server/_core/widgetService";
import type { RoleActor } from "../../../server/_core/roleActor";
import axe from "axe-core";

afterEach(cleanup);

const DRIVER: RoleActor = {
  userId: 77, tenantId: "ORG-A", roleKey: "DRIVER", roles: ["DRIVER"],
  permissions: ["widgets.read", "myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "sync.push_own", "trip.read", "readiness.read", "compliance.read"],
};
const DISPATCHER: RoleActor = {
  userId: 77, tenantId: "ORG-A", roleKey: "DISPATCHER", roles: ["DISPATCHER"],
  permissions: ["widgets.read", "myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "surface.exceptions.read", "dispatch.read", "job.read"],
};

const offersFor = (a: RoleActor) => listOfferable(a);

describe("the picker shows only what the server offered", () => {
  it("a DRIVER sees HOS and not the Exception Centre", () => {
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.getByText("Hours Remaining")).toBeInTheDocument();
    expect(screen.queryByText("Exception Centre")).toBeNull();
  });

  it("the same account in DISPATCHER mode sees the Exception Centre and not HOS", () => {
    render(<AddWidgetPicker offers={offersFor(DISPATCHER)} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.getByText("Exception Centre")).toBeInTheDocument();
    expect(screen.queryByText("Hours Remaining")).toBeNull();
  });

  it("cannot render a widget the offers do not contain, whatever the client knows", () => {
    // The component takes offers, not the registry. There is no prop that
    // would let a client reintroduce a withheld widget.
    render(<AddWidgetPicker offers={[]} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.getByText(/no widgets match/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^add /i })).toBeNull();
  });

  it("drops a widget from the list once the role loses its permission", () => {
    const { rerender } = render(<AddWidgetPicker offers={offersFor(DISPATCHER)} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.getByText("Exception Centre")).toBeInTheDocument();
    const revoked = { ...DISPATCHER, permissions: DISPATCHER.permissions.filter((p) => p !== "surface.exceptions.read") };
    rerender(<AddWidgetPicker offers={offersFor(revoked)} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.queryByText("Exception Centre")).toBeNull();
  });
});

describe("finding a widget", () => {
  it("filters by search text", async () => {
    const user = userEvent.setup();
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={() => {}} />);
    await user.type(screen.getByRole("searchbox", { name: /search widgets/i }), "hours");
    expect(screen.getByText("Hours Remaining")).toBeInTheDocument();
    expect(screen.queryByText("Sync Status")).toBeNull();
  });

  it("filters by category", async () => {
    const user = userEvent.setup();
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={() => {}} />);
    await user.click(screen.getByRole("button", { name: "HOS" }));
    expect(screen.getByText("Hours Remaining")).toBeInTheDocument();
    expect(screen.queryByText("Sync Status")).toBeNull();
  });

  it("marks recommended widgets for the acting role", () => {
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={() => {}} />);
    expect(screen.getAllByText("Recommended").length).toBeGreaterThan(0);
  });

  it("says a widget is already on the board instead of hiding it", () => {
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={["hosRemaining"]} onAdd={() => {}} />);
    expect(screen.getByText(/already on this board/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add hours remaining/i })).toBeInTheDocument();
  });
});

describe("adding", () => {
  it("adds with the widget's default variant", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={onAdd} />);
    await user.click(screen.getByRole("button", { name: /add hours remaining/i }));
    expect(onAdd).toHaveBeenCalledWith("hosRemaining", "gauge");
  });

  it("adds with a chosen variant", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={onAdd} />);
    await user.selectOptions(screen.getByRole("combobox", { name: /how to draw hours remaining/i }), "countdown");
    await user.click(screen.getByRole("button", { name: /add hours remaining/i }));
    expect(onAdd).toHaveBeenCalledWith("hosRemaining", "countdown");
  });
});

describe("accessibility", () => {
  it("reports no axe violations", async () => {
    const { container } = render(
      <AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={["hosRemaining"]} onAdd={() => {}} onClose={() => {}} />,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("is reachable by keyboard, in order", async () => {
    const user = userEvent.setup();
    render(<AddWidgetPicker offers={offersFor(DRIVER)} alreadyAdded={[]} onAdd={() => {}} onClose={() => {}} />);
    await user.tab();
    expect(screen.getByRole("button", { name: /close the widget picker/i })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("searchbox", { name: /search widgets/i })).toHaveFocus();
  });
});
