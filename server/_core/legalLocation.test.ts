import { describe, expect, it } from "vitest";
import { approximateFromLegalLocation } from "./legalLocation";

describe("legal land description → approximate coordinate", () => {
  it("puts West Edson TRD and Fox Creek Terminal near their towns, reads quarter and bare sections, and refuses NTS", () => {
    const edson = approximateFromLegalLocation("07-18-053-18 W5M")!;   // Edson 53.58, -116.44
    expect(Math.abs(edson.latitude - 53.58)).toBeLessThan(0.15);
    expect(Math.abs(edson.longitude - -116.44)).toBeLessThan(0.35);
    expect(edson.precision).toBe("approximate_site");
    const fox = approximateFromLegalLocation("13-36-062-20 W5M")!;     // Fox Creek 54.40, -116.80
    expect(Math.abs(fox.latitude - 54.40)).toBeLessThan(0.15);
    expect(Math.abs(fox.longitude - -116.80)).toBeLessThan(0.35);
    const q = approximateFromLegalLocation("SW-12-043-07 W5M")!;
    expect(q.note).toContain("SW quarter section");
    const sec = approximateFromLegalLocation("22-23-29-W4M")!;
    expect(sec.note).toContain("section (represented");
    expect(Math.abs(sec.latitude - 51.0)).toBeLessThan(0.15);   // township 23 west of the 4th: south Calgary
    // The regulator's other spellings: no dash before the meridian, no M, a fraction quarter, a space after the quarter.
    for (const form of ["08-01-055-18W5", "8-27-16-11 W4", "NE 27-59-26-W4M", "NW ¼ 15-53-23-W4M", "SE1/4 4-10-21-W4M", "01-03-049-10 W5M"]) expect(approximateFromLegalLocation(form), form).not.toBeNull();
    expect(approximateFromLegalLocation("D-096-K/094-A-12")).toBeNull();
    expect(approximateFromLegalLocation("A-08-088-20 W6M")).toBeNull();
  });
});
