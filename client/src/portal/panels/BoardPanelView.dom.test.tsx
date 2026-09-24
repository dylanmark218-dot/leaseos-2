/**
 * 0182/0183 — the Board view, rendered.
 *
 * What these prove on the screen itself: a message still on the device reads as queued and never
 * as delivered, a refused one is kept and says why, an acknowledgement is asked only of somebody
 * who owes one, the open-work card shows ? for what nothing established, and "Interested" says it
 * takes nothing.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentOpenWork } from "../boardModel";
import { BoardPanelView, type BoardPanelViewProps, type MessageRow } from "./BoardPanelView";

afterEach(cleanup);

const AT = new Date("2026-10-20T14:00:00Z");
const msg = (o: Partial<MessageRow> = {}): MessageRow => ({
  messageRef: "MSG-1", authorLabel: "User 7", mine: false, priority: "normal", body: "KM 42 washed out", deviceCreatedAt: AT, serverReceivedAt: AT,
  requiresAcknowledgement: false, acknowledgedByMe: null, pendingAcknowledgement: null, ...o,
});

const card = presentOpenWork(
  { postRef: "OS-1", title: "Hydrovac operator", status: "open", requiredRole: "driver", requiredQualifications: ["H2S", "First Aid"], requiredEquipmentClass: null,
    location: "Hinton area", regionCode: "HINTON", startsAt: new Date("2026-10-21T06:00:00Z"), endsAt: new Date("2026-10-21T18:00:00Z"), estimatedHours: 12, overtime: true, priority: "normal" },
  { verdict: "unknown", reasons: [{ code: "qualification_unknown", detail: "No First Aid on record — unknown is not satisfied" }], availability: "available", interestExpressed: false, readinessNotEvaluated: ["route restrictions"] },
  null,
);

export function boardProps(o: Partial<BoardPanelViewProps> = {}): BoardPanelViewProps {
  const channels = [{ channelRef: "CH-D", type: "dispatch", name: "Dispatch — North", unacknowledged: 0 }, { channelRef: "CH-S", type: "safety", name: "Safety", unacknowledged: 1 }];
  return {
    online: true, durableQueue: true, tab: "dispatch", onTab: () => {},
    channels: { kind: "loaded", value: channels }, visibleChannels: channels.slice(0, 1), selectedChannel: "CH-D", onSelectChannel: () => {},
    messages: { kind: "loaded", value: [msg()] }, pendingMessages: [], onSend: () => {}, onAcknowledge: () => {},
    work: { kind: "loaded", value: [{ postRef: "OS-1", title: "Hydrovac operator", requiredRole: "driver", startsAt: new Date("2026-10-21T06:00:00Z"), place: "Hinton area", overtime: true, myResponse: null }] },
    selectedPost: null, onSelectPost: () => {}, card: { kind: "none" }, myResponse: null, pendingResponse: null, onRespond: () => {},
    offerAnswer: { kind: "idle" }, onAnswerOffer: () => {}, queueSummary: { waiting: 0, refused: 0 }, onRetry: () => {},
    ...o,
  };
}

describe("a message on the device is not a message delivered", () => {
  it("shows a queued message apart from the server's, as queued, and never as delivered", () => {
    render(<BoardPanelView {...boardProps({ online: false, pendingMessages: [{ localId: "L-1", body: "Leaving the lease now", state: "queued", lastError: null, capturedAt: AT }], queueSummary: { waiting: 1, refused: 0 } })} />);
    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(within(conversation).getByText("Leaving the lease now")).toBeInTheDocument();
    expect(within(conversation).getByText("Queued on this device — not sent")).toBeInTheDocument();
    expect(conversation.textContent).not.toMatch(/deliver/i);
    expect(screen.getByText(/Offline — what you send is kept on this device/)).toBeInTheDocument();
    expect(screen.getByText(/1 waiting on this device/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue to send" })).toBeInTheDocument();
  });

  it("keeps a refused message and says why", () => {
    render(<BoardPanelView {...boardProps({ pendingMessages: [{ localId: "L-2", body: "hello?", state: "failed", lastError: "FORBIDDEN: Not a member of this channel", capturedAt: AT }], queueSummary: { waiting: 0, refused: 1 } })} />);
    expect(screen.getByText("Not sent — refused, kept on this device")).toBeInTheDocument();
    expect(screen.getByText("FORBIDDEN: Not a member of this channel")).toBeInTheDocument();
    expect(screen.getByText(/1 refused by the server and kept/)).toBeInTheDocument();
  });

  it("says the browser queue lasts only while the page is open when there is no native shell", () => {
    render(<BoardPanelView {...boardProps({ online: false, durableQueue: false })} />);
    expect(screen.getByText(/only while this page is open/)).toBeInTheDocument();
  });

  it("sends the composed text and clears the box", () => {
    const onSend = vi.fn();
    render(<BoardPanelView {...boardProps({ onSend })} />);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "  On site at 06:10  " } });
    fireEvent.click(screen.getByLabelText("Important"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("On site at 06:10", "important");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
});

describe("acknowledgement is asked only of somebody who owes one", () => {
  it("offers Acknowledge to a recipient who has not, shows the queued acknowledgement instead once tapped, and thanks nobody outside the audience", () => {
    const onAcknowledge = vi.fn();
    const { rerender } = render(<BoardPanelView {...boardProps({ onAcknowledge, messages: { kind: "loaded", value: [msg({ priority: "urgent", requiresAcknowledgement: true, acknowledgedByMe: false })] } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(onAcknowledge).toHaveBeenCalledWith("MSG-1");
    rerender(<BoardPanelView {...boardProps({ messages: { kind: "loaded", value: [msg({ priority: "urgent", requiresAcknowledgement: true, acknowledgedByMe: false, pendingAcknowledgement: "queued" })] } })} />);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByText("Queued on this device — not sent")).toBeInTheDocument();
    rerender(<BoardPanelView {...boardProps({ messages: { kind: "loaded", value: [msg({ requiresAcknowledgement: true, acknowledgedByMe: null })] } })} />);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.queryByText("You acknowledged this.")).toBeNull();
  });

  it("counts a bulletin waiting on you on its tab", () => {
    render(<BoardPanelView {...boardProps()} />);
    expect(screen.getByRole("button", { name: /Safety · 1/ })).toBeInTheDocument();
  });
});

describe("the open-work card", () => {
  it("shows ? for a ticket nobody recorded and for a capability nobody evaluated, and responding says it takes nothing", () => {
    const onRespond = vi.fn();
    render(<BoardPanelView {...boardProps({ tab: "open_work", selectedPost: "OS-1", card: { kind: "loaded", value: card }, onRespond })} />);
    const post = screen.getByRole("region", { name: "Post" });
    const first = within(post).getByText("First Aid").closest("li")!;
    expect(first.textContent).toContain("?");
    expect(first.textContent).toContain("not established");
    expect(within(post).getByText("H2S").closest("li")!.textContent).toContain("✓");
    expect(within(post).getByText("route restrictions").closest("li")!.textContent).toContain("?");
    expect(within(post).getByText(/Dispatch gives the work/)).toBeInTheDocument();
    fireEvent.click(within(post).getByRole("button", { name: "Interested" }));
    expect(onRespond).toHaveBeenCalledWith("OS-1", "interested");
  });

  it("shows an answer still on the device with its state", () => {
    render(<BoardPanelView {...boardProps({ tab: "open_work", selectedPost: "OS-1", card: { kind: "loaded", value: card }, pendingResponse: { response: "interested", state: "queued", lastError: null } })} />);
    expect(screen.getByText(/Your answer \(interested\)/)).toBeInTheDocument();
    expect(screen.getByText("Queued on this device — not sent")).toBeInTheDocument();
  });

  it("disables answering an offer without a connection and says so", () => {
    const offered = { ...card, offer: { offerRef: "OFF-1", label: "Offered to you — accept or decline", answerable: true } };
    render(<BoardPanelView {...boardProps({ online: false, tab: "open_work", selectedPost: "OS-1", card: { kind: "loaded", value: offered } })} />);
    expect(screen.getByRole("button", { name: "Accept offer" })).toBeDisabled();
    expect(screen.getByText("Answering an offer needs a connection.")).toBeInTheDocument();
  });
});
