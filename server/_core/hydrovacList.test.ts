import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hydrovacFacilityKey, parseHydrovacList } from "./hydrovacList";

const rows = parseHydrovacList(readFileSync("data/ab-hydrovac-facilities-2026-04-10.txt", "utf8"));

describe("Alberta hydrovac facilities list (2026-04-10)", () => {
  it("reads every authorization on the list, sorting AER (WM) from EPA numbers, north from south", () => {
    expect(rows.length).toBeGreaterThanOrEqual(84);
    expect(rows.filter(r => r.regulator === "AER").length).toBeGreaterThanOrEqual(50);
    expect(rows.filter(r => r.regulator === "EPA").length).toBeGreaterThanOrEqual(30);
    expect(rows.filter(r => r.region === "NORTH").length).toBeGreaterThan(40);
    expect(rows.filter(r => r.region === "SOUTH").length).toBeGreaterThan(30);
    expect(rows.every(r => r.raw.length > 0)).toBe(true);
  });
  it("extracts the shape-unambiguous fields on known rows", () => {
    const pure = rows.find(r => r.authorization === "WM 212")!;
    expect(pure).toMatchObject({ regulator: "AER", region: "NORTH", legalLocation: "9-14-063-04-W4M", place: "Fort Kent", phones: ["587-792-0855"], acceptableMaterial: "A hazardous waste management facility", hazardousAllowed: true, contactFacility: false });
    expect(pure.company).toMatch(/^Pure Environmental Waste Management/);
    const westEdson = rows.find(r => r.authorization === "WM 078")!;
    expect(westEdson).toMatchObject({ legalLocation: "07-18-053-18-W5M", place: "West Edson", phones: ["780-723-1912"], hazardousAllowed: true });
    expect(westEdson.company).toBe("Tervita Corporation");   // the list still says Tervita; our aliases say who runs it now
    const village = rows.find(r => r.authorization === "00432185")!;
    expect(village).toMatchObject({ regulator: "EPA", place: "Edmonton", phones: ["780-446-8444"], acceptableMaterial: "Non-hazardous Waste", hazardousAllowed: false, legalLocation: null });
    expect(village.address).toContain("6415-75 Street");
    const solid = rows.find(r => r.authorization === "00429869")!;
    expect(solid).toMatchObject({ acceptableMaterial: "Non-contaminated hydrovac slurry", hazardousAllowed: false, phones: ["780-915-3755"] });
    const voda = rows.find(r => r.authorization === "WM 074")!;
    expect(voda.emails).toEqual(["dhumphries@vodamidstream.com"]);
    expect(voda.phones).toEqual(["403-827-4801"]);
  });
  it("keeps two rows that share WM 042 apart by place, and tokenizes two rows that share a line", () => {
    const wm042 = rows.filter(r => r.authorization === "WM 042");
    expect(wm042.map(r => r.place).sort()).toEqual(["Elk Point", "Niton Junction"]);
    expect(new Set(wm042.map(hydrovacFacilityKey)).size).toBe(2);
    expect(rows.find(r => r.authorization === "00010348")).toMatchObject({ place: "Ryley", phones: ["780-663-3828"], contactFacility: true });
    expect(rows.find(r => r.authorization === "00430733")).toMatchObject({ place: "Wheatland County", phones: ["403-361-1027"] });
    expect(rows.find(r => r.authorization === "00358359")).toMatchObject({ place: "Calgary", acceptableMaterial: "Hazardous, non-hazardous, and hydrovac material" });
    expect(rows.find(r => r.authorization === "WM 146")).toMatchObject({ place: "Rocky Mountain House", legalLocation: "03-04-040-08W5" });
  });
});
