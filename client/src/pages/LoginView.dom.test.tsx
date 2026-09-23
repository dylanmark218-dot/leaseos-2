/**
 * The sign-in landing, rendered.
 *
 * The assertion that matters most is a negative one: there is no credential
 * field anywhere on this screen. LeaseOS authenticates through the platform's
 * OAuth flow, and a password box here would be the visible end of a second
 * authentication system.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

import { LoginView, type LoginReason } from "./LoginView";

const props = (over: Partial<Parameters<typeof LoginView>[0]> = {}) => ({
  reason: "unauthenticated" as LoginReason,
  busy: false,
  onSignIn: vi.fn(),
  ...over,
});

describe("what the sign-in screen is", () => {
  it("collects no credentials", () => {
    const { container } = render(<LoginView {...props()} />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("offers one action, and it starts the existing flow", () => {
    const onSignIn = vi.fn();
    render(<LoginView {...props({ onSignIn })} />);
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("does not start the flow during render", () => {
    // `startLogin()` writes the one-time state cookie as a side effect, so a
    // render-phase call would desync an in-flight login and the callback would
    // reject it as "invalid oauth state".
    const onSignIn = vi.fn();
    render(<LoginView {...props({ onSignIn })} />);
    expect(onSignIn).not.toHaveBeenCalled();
  });
});

describe("why somebody is here", () => {
  it("says the session expired", () => {
    render(<LoginView {...props({ reason: "expired" })} />);
    expect(screen.getByText("Your session has expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says a sign-in did not complete, and that nothing changed", () => {
    render(<LoginView {...props({ reason: "auth_error" })} />);
    expect(screen.getByText("Sign-in did not complete")).toBeTruthy();
    expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
  });

  it("says somebody signed out", () => {
    render(<LoginView {...props({ reason: "signed_out" })} />);
    expect(screen.getByText("You have been signed out")).toBeTruthy();
  });

  it("announces a failure detail to a screen reader rather than only colouring it", () => {
    render(
      <LoginView {...props({ reason: "auth_error", detail: "invalid oauth state" })} />
    );
    expect(screen.getByRole("alert").textContent).toContain("invalid oauth state");
  });

  it("shows no alert on an ordinary first visit, even if a detail is passed", () => {
    render(<LoginView {...props({ reason: "unauthenticated", detail: "ignored" })} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("while a sign-in is in flight", () => {
  it("disables the action and says so", () => {
    render(<LoginView {...props({ busy: true })} />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Signing in");
  });

  it("cannot be clicked twice into two flows", () => {
    const onSignIn = vi.fn();
    render(<LoginView {...props({ busy: true, onSignIn })} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSignIn).not.toHaveBeenCalled();
  });
});
