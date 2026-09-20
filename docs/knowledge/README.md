# docs/knowledge

The specification this repository implements.

`INDEX.md` catalogues every document in the LeaseOS Claude project — roughly 190 — against the code
that implements it, marking each `BUILT`, `PARTIAL`, `SPEC` or `HIST`.

`source/` holds the 15 whose full text was available, with a `.txt` beside every `.pdf` so the
specifications are greppable. **The other ~175 are named in `INDEX.md` and their bodies are not
here** — they live in the Claude project's search index, and search returns fragments rather than
documents. A policy book reassembled from fragments would read like the original without being it,
and a regulatory specification is the last thing that should happen to.

So `INDEX.md` is the contract: it says what exists, what it covers, and what state the code is in.
Anything it marks `SPEC` needs the document fetched before it is built, not inferred.
