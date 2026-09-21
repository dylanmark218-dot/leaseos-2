/**
 * Analytics is off unless configured, and a surviving placeholder is not configuration.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyticsConfig, installAnalytics } from "./analytics";

const fresh = () => document.implementation.createHTMLDocument("t");

describe("analytics is optional and explicitly so", () => {
  it("is not configured when either variable is missing, empty, or a surviving placeholder", () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ VITE_ANALYTICS_ENDPOINT: "https://a.example" })).toBeNull();
    expect(analyticsConfig({ VITE_ANALYTICS_WEBSITE_ID: "abc" })).toBeNull();
    expect(analyticsConfig({ VITE_ANALYTICS_ENDPOINT: "  ", VITE_ANALYTICS_WEBSITE_ID: "abc" })).toBeNull();
    // The exact failure this replaced: Vite leaves the placeholder when the variable is unset.
    expect(analyticsConfig({ VITE_ANALYTICS_ENDPOINT: "%VITE_ANALYTICS_ENDPOINT%", VITE_ANALYTICS_WEBSITE_ID: "abc" })).toBeNull();
    expect(analyticsConfig({ VITE_ANALYTICS_ENDPOINT: "https://a.example", VITE_ANALYTICS_WEBSITE_ID: "%VITE_ANALYTICS_WEBSITE_ID%" })).toBeNull();
  });

  it("attaches nothing at all when it is not configured", () => {
    const doc = fresh();
    expect(installAnalytics(doc, {})).toBe(false);
    expect(doc.querySelectorAll("script").length).toBe(0);
  });

  it("attaches one deferred beacon when both are set, and trims a trailing slash", () => {
    const doc = fresh();
    expect(installAnalytics(doc, { VITE_ANALYTICS_ENDPOINT: "https://a.example/", VITE_ANALYTICS_WEBSITE_ID: "w-1" })).toBe(true);
    const s = doc.querySelectorAll("script");
    expect(s.length).toBe(1);
    expect(s[0]!.getAttribute("src")).toBe("https://a.example/umami");
    expect(s[0]!.getAttribute("data-website-id")).toBe("w-1");
    expect((s[0] as HTMLScriptElement).defer).toBe(true);
  });

  it("leaves no unresolved build placeholder in the HTML that ships", () => {
    const html = readFileSync("client/index.html", "utf8");
    const inTags = html.replace(/<!--[\s\S]*?-->/g, "");   // a comment naming the variables is fine
    expect(inTags).not.toMatch(/%VITE_[A-Z_]+%/);
  });
});
