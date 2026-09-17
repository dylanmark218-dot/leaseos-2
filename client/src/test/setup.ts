/**
 * Vitest setup for the jsdom client suites (B28).
 *
 * jest-dom's matchers extend `expect` at import time and need no document, so a
 * static import is safe for the node suites too — and it avoids a top-level
 * await, which this tsconfig's module setting does not allow.
 */
import "@testing-library/jest-dom/vitest";
