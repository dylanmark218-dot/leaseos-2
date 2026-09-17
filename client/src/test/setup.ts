/**
 * Loads jest-dom matchers only under jsdom; node tests import nothing.
 */
export {};

if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}
