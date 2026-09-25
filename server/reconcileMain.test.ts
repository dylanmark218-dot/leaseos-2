/**
 * `scripts/reconcile-main.sh` settles exactly one conflict automatically and refuses the rest.
 *
 * These are structural checks over the script's source, in the same shape as the other boundary
 * guards here. They are not a substitute for running it — that was done against two real branches
 * before it was committed — but they pin the three properties that make it safe to run unattended,
 * each of which is a one-character edit away from being false.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("scripts/reconcile-main.sh", "utf8");
/** Comments explain why the script refuses to do these things; the code must not then do them. */
const CODE = SOURCE.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("the generated file is regenerated, never chosen", () => {
  /*
   * The counts in LEASEOS_CURRENT_STATE.md describe the tree, and the merged tree is neither
   * parent — measured on a real reconciliation, both sides said 365/5035 and the truth was
   * 366/5047. So `--ours` and `--theirs` are both wrong answers, not merely lazy ones, and a
   * future edit reaching for either is the failure this case exists to catch.
   */
  it("never resolves by taking a side", () => {
    expect(CODE).not.toMatch(/--ours|--theirs/);
  });

  it("calls the generator", () => {
    expect(CODE).toMatch(/current-state\.sh/);
  });

  it("checks the generator is reproducible before trusting what it wrote", () => {
    expect(CODE).toMatch(/hash-object/);
  });
});

describe("anything that is a decision is handed back", () => {
  it("refuses when a path other than the generated file is conflicted", () => {
    // The refusal is the point: a conflict in source is a decision about behaviour, and this
    // script has no standing to make one.
    expect(CODE).toMatch(/diff-filter=U/);
    expect(CODE).toMatch(/exit 1/);
  });

  it("never commits — the merge is left staged to be read first", () => {
    /*
     * A line that RUNS `git commit`, not one that prints it: the script ends by telling the reader
     * to run `git commit` themselves, and a naive substring match on the source flags that echo and
     * calls the script unsafe. The first version of this case did exactly that.
     */
    const invocations = CODE.split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(git commit|.*(&&|\|\||;)\s*git commit)\b/.test(l));
    expect(invocations).toEqual([]);
  });
});

describe("it looks for the merge state where git actually keeps it", () => {
  /*
   * `.git/MERGE_HEAD` does not exist inside a linked worktree: `.git` is a file there and the real
   * directory is elsewhere, so that guard would silently never fire. Worktrees are how these
   * branches are reconciled, so the literal path is the wrong one everywhere it matters.
   */
  it("resolves MERGE_HEAD through git rather than assuming .git is a directory", () => {
    expect(CODE).toMatch(/rev-parse --git-path MERGE_HEAD/);
    expect(CODE).not.toMatch(/\.git\/MERGE_HEAD/);
  });
});
