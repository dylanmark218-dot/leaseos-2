# What "confirmed" can mean on a trip stop

Settles the field both `siteBaseline.ts` and `tripBillingProjection.ts` filter on. Written against
`4c31a2935`.

The owner's position, which this confirms: the unit of confirmation is a **timestamp**, not a stop;
a phase is confirmed when both its bounding timestamps are; and a rejected zone event is evidence
about the GPS, not about the stop.

---

## 1. The provenance is already there for one writer, and absent for the other

`tripStops` has exactly two write paths in the whole tree:

| Path | Provenance recorded |
|---|---|
| `tripStops.create` / `tripStops.update` (`server/routers.ts:591,626` → `db.ts:288,294`) | **None.** Both are `roleProcedure`, so `ctx.user.id` is in hand and discarded at the write. The table has no `recordedByUserId`, no `updatedAt`, nothing. |
| `assistantCommitService.ts:385` | **Per field, richly.** |

The assistant path records more than a user id. `assistantCommitReceipts` links
`targetType: "trip_stop"` + `targetRecordId` → `proposalId`, with a `fieldManifest` naming every
field key it wrote and a `fieldManifestHash` over them. `proposalFields` then carries, per field:

```
source:     driver_voice | driver_typed | gps | photo_ocr | system_inferred | imported | human_corrected
status:     proposed | confirmed | rejected | corrected
precision:  exact | approximate
confidence: low | medium | high
sourceUtterance, correctedFrom
```

That is the vocabulary this question needs, already in the schema, already written, and richer than
the four states proposed — it separates *who or what produced the value* from *what has since
happened to it*, which is the same separation `MeasurementBasis` makes on the billing side and the
same one a single `confirmed` boolean destroys.

## 2. So `stated` is derivable today, and only by accident

With exactly two writers and one leaving a trail, a timestamp with no `assistantCommitReceipt`
covering its field was written by a person through a `roleProcedure`. The derivation works.

It works because nothing else writes the table. Add an importer, a device sync, a backfill or a
second assistant adapter, and absence-of-receipt silently stops meaning "a person typed this" and
starts meaning "a person typed this, or one of these did" — with no failure, no migration, and no
test that would notice. A derivation whose correctness depends on the number of writers staying at
two is not a derivation, it is a coincidence with good manners.

**So the answer is not a `confirmed` column, and it is not the join either. It is provenance on the
write**, using `proposalFields`' own vocabulary rather than a new one:

- `recordedByUserId` and a `source` on the direct write path, defaulting to `driver_typed`, set from
  `ctx.user.id` which both procedures already hold.
- The derivation then reads one place for both writers and stays correct when a third arrives.

Reusing the existing enum matters beyond tidiness: `source: "imported"` and `source: "gps"` already
exist as concepts, so the importer that has not been written yet has somewhere honest to land
instead of forcing the next author to invent a parallel word.

## 3. Per-boundary, not per-stop — and the engines are wrong here

`tripStops` carries five boundaries: `arrivedAt`, `setupStartedAt`, `operationStartedAt`,
`operationCompletedAt`, `departedAt`. They are confirmed independently — an arrival lands as a zone
event and a departure never does, or the reverse — and each phase spans two of them:

| Phase | Bounded by |
|---|---|
| `wait` | `arrivedAt` → `setupStartedAt` |
| `setup` | `setupStartedAt` → `operationStartedAt` |
| `operation` | `operationStartedAt` → `operationCompletedAt` |
| `total` | `arrivedAt` → `departedAt` |

`StopSample.confirmed` in `siteBaseline.ts` is one boolean covering all four phase values, and
`BillableStop.confirmed` in `tripBillingProjection.ts` is one boolean covering the stop's billable
minutes. **A single unconfirmed departure therefore discards a setup sample that is perfectly
sound** — and at a site visited twice a year, where `MINIMUM_SAMPLES` is eight, discarding good
samples is not a conservative choice. It is the difference between a site having a baseline and
being unmeasured, and `siteBaseline.ts`'s own header says an unmeasured site must never render as
normal. Losing samples it was entitled to keep is how a site stays unmeasured longer than the facts
require.

The four states per boundary, with only one excluded:

| State | Meaning | Feeds a baseline |
|---|---|---|
| `confirmed_detected` | a confirmed `zoneEvent` supplies or corroborates it | yes |
| `stated` | a person entered it directly | yes |
| `detected_unconfirmed` | a pending `zoneEvent` supplies it, nobody has confirmed | **no** |
| `absent` | no value | n/a |

`stated` and `confirmed_detected` both have someone accountable, which is the bar the rest of the
codebase sets — `billing.ts`'s verified-only rule, `roadAsSegment`'s confidence from the source,
`safetyBinder`'s unverified-is-not-present. Only `detected_unconfirmed` is inference nobody has
stood behind.

**A rejected zone event does not appear in that table, deliberately.** Rejection is a judgement about
the GPS detection, not about the stop. A rejected detection sitting beside a hand-entered timestamp
leaves that timestamp `stated`, because if rejection demoted it, correcting a bad detection would
destroy the correction — and the person most likely to reject a detection is the one who just typed
the right time.

## 4. What this means for the two engines

Both need their boolean replaced by a per-phase resolution, computed once in one place and read by
both. `siteBaseline.buildSiteBaseline` already filters per phase (`phaseValue` returns null for a
phase a sample does not carry), so the change is to filter on that phase's confirmation rather than
on the sample's, and to keep reporting the excluded count per phase rather than per sample.

Neither engine can be wired to real data until this lands: the field they filter on does not exist,
and the shape they filter with is wrong.

---

## Appendix — the census check this produced

`engineReachability.test.ts` now pins mutual-unwired clusters: a declared engine whose importers all
exist and are all themselves declared. That is the shape that let `billing` and
`tripBillingProjection` cite each other while both passed every other check.

The current set is **eleven**, not one:

```
advisoryImpact, billing, deviceManifest, eventEmitter, externalDataRegistry,
feedCollector, feedIngest, monitoringNotice, osmImport, osmTopology
```

Some are legitimate — `osmImport` and `osmTopology` are imported by `osmLoad`, a subsystem that
landed as a unit and builds from scripts. The point is not that a cluster is a bug; it is that a
cluster is where this bug hides, so the set is pinned and moving it is deliberate.

A twelfth was a false positive worth recording: `voiceTranscription` appeared to import itself
because its header shows its own import in a usage example. The import regex matched a doc comment.
**The same blind spot is in `reachableSet`**, where it is worse — there a documented or commented-out
import in a router would mark an engine *reached* that nothing actually calls, which is the failure
this whole file exists to prevent. The cluster check strips comments before matching; the
reachability walk still does not, and should.
