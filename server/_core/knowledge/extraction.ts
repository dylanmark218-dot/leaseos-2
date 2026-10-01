/**
 * Extraction: from a retrieved page to the text a regulation actually says.
 *
 * Pure. Two jobs, and the first matters more than it looks:
 *
 *   1. **A fingerprint that changes only when the text does.** Versions are
 *      compared on it (`provenance.classifyRetrieval`), and a new version
 *      marks the old source revision superseded, which sends every rule cut
 *      from it back to a person. So page furniture — navigation, scripts,
 *      footers, the Government of Canada "Date modified" stamp — is stripped
 *      before hashing. Getting this wrong in the generous direction floods
 *      reviewers; in the stingy direction it hides an amendment. When in
 *      doubt the extractor keeps text: a spurious review is recoverable, a
 *      missed amendment is not.
 *   2. **Sections a citation can point at.** Headings split the text, and each
 *      chunk carries the heading it sits under.
 *
 * No dependency. Government pages are server-rendered, regular HTML, and a
 * conservative tag-stripper over them is easier to audit than a DOM library
 * pulled into the production bundle for one job. It is not a general HTML
 * parser and does not try to be; a page it cannot read is a `failed`
 * extraction, never a guessed one.
 */

import { sha256Hex } from "./provenance";

export const HTML_PARSER_VERSION = "html-1";

export type Section = { heading: string | null; level: number; text: string };

export type Extraction =
  | { ok: true; parserVersion: string; title: string | null; sections: readonly Section[]; text: string; fingerprint: string }
  | { ok: false; parserVersion: string; error: string };

/** Elements whose content is never the document's text. */
const DROP_ELEMENTS = ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "button", "select", "iframe"];
/**
 * Page-furniture blocks identified by the markup hooks the Government of Canada Web Experience
 * Toolkit (canada.ca, laws-lois.justice.gc.ca) puts on them. The "Date modified" stamp is
 * rendered as a `<dt>` and a `<dd>` on separate lines, so no line filter can catch it; the hook
 * can. Each pattern matches one non-nested element.
 */
const DROP_MARKUP: readonly RegExp[] = [
  /<section\b[^>]*class="[^"]*\bpagedetails\b[^"]*"[^>]*>[\s\S]*?<\/section>/gi,
  /<dl\b[^>]*id="wb-dtmd"[^>]*>[\s\S]*?<\/dl>/gi,
  /<(time|span|div|p)\b[^>]*property="dateModified"[^>]*>[\s\S]*?<\/\1>/gi,
];
/** Elements that end a line. */
const BLOCK = /<\/?(?:p|div|li|ul|ol|br|tr|td|th|table|section|article|dd|dt|dl|pre|blockquote|figure|figcaption|caption)\b[^>]*>/gi;

/**
 * Lines that are page furniture rather than content, matched after text extraction.
 * Deliberately short. "Last amended on …" on a Justice Laws page is the regulation's
 * own statement and stays; "Date modified:" is the web template's and goes.
 */
const VOLATILE_LINES: readonly RegExp[] = [/^date modified:/i, /^date de modification\s*:/i];

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", sect: "§", deg: "°", eacute: "é", egrave: "è", agrave: "à",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const textOf = (html: string): string =>
  decodeEntities(html.replace(BLOCK, "\n").replace(/<[^>]*>/g, " "))
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .filter((l) => l.length > 0 && !VOLATILE_LINES.some((re) => re.test(l)))
    .join("\n");

/**
 * Extract the readable text of an HTML page, split at its headings.
 *
 * Prefers `<main>` when the page has one — the Canada.ca and Alberta.ca templates both do
 * — and falls back to `<body>`. Fails rather than guesses on bytes that are not UTF-8 text
 * or a page that yields no text.
 */
export function extractHtml(bytes: Uint8Array): Extraction {
  const fail = (error: string): Extraction => ({ ok: false, parserVersion: HTML_PARSER_VERSION, error });
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("the body is not valid UTF-8");
  }
  if (html.includes("\u0000")) return fail("the body contains NUL bytes; it is not an HTML page");

  const title = (() => {
    const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const t = m ? textOf(m[1]!).replace(/\n/g, " ").trim() : "";
    return t || null;
  })();

  let scope = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const re of DROP_MARKUP) scope = scope.replace(re, " ");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(scope);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(scope);
  scope = main?.[1] ?? body?.[1] ?? scope;
  for (const el of DROP_ELEMENTS) scope = scope.replace(new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?<\\/${el}>`, "gi"), " ");

  const sections: Section[] = [];
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let cursor = 0, heading: string | null = null, level = 0;
  const push = (chunk: string) => {
    const text = textOf(chunk);
    if (text || heading) sections.push({ heading, level, text });
  };
  for (let m = headingRe.exec(scope); m; m = headingRe.exec(scope)) {
    push(scope.slice(cursor, m.index));
    heading = textOf(m[2]!).replace(/\n/g, " ").trim() || null;
    level = Number(m[1]);
    cursor = m.index + m[0].length;
  }
  push(scope.slice(cursor));

  const kept = sections.filter((s) => s.text.length > 0 || s.heading);
  const text = kept.map((s) => [s.heading, s.text].filter(Boolean).join("\n")).join("\n\n").trim();
  if (!text) return fail("no text could be extracted from the page");

  return { ok: true, parserVersion: HTML_PARSER_VERSION, title, sections: kept, text, fingerprint: sha256Hex(text) };
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

export type ChunkDraft = { ordinal: number; section: string | null; text: string };

/**
 * Cut sections into chunks of at most `maxChars`, on paragraph (line) boundaries.
 *
 * A chunk never spans two sections, so its `section` is always the heading the text sits
 * under — the thing a citation names. A single line longer than the limit is split on a
 * sentence or word boundary rather than mid-word.
 */
export function chunkSections(sections: readonly Section[], maxChars = 1500): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  const emit = (section: string | null, text: string) => {
    const t = text.trim();
    if (t) out.push({ ordinal: out.length, section: section ? section.slice(0, 200) : null, text: t });
  };
  for (const s of sections) {
    if (!s.text) continue;
    let buf = "";
    for (const line of s.text.split("\n")) {
      const pieces = line.length <= maxChars ? [line] : splitLong(line, maxChars);
      for (const piece of pieces) {
        if (buf && buf.length + 1 + piece.length > maxChars) { emit(s.heading, buf); buf = ""; }
        buf = buf ? `${buf}\n${piece}` : piece;
      }
    }
    emit(s.heading, buf);
  }
  return out;
}

function splitLong(line: string, max: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
    const at = cut > max / 2 ? cut + 1 : window.lastIndexOf(" ") > max / 2 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
