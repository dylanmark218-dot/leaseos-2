/**
 * v22.20 — turning a question somebody asked into a labelled probe.
 *
 * This is the screen that produces the evidence for deciding whether LeaseOS
 * needs a semantic retriever. Everything else in the assistant path has been
 * built on reasoning about imagined questions; this is where real ones get
 * their expected answers written down by a person who knows the documents.
 *
 * Two things it is built to make easy, because they are the two that matter:
 *
 * **Finding a passage the answer did not cite.** The browse is a plain
 * substring scan, not the retriever — if a curator could only search with the
 * thing under test, they could never label the case where it missed, which is
 * the case worth labelling.
 *
 * **Seeing what was returned without being led by it.** The cited passages are
 * shown, unticked. A curator who simply confirms them has recorded that
 * retrieval agreed with itself, and the measurement would be worthless in the
 * flattering direction.
 */
import { useState } from "react";
import { Check, FileSearch, Gauge, MessageSquareQuote, Tag } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function AssistantCalibration() {
  const [selected, setSelected] = useState<string | null>(null);
  const [contains, setContains] = useState("");
  const [expected, setExpected] = useState<Set<string>>(new Set());

  const history = trpc.assistantAsk.history.useQuery({ limit: 30 });
  const passages = trpc.assistantAsk.passageList.useQuery({ contains: contains.trim() || undefined, limit: 50 });
  // A mutation: running a calibration records a measurement.
  const measure = trpc.assistantAsk.measureRetrieval.useMutation();
  const label = trpc.assistantAsk.addProbeFromAsk.useMutation({
    onSuccess: () => { setSelected(null); setExpected(new Set()); history.refetch(); },
  });

  const ask = history.data?.queries.find(q => q.queryRef === selected) ?? null;

  const toggle = (ref: string) => {
    const next = new Set(expected);
    next.has(ref) ? next.delete(ref) : next.add(ref);
    setExpected(next);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Documents · calibration
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Label a real question</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Pick a question somebody asked, then mark the passages that should have answered it —
          including ones the assistant did not return. That gap is the measurement.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <MessageSquareQuote className="h-4 w-4 text-muted-foreground" aria-hidden />
            Questions asked
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          {history.data?.queries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nobody has asked anything yet. Real questions come from use, not from this screen.
            </p>
          )}
          {history.data?.queries.map(q => (
            <button
              key={q.queryRef}
              onClick={() => { setSelected(q.queryRef); setExpected(new Set()); }}
              className={`flex flex-col gap-1 rounded-lg border p-3 text-left text-sm hover:bg-accent ${selected === q.queryRef ? "border-primary" : ""}`}
            >
              <span className="font-medium">{q.question}</span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{q.verdict.replace(/_/g, " ")}</Badge>
                {/* So a curator can see what is left to do. */}
                <Badge variant={q.labelled ? "default" : "outline"}>
                  {q.labelled ? "labelled" : "unlabelled"}
                </Badge>
                {q.passagesRetrieved} retrieved · {q.passagesSupporting} supported
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      {ask && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Labelling: “{ask.question}”
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {/* Shown, and deliberately not preselected. A curator who just
                  confirms these has recorded that retrieval agreed with itself. */}
              <p className="text-muted-foreground">
                {ask.citedPassageRefs.length > 0
                  ? `The assistant cited ${ask.citedPassageRefs.join(", ")}. Tick what should have answered — agreeing with the assistant is a finding, not the default.`
                  : "The assistant cited nothing. If something in the documents does answer this, tick it."}
              </p>
              <p className="text-xs text-muted-foreground">
                The question is copied from the recorded ask. It cannot be edited here — rewording
                it would make it a question nobody asked.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <FileSearch className="h-4 w-4 text-muted-foreground" aria-hidden />
                Find passages
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Input
                value={contains}
                placeholder="Search the text of your documents"
                aria-label="Search passages"
                onChange={e => setContains(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A plain text search, not the assistant's retriever — so a passage it missed is
                still findable here.
              </p>

              <div className="flex flex-col gap-1.5">
                {passages.data?.passages.map(p => {
                  const ticked = expected.has(p.passageRef);
                  const wasCited = ask.citedPassageRefs.includes(p.passageRef);
                  return (
                    <button
                      key={p.passageRef}
                      onClick={() => toggle(p.passageRef)}
                      className={`flex items-start gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent ${ticked ? "border-primary" : ""}`}
                    >
                      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${ticked ? "bg-primary text-primary-foreground" : ""}`}>
                        {ticked && <Check className="h-3 w-3" aria-hidden />}
                      </span>
                      <span className="min-w-0">
                        <span className="line-clamp-2">{p.body}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {p.documentTitle}{p.section && ` §${p.section}`} · rev {p.revision}
                          {wasCited && <Badge variant="secondary">was cited</Badge>}
                          {p.supersededAt && <Badge variant="outline">superseded</Badge>}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Button
            onClick={() => label.mutate({ queryRef: ask.queryRef, expectedPassageRefs: Array.from(expected) })}
            disabled={expected.size === 0 || label.isPending}
          >
            <Tag className="mr-2 h-4 w-4" aria-hidden />
            Record as a labelled probe ({expected.size})
          </Button>

          {label.isError && (
            <p className="text-sm text-amber-700 dark:text-amber-500">{label.error?.message}</p>
          )}
        </>
      )}

      {/* The last step of the loop, on the screen rather than in an API client. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
            Run a calibration
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            variant="secondary"
            onClick={() => measure.mutate({ k: 8 })}
            disabled={measure.isPending}
          >
            Measure recall at 8
          </Button>
          <p className="text-xs text-muted-foreground">
            Measured at the depth answers actually show. A figure taken at another depth is a true
            number about a different product.
          </p>

          {measure.data && (
            <div className="flex flex-col gap-3 text-sm">
              <p>{measure.data.quality.line}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Grade</dt><dd>{measure.data.quality.grade}</dd></div>
                <div><dt className="text-muted-foreground">Probes</dt><dd className="tabular-nums">{measure.data.quality.probeCount}</dd></div>
                <div>
                  <dt className="text-muted-foreground">Mean recall</dt>
                  <dd className="tabular-nums">
                    {measure.data.quality.meanRecall == null ? "—" : `${(measure.data.quality.meanRecall * 100).toFixed(0)}%`}
                  </dd>
                </div>
                <div><dt className="text-muted-foreground">Found nothing</dt><dd className="tabular-nums">{measure.data.quality.completeMisses.length}</dd></div>
              </dl>

              {/* The diagnosis that decides whether a semantic retriever has a
                  job to do. A ranking failure and a vocabulary gap look the
                  same in a recall number and need different repairs. */}
              {measure.data.vocabularyGaps.length > 0 && (
                <div className="rounded-lg border border-amber-400 p-3 dark:border-amber-700">
                  <p className="font-medium">
                    {measure.data.vocabularyGaps.length} question(s) share no words with the passage that answers them
                  </p>
                  <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                    {measure.data.vocabularyGaps.map(gap => (
                      <li key={gap.probeRef}>{gap.questionTerms.join(", ")}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">{measure.data.note}</p>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Measured against corpus {measure.data.corpus.hash.slice(0, 12)} · {measure.data.corpus.passageCount} passages
              </p>
            </div>
          )}

          {measure.isError && (
            <p className="text-sm text-amber-700 dark:text-amber-500">{measure.error?.message}</p>
          )}
        </CardContent>
      </Card>

      {label.data && (
        <Card className={label.data.notRetrievedWhenAsked.length ? "border-amber-400 dark:border-amber-700" : undefined}>
          <CardContent className="pt-6 text-sm">
            {/* The finding, stated at labelling time. */}
            {label.data.note}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
