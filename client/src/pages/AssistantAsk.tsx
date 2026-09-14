/**
 * v22.20 — asking the loaded documents, with no model in the answer.
 *
 * Every sentence shown is a passage from the company's own documents, quoted
 * and cited. Nothing here is composed. That makes the screen less impressive
 * than a chat box and considerably more useful, because a citation the reader
 * can open is the only part of an answer that can be checked.
 *
 * Two things it refuses to soften.
 *
 * **"Nothing in the loaded documents answers this" is the answer**, not an
 * error state and not an empty result. It gets the same weight as a found
 * passage, because the alternative — a helpful-sounding paragraph — is exactly
 * what this whole path exists to avoid.
 *
 * **The retrieval caveat is shown above the answer, not below it.** How often
 * retrieval misses on this corpus is currently unmeasured, and a reader who
 * sees three citations will assume they are the three best unless told
 * otherwise. Putting that at the bottom, in grey, would be a way of technically
 * disclosing it.
 */
import { useState } from "react";
import { AlertTriangle, BookOpen, FileQuestion, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TONE_CLASS, type Tone } from "@/lib/commsView";

/** Four verdicts, and the two that are not "we found it" are not failures. */
function verdictTone(verdict: string): Tone {
  switch (verdict) {
    case "verified": return "good";
    case "partially_supported": return "warn";
    case "conflicting": return "warn";
    case "insufficient_evidence": return "muted";
    default: return "muted";
  }
}

export default function AssistantAsk() {
  const [question, setQuestion] = useState("");
  const ask = trpc.assistantAsk.ask.useMutation();
  const answer = ask.data;

  const submit = () => {
    const q = question.trim();
    if (q.length >= 3) ask.mutate({ question: q });
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Documents
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Ask the documents</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Answers are passages from your own documents, quoted and cited. Nothing here is written
          by a model.
        </p>
      </header>

      <Card>
        <CardContent className="flex gap-2 pt-6">
          <Input
            value={question}
            placeholder="What do you need to know?"
            aria-label="Question"
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
          />
          <Button onClick={submit} disabled={question.trim().length < 3 || ask.isPending}>
            <Search className="mr-2 h-4 w-4" aria-hidden />Ask
          </Button>
        </CardContent>
      </Card>

      {ask.isError && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="pt-6 text-sm">{ask.error?.message}</CardContent>
        </Card>
      )}

      {answer && (
        <>
          {/* Above the answer. A reader who sees three citations assumes they
              are the three best unless told otherwise, and burying that in grey
              at the bottom would be disclosure in name only. */}
          {answer.retrievalCaveat && (
            <Card className="border-amber-400 dark:border-amber-700">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                <div className="flex flex-col gap-1">
                  <p className="text-sm">{answer.retrievalCaveat}</p>
                  <p className="text-xs text-muted-foreground">
                    Retrieval quality: {answer.retrievalQuality} · {answer.probesOnFile} probe
                    {answer.probesOnFile === 1 ? "" : "s"} on file
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="text-sm font-medium">{answer.headline}</CardTitle>
              <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[verdictTone(answer.verdict)]}`}>
                {answer.verdict.replace(/_/g, " ")}
              </span>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              {/* Not an empty state. The answer to most questions a company has
                  never written down, and more useful than a plausible paragraph. */}
              {answer.passages.length === 0 && (
                <div className="flex gap-3 rounded-lg border border-dashed p-4">
                  <FileQuestion className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="text-sm">
                    Nothing in the loaded documents answers this. It may still be true — it is not
                    something these documents say.
                  </p>
                </div>
              )}

              {answer.passages.map(passage => (
                <figure key={passage.passageRef} className="flex flex-col gap-2 rounded-lg border p-4">
                  {/* Quoted, not summarised. */}
                  <blockquote className="text-sm leading-relaxed">{passage.text}</blockquote>
                  <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
                    <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">
                      {passage.documentTitle}
                      {passage.section && ` §${passage.section}`}
                      {passage.page != null && ` p.${passage.page}`}
                      {" · "}rev {passage.revision}
                    </span>
                  </figcaption>
                </figure>
              ))}

              {/* Why a passage the retriever surfaced did not support the
                  answer. Silence here would read as "nothing else was found". */}
              {answer.rejected.length > 0 && (
                <details className="rounded-lg border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    {answer.rejected.length} passage{answer.rejected.length === 1 ? "" : "s"} found but not used
                  </summary>
                  <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                    {answer.rejected.map((r, i) => <li key={i}>{r.reason}</li>)}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>

          {answer.sources.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Sources</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {answer.sources.map(source => (
                  <Badge key={`${source.documentRef}-${source.revision}`} variant="secondary">
                    {source.documentTitle} · rev {source.revision}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">{answer.note}</p>
        </>
      )}
    </div>
  );
}
