/**
 * Analytics is optional, and absent unless it is configured.
 *
 * `client/index.html` carried a static `<script src="%VITE_ANALYTICS_ENDPOINT%/umami">`. With the
 * variables unset — which is every environment that has not deliberately set them — Vite left the
 * placeholders in place, so the shipped HTML asked every browser for a script at the literal URL
 * `%VITE_ANALYTICS_ENDPOINT%/umami`. The build said so twice and the request failed on every page
 * load. An unresolved placeholder is not a disabled feature; it is a broken one that happens to be
 * harmless.
 *
 * So the decision is stated instead: nothing is loaded unless both variables are set. An analytics
 * beacon sends data about a person's session to a third party, and for this product the honest
 * default is off — a deployment that wants it says so in its own environment.
 */
export type AnalyticsConfig = { endpoint: string; websiteId: string };

/** The configuration, or null when analytics is not configured. Both variables or neither. */
export function analyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig | null {
  const endpoint = (env.VITE_ANALYTICS_ENDPOINT ?? "").trim();
  const websiteId = (env.VITE_ANALYTICS_WEBSITE_ID ?? "").trim();
  if (!endpoint || !websiteId) return null;
  // A placeholder that survived a build is not configuration.
  if (endpoint.startsWith("%") || websiteId.startsWith("%")) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), websiteId };
}

/** Attaches the beacon when configured; does nothing, quietly and on purpose, when it is not. */
export function installAnalytics(doc: Document, env: Record<string, string | undefined>): boolean {
  const cfg = analyticsConfig(env);
  if (!cfg) return false;
  const s = doc.createElement("script");
  s.defer = true;
  s.src = `${cfg.endpoint}/umami`;
  s.setAttribute("data-website-id", cfg.websiteId);
  doc.head.appendChild(s);
  return true;
}
