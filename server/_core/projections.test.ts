import { describe, expect, it } from "vitest";
import { bcAlbersToLatLon, latLonToBcAlbers, latLonToUtm, projectToLatLon, utmToLatLon } from "./projections";

describe("regulator layer projections", () => {
  it("UTM 13N round-trips Regina and Kindersley to within a metre, and lands Regina's easting/northing where the UTM grid says", () => {
    for (const [lat, lon] of [[50.4452, -104.6189], [51.4667, -109.1667], [54.0, -105.0]]) {
      const { easting, northing } = latLonToUtm(lat, lon, 13);
      const back = utmToLatLon(easting, northing, 13);
      expect(Math.abs(back.latitude - lat)).toBeLessThan(1e-5);
      expect(Math.abs(back.longitude - lon)).toBeLessThan(1e-5);
    }
    const regina = latLonToUtm(50.4452, -104.6189, 13);   // 13U ~527 000 E, ~5 588 000 N
    expect(Math.abs(regina.easting - 527_000)).toBeLessThan(2_500);
    expect(Math.abs(regina.northing - 5_588_000)).toBeLessThan(2_500);
    expect(utmToLatLon(500_000, 0, 13).longitude).toBeCloseTo(-105, 6);   // the zone's central meridian at the equator
  });
  it("BC Albers round-trips Fort St. John and Vancouver, and its origin sits at 45°N 126°W with the false easting", () => {
    for (const [lat, lon] of [[56.2524, -120.8476], [49.2827, -123.1207], [58.8, -122.7]]) {
      const { x, y } = latLonToBcAlbers(lat, lon);
      const back = bcAlbersToLatLon(x, y);
      expect(Math.abs(back.latitude - lat)).toBeLessThan(1e-6);
      expect(Math.abs(back.longitude - lon)).toBeLessThan(1e-6);
    }
    const origin = bcAlbersToLatLon(1_000_000, 0);
    expect(origin.latitude).toBeCloseTo(45, 5); expect(origin.longitude).toBeCloseTo(-126, 5);
    const fsj = latLonToBcAlbers(56.2524, -120.8476);   // BC Albers x ~1.31 million, y ~1.27 million
    expect(fsj.x).toBeGreaterThan(1_200_000); expect(fsj.x).toBeLessThan(1_400_000);
    expect(fsj.y).toBeGreaterThan(1_150_000); expect(fsj.y).toBeLessThan(1_400_000);
  });
  it("routes a WKID to the right inverse and refuses an unknown one", () => {
    expect(projectToLatLon(-110, 52, 4326)).toEqual({ latitude: 52, longitude: -110 });
    expect(projectToLatLon(500_000, 5_800_000, 2957)!.longitude).toBeCloseTo(-105, 3);
    expect(projectToLatLon(1_000_000, 0, 102190)!.latitude).toBeCloseTo(45, 4);
    expect(projectToLatLon(1, 2, 99999)).toBeNull();
  });
});
