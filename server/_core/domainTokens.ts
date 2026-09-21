/**
 * v22.20 — what counts as a word in a question about a truck.
 *
 * Pure.
 *
 * The first tokenizer took every run of three or more alphanumerics. Tested
 * against vocabulary already in this system, it failed three ways that matter
 * here more than they would elsewhere:
 *
 *   STOPWORDS SCORED   "UWI for the well" yields four terms, two of which are
 *                      "for" and "the". A passage sharing only those scores
 *                      0.5 — above the support floor. Function words were
 *                      manufacturing evidence.
 *   NUMBERS DROPPED    "1 1/2 inches" kept "inches". In a domain where the
 *                      answer is a measurement, the measurement went first.
 *   UNITS DROPPED      "in kg" and "in lb" tokenized identically, which is a
 *                      conflation with weight limits on the other side of it.
 *
 * None of this needed a real question to find; it needed the domain's own
 * vocabulary, which was already here.
 */

/**
 * Words that carry no evidence.
 *
 * Deliberately short and general. A long hand-tuned list would encode guesses
 * about phrasing nobody has observed yet, which is the failure this module was
 * written to avoid repeating.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "was", "were", "what", "when", "where", "which",
  "who", "why", "how", "does", "did", "can", "could", "should", "would", "with",
  "from", "that", "this", "these", "those", "there", "then", "than", "into",
  "any", "all", "our", "its", "has", "have", "had", "but", "you", "your",
  "about", "within", "per",
]);

/**
 * Words that reverse the fact that follows them.
 *
 * These were stopwords, so "not authorized" and "authorized" produced the same
 * terms — a passage refusing something scored a perfect match against a
 * question asking whether it was permitted. They are bound to the word they
 * govern instead of dropped: `not_authorized` shares nothing with `authorized`,
 * which is the point.
 */
const NEGATORS = new Set(["not", "no", "never", "cannot", "without", "except", "unless"]);

/** Units and short tokens that are evidence despite being brief. */
const SHORT_SIGNIFICANT = /^(kg|lb|mm|cm|km|hr|hrs|psi|kpa|ppm|rpm|gvw|oz|ft|in|m3|l)$/;

/**
 * Split a question or passage into evidence-bearing terms.
 *
 * Keeps measurements whole — "1-1/2", "04-16-083-05W6", "2.5" — because a
 * fraction split into "1" and "2" is not the same fact, and a legal land
 * description split on its hyphens is not a location.
 */
export function domainTerms(text: string): string[] {
  // "1 1/2 inches" was split into "1" and "1/2", the bare digit dropped as
  // noise, and one and a half inches became half an inch. Joined before
  // anything else looks at it.
  const normalised = text.toLowerCase().replace(/\b(\d+)\s+(\d+\/\d+)\b/g, "$1-$2");
  const raw = normalised.match(/[a-z0-9][a-z0-9./-]*[a-z0-9]|[a-z0-9]/g) ?? [];

  const kept: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];

    if (NEGATORS.has(token)) {
      // Attach to whatever it governs. A negator with nothing after it is kept
      // alone rather than dropped, since it still says something.
      const next = raw[i + 1];
      if (next && !STOPWORDS.has(next) && !NEGATORS.has(next)) {
        kept.push(`${token}_${next}`);
        i++;
        continue;
      }
      kept.push(token);
      continue;
    }

    if (STOPWORDS.has(token)) continue;

    const hasDigit = /\d/.test(token);
    if (hasDigit && token.length < 2) {
      // A bare digit after a word is that word's identifier, not noise:
      // class 1 and class 3 are different placards, and dropping the number
      // made them the same question.
      const previous = kept[kept.length - 1];
      if (previous && !/\d/.test(previous)) kept[kept.length - 1] = `${previous}_${token}`;
      continue;
    }
    if (!hasDigit && token.length < 3 && !SHORT_SIGNIFICANT.test(token)) continue;
    kept.push(token);
  }
  return Array.from(new Set(kept));
}

/**
 * Fraction of the question's terms the passage carries.
 *
 * Unchanged in shape from before — what changed is which words count, which is
 * the part that was wrong.
 */
export function termOverlap(passage: string, question: string, stemOf: (w: string) => string): number {
  const asked = domainTerms(question);
  if (!asked.length) return 0;
  const inPassage = new Set(domainTerms(passage).map(stemOf));
  return asked.filter(t => inPassage.has(stemOf(t))).length / asked.length;
}
