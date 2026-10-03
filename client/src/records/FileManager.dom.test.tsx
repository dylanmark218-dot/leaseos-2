/**
 * The File Manager container against the paged contract.
 *
 * Driven through the real tRPC React client with a terminating link standing
 * in for the server, so what is asserted is what the container actually
 * sends: the first page on mount with no cursor, the server's cursor on
 * "Load more", and no cursor at all once the folder or search changes.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { afterEach, describe, expect, it } from "vitest";
import { trpc } from "@/lib/trpc";
import FileManager from "./FileManager";
import { counts, row } from "../test/fileManagerFixtures";

afterEach(cleanup);

type ListInput = { folder: string; query: string; limit: number; cursor?: string | null };

function serve(pages: (input: ListInput) => unknown) {
  const calls: ListInput[] = [];
  const client = trpc.createClient({
    links: [
      () => ({ op }) =>
        observable(observer => {
          if (op.path === "records.files.list") {
            calls.push(op.input as ListInput);
            try {
              const data = pages(op.input as ListInput);
              observer.next({ result: { data } });
              observer.complete();
            } catch (e) {
              observer.error(TRPCClientError.from(e as Error));
            }
          } else {
            observer.error(TRPCClientError.from(new Error(`unexpected ${op.path}`)));
          }
          return () => {};
        }),
    ],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <FileManager />
      </QueryClientProvider>
    </trpc.Provider>
  );
  return calls;
}

const reach = { categories: ["evidence.read_job_operational"], own: false, canVerify: false };
const page = (ids: number[], next: string | null, first: boolean) => ({
  records: ids.map(id => ({ ...row({ id, title: `Record ${id} title` }), receivedAt: new Date() })),
  nextCursor: next,
  hasMore: next != null,
  counts: first ? counts : null,
  reach,
});

describe("the file manager pages through the server", () => {
  it("loads the first page on mount, appends the next, and stops when the server has no more", async () => {
    const calls = serve(i => (i.cursor ? page([2, 1], null, false) : page([4, 3, 2], "CUR1", true)));
    await screen.findByRole("button", { name: /Record 4 title/ });
    expect(calls[0]).toMatchObject({ folder: "all", query: "", limit: 50 });
    expect(calls[0].cursor ?? null).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Record 1 title/ });
    expect(calls[1].cursor).toBe("CUR1");

    const list = screen.getByRole("region", { name: "Records" });
    // Record 2 came on both pages: shown once, in its first place.
    expect(within(list).getAllByRole("button", { name: /Record \d title/ }).map(b => b.textContent?.match(/Record (\d) title/)?.[1]))
      .toEqual(["4", "3", "2", "1"]);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("starts again from the first page when the folder changes", async () => {
    const calls = serve(i => (i.folder === "all" ? (i.cursor ? page([1], null, false) : page([3, 2], "CUR1", true)) : page([9], "CUR9", true)));
    await screen.findByRole("button", { name: /Record 3 title/ });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Record 1 title/ });

    fireEvent.click(within(screen.getByRole("navigation", { name: "Folders" })).getByRole("button", { name: /Billing/ }));
    await screen.findByRole("button", { name: /Record 9 title/ });
    const last = calls[calls.length - 1];
    expect(last.folder).toBe("billing");
    expect(last.cursor ?? null).toBeNull();
    expect(screen.queryByRole("button", { name: /Record 3 title/ })).toBeNull();
  });

  it("starts again from the first page when the search changes", async () => {
    const calls = serve(i => (i.query ? page([7], null, true) : page([3, 2], "CUR1", true)));
    await screen.findByRole("button", { name: /Record 3 title/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "trk" } });
    await screen.findByRole("button", { name: /Record 7 title/ }, { timeout: 2000 });
    const last = calls[calls.length - 1];
    expect(last.query).toBe("trk");
    expect(last.cursor ?? null).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("keeps what it has and offers a retry when a later page fails", async () => {
    let fail = true;
    serve(i => {
      if (!i.cursor) return page([3, 2], "CUR1", true);
      if (fail) { fail = false; throw new Error("boom"); }
      return page([1], null, false);
    });
    await screen.findByRole("button", { name: /Record 3 title/ });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/More records could not be loaded/);
    expect(screen.getByRole("button", { name: /Record 3 title/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: /Record 1 title/ });
  });
});
