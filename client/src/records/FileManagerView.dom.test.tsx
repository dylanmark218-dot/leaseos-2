/**
 * The Records & File Manager screen, rendered.
 *
 * What matters: the screen offers no way to edit evidence, a folder change and
 * a selection are the user's acts and nothing else, integrity failure is said
 * rather than drawn as progress, and access history that was withheld says so.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManagerView } from "./FileManagerView";
import { counts, detail, fileManagerProps, row } from "../test/fileManagerFixtures";

afterEach(cleanup);

describe("the file manager offers no way to edit evidence", () => {
  it("has no edit control, and says how a correction is made", () => {
    render(<FileManagerView {...fileManagerProps()} />);
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.getByText(/never edited/i)).toBeInTheDocument();
  });
});

describe("folders and selection", () => {
  it("marks the current folder and reports the choice", () => {
    const onFolder = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onFolder })} />);
    const nav = screen.getByRole("navigation", { name: "Folders" });
    expect(within(nav).getByRole("button", { name: /All records/ })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: /Legal hold/ }));
    expect(onFolder).toHaveBeenCalledWith("legal_hold");
  });

  it("selects a record by its row", () => {
    const onSelect = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onSelect })} />);
    fireEvent.click(screen.getByRole("button", { name: /Site photo/ }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("explains an empty folder by the caller's reach", () => {
    render(<FileManagerView {...fileManagerProps({ folder: "billing", list: { kind: "loaded", rows: [], counts, truncated: false, reach: { categories: [], own: true, canVerify: false } } })} />);
    expect(screen.getByText("No records in billing that you can see.")).toBeInTheDocument();
    expect(screen.getByText("Showing your own records.")).toBeInTheDocument();
  });

  it("says when the window was cut", () => {
    render(<FileManagerView {...fileManagerProps({ list: { kind: "loaded", rows: [row()], counts, truncated: true, reach: { categories: [], own: true, canVerify: false } } })} />);
    expect(screen.getByText(/Only the 500 most recent/)).toBeInTheDocument();
  });

  it("shows why a search matched", () => {
    render(<FileManagerView {...fileManagerProps({ list: { kind: "loaded", rows: [row({ matchReasons: ['related unit matches "trk-27"'] })], counts, truncated: false, reach: { categories: [], own: true, canVerify: false } } })} />);
    expect(screen.getByText(/Matched: related unit matches "trk-27"/)).toBeInTheDocument();
  });
});

describe("the inspector", () => {
  it("downloads the current version, and any stored earlier one", () => {
    const onDownload = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onDownload })} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Download v1" }));
    expect(onDownload).toHaveBeenLastCalledWith(1, 1);
  });

  it("offers verification only when the server says it may", () => {
    const { rerender } = render(<FileManagerView {...fileManagerProps()} />);
    expect(screen.queryByRole("button", { name: "Mark verified" })).toBeNull();
    const onVerify = vi.fn();
    rerender(<FileManagerView {...fileManagerProps({ onVerify, detail: { kind: "loaded", detail: detail({ status: "needs_review", actions: { download: true, verify: true, amend: true } }) } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark verified" }));
    expect(onVerify).toHaveBeenCalledWith(1);
  });

  it("states an integrity failure instead of drawing progress", () => {
    render(<FileManagerView {...fileManagerProps({ detail: { kind: "loaded", detail: detail({ lifecycle: "integrity_failed" }) } })} />);
    expect(screen.getByText(/could not reproduce this record's hash/)).toBeInTheDocument();
  });

  it("names withheld access history", () => {
    render(<FileManagerView {...fileManagerProps({ detail: { kind: "loaded", detail: detail({ accessHistory: null }) } })} />);
    expect(screen.getByText(/Withheld/)).toBeInTheDocument();
  });

  it("does not assert statutory compliance", () => {
    render(<FileManagerView {...fileManagerProps()} />);
    expect(screen.getByText("not asserted")).toBeInTheDocument();
  });

  it("disables download for a metadata-only record", () => {
    render(<FileManagerView {...fileManagerProps({ detail: { kind: "loaded", detail: detail({ actions: { download: false, verify: false, amend: false }, versions: [] }) } })} />);
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(screen.getByText(/metadata only/)).toBeInTheDocument();
  });

  it("reports a refused read as an alert", () => {
    render(<FileManagerView {...fileManagerProps({ detail: { kind: "failed", message: "Record 1 not found" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Record 1 not found");
  });
});
