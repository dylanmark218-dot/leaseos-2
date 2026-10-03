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
import { mergePages } from "./fileViewModels";
import type { ListState } from "./FileManagerView";

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
    render(<FileManagerView {...fileManagerProps({ folder: "billing", list: { kind: "loaded", rows: [], counts, hasMore: false, loadingMore: false, loadMoreError: null, reach: { categories: [], own: true, canVerify: false } } })} />);
    expect(screen.getByText("No records in billing that you can see.")).toBeInTheDocument();
    expect(screen.getByText("Showing your own records.")).toBeInTheDocument();
  });

  it("shows why a search matched", () => {
    render(<FileManagerView {...fileManagerProps({ list: { kind: "loaded", rows: [row({ matchReasons: ['related unit matches "trk-27"'] })], counts, hasMore: false, loadingMore: false, loadMoreError: null, reach: { categories: [], own: true, canVerify: false } } })} />);
    expect(screen.getByText(/Matched: related unit matches "trk-27"/)).toBeInTheDocument();
  });
});

describe("load more", () => {
  const page = (o: Partial<Extract<ListState, { kind: "loaded" }>> = {}): ListState => ({
    kind: "loaded", rows: [row(), row({ id: 2, title: "Site photo" })], counts, reach: { categories: [], own: true, canVerify: false },
    hasMore: true, loadingMore: false, loadMoreError: null, ...o,
  });

  it("offers no control when the server has nothing more", () => {
    render(<FileManagerView {...fileManagerProps({ list: page({ hasMore: false }) })} />);
    expect(screen.queryByRole("button", { name: /load more|try again/i })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 records.");
  });

  it("asks for the next page, and says more are available", () => {
    const onLoadMore = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onLoadMore, list: page() })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 records; more are available.");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed twice while a page is loading", () => {
    const onLoadMore = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onLoadMore, list: page({ loadingMore: true }) })} />);
    const b = screen.getByRole("button", { name: "Loading more…" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
    fireEvent.click(b);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("keeps the rows it has when the next page fails, and offers a retry", () => {
    const onLoadMore = vi.fn();
    render(<FileManagerView {...fileManagerProps({ onLoadMore, list: page({ loadMoreError: "Network unreachable" }) })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("More records could not be loaded: Network unreachable");
    expect(screen.getByRole("button", { name: /Site photo/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("renders a row that arrived twice only once, where it first appeared", () => {
    const merged = mergePages([
      { records: [row({ id: 3, title: "Third" }), row({ id: 2, title: "Second" })] },
      { records: [row({ id: 2, title: "Second again" }), row({ id: 1, title: "First" })] },
    ]);
    expect(merged.map(r => [r.id, r.title])).toEqual([[3, "Third"], [2, "Second"], [1, "First"]]);
    render(<FileManagerView {...fileManagerProps({ selectedId: null, detail: { kind: "none" }, list: page({ rows: merged, hasMore: false }) })} />);
    expect(screen.getAllByRole("button", { name: /Second/ })).toHaveLength(1);
  });

  it("keeps the folder list usable before counts arrive", () => {
    render(<FileManagerView {...fileManagerProps({ list: page({ counts: null }) })} />);
    expect(within(screen.getByRole("navigation", { name: "Folders" })).getByRole("button", { name: "All records" })).toBeInTheDocument();
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
