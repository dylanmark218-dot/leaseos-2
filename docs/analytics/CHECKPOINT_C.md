# Analytics — Checkpoint C: the dashboard

Built on `claude/leaseos-analytics-reporting-ko9ylj`, after merging `main` at v23.31. A read-only
screen at `/analytics` over the Checkpoint B API (`docs/analytics/CHECKPOINT_B.md`).

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Words | `client/src/analytics/analyticsPresentation.ts` | every phrase about completeness, age and range: "No value", "Incomplete", "Stale", "Last updated", the exact interval |
| Screen | `client/src/analytics/AnalyticsDashboardView.tsx` | props in, markup out: tiles grouped by area, the drill-down panel, the organization / my-numbers switch |
| Container | `client/src/pages/Analytics.tsx` | the only file that calls the server: catalog, one metric per tile, `mine`, the drill-down |
| Route | `client/src/App.tsx` | `/analytics` |
| Server | `server/analyticsRouter.ts` | each answer now carries its metric's description and formula, and the drill-down input is typed |

## What every tile says

A number without context is the "unexplained total" the proposal ruled out, so each tile shows:

- the value in its unit, or the words "No value" — never a 0 the server did not count;
- whether it is complete. An incomplete answer lists, beside the value, how many records it could
  not place and why;
- the exact interval it covers, in the reader's timezone, or "Current state";
- when it was computed. It is marked **Stale** past the metric's freshness budget. A failed refresh
  keeps the last answer only with "Could not refresh" and "not current" beside it;
- for a metric the records cannot support, its reason in place of a value, and no records button;
- how it is counted: the description and formula, for drivers too, who cannot read the catalog.

There is no red/amber/green. These are counts and durations, not verdicts, and colouring a count of
open defects red would be a judgement the server never made.

## The drill-down

"Show records" opens a panel listing exactly the rows behind the value. The panel asks with the
input the tile's own answer echoed: the same metric, the resolved instants rather than "today"
again, and the same filters. So its row count is the tile's value, and the panel says so. A
truncated list says more records qualify. An empty list is called a counted zero.

## Who sees what

- **A role with `analytics.read`** sees the metrics whose source records it may read. Those it may
  not are counted ("3 further metrics are not shown") and never named or valued.
- **A role without `analytics.read`, such as a driver,** is refused the catalog by the server. The
  screen shows that person their own numbers rather than an error, with the note that these are
  their records only and nobody is ranked or scored.
- **Anyone with both** can switch between the organization's numbers and their own.
- **A caller with no organization membership** is told the numbers cover the records that belong to
  no organization.

The server enforces all of this; the screen only reflects what it was given.

## Why a page, not widget tiles

The survey planned the dashboard as widget-board tiles. The widget registry is a closed, test-pinned
set of twelve keys, with a source contract, promotion gates and a matrix that rates no widget
production-ready. Registering 22 metrics there is widget-engine work, not analytics. This page reads
the same procedures a tile would. A single generic "analytics metric" widget can be registered later
through the board's own promotion process.

## Proof

| Suite | Holds |
|---|---|
| `client/src/analytics/AnalyticsDashboardView.dom.test.tsx` (25) | a counted zero vs "No value" vs not applicable; unavailable metrics show their reason and offer no records; a failed metric with no prior answer shows no value; incomplete answers list what is missing; an unknown determination is never shown as complete; last-updated and stale marking, including after a failed refresh; the stated zone; the drill-down's count, truncation and counted zero; the driver's note and empty reason; hidden-metric count; the single-tenant note; the mode switch; ranges handed back |
| `client/src/a11y/a11y.dom.test.tsx` | the screen in four states (organization tiles, drill-down open, a driver with no linked record, could not be read) through the axe WCAG A/AA rules at three widths |
| `server/a11yCoverage.test.ts` | the container is named as a live caller whose view is the surface |
| `server/analytics.db.test.ts` | the formula on an answer is the registry's formula |

## Not done

- No link from the portal shell yet: `/analytics` is reached by URL, as `/widgets` and
  `/dispatch/:id` are. The portal's composed navigation has its own view-model tests and deserves its
  own change.
- No exports, saved views, financial metrics or report runs — Checkpoint D.
- The owner decisions from the survey still stand: the moratorium exception for downtime and
  utilization (C12), branches (C3), a platform-wide view (C2), current shift (C10).
