/**
 * Inverse map projections for regulator GIS layers (pure; GRS80/NAD83 ellipsoid).
 *
 *  - Saskatchewan Petroleum facilities: NAD83(CSRS) / UTM zone 13N (EPSG 2957; stored WKID 2151).
 *  - BC Energy Regulator layers: NAD83 / BC Albers (EPSG 3005; stored WKID 102190).
 *
 * Both are standard closed forms (Snyder). NAD83/NAD83(CSRS) are treated as WGS84 for
 * a facility gate — the datum shift is under two metres in these regions.
 */
const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, E = Math.sqrt(E2);
const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;

/** Transverse Mercator inverse (UTM): zone from the WKID, northern hemisphere. */
export function utmToLatLon(easting: number, northing: number, zone: number): { latitude: number; longitude: number } {
  const k0 = 0.9996, x = easting - 500_000, y = northing;
  const lon0 = rad(-183 + 6 * zone);
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y / k0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const ep2 = E2 / (1 - E2);
  const C1 = ep2 * Math.cos(phi1) ** 2, T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2), R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);
  return { latitude: deg(lat), longitude: deg(lon) };
}

/** Transverse Mercator forward (for round-trip tests). */
export function latLonToUtm(latitude: number, longitude: number, zone: number): { easting: number; northing: number } {
  const k0 = 0.9996, lat = rad(latitude), lon = rad(longitude), lon0 = rad(-183 + 6 * zone);
  const ep2 = E2 / (1 - E2), N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2), T = Math.tan(lat) ** 2, C = ep2 * Math.cos(lat) ** 2, Aa = Math.cos(lat) * (lon - lon0);
  const M = A * ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * lat - ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat) + ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat) - ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat));
  const easting = 500_000 + k0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Aa ** 5) / 120);
  const northing = k0 * (M + N * Math.tan(lat) * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Aa ** 6) / 720));
  return { easting, northing };
}

/** BC Albers (EPSG 3005) inverse: standard parallels 50°N and 58.5°N, origin 45°N / 126°W, false easting 1,000,000. */
const BC = { phi1: rad(50), phi2: rad(58.5), phi0: rad(45), lon0: rad(-126), fe: 1_000_000, fn: 0 };
const mOf = (phi: number) => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
const qOf = (phi: number) => (1 - E2) * (Math.sin(phi) / (1 - E2 * Math.sin(phi) ** 2) - (1 / (2 * E)) * Math.log((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))));
export function bcAlbersToLatLon(x: number, y: number): { latitude: number; longitude: number } {
  const m1 = mOf(BC.phi1), m2 = mOf(BC.phi2), q0 = qOf(BC.phi0), q1 = qOf(BC.phi1), q2 = qOf(BC.phi2);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1), Cc = m1 * m1 + n * q1, rho0 = (A * Math.sqrt(Cc - n * q0)) / n;
  const xx = x - BC.fe, yy = y - BC.fn;
  const rho = Math.sqrt(xx * xx + (rho0 - yy) ** 2), theta = Math.atan2(xx, rho0 - yy);
  const q = (Cc - (rho * rho * n * n) / (A * A)) / n;
  let phi = Math.asin(q / 2);
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(phi), es = E * s;
    const dphi = ((1 - E2 * s * s) ** 2 / (2 * Math.cos(phi))) * (q / (1 - E2) - s / (1 - E2 * s * s) + (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
    phi += dphi; if (Math.abs(dphi) < 1e-12) break;
  }
  return { latitude: deg(phi), longitude: deg(BC.lon0 + theta / n) };
}
export function latLonToBcAlbers(latitude: number, longitude: number): { x: number; y: number } {
  const m1 = mOf(BC.phi1), m2 = mOf(BC.phi2), q0 = qOf(BC.phi0), q1 = qOf(BC.phi1), q2 = qOf(BC.phi2);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1), Cc = m1 * m1 + n * q1, rho0 = (A * Math.sqrt(Cc - n * q0)) / n;
  const phi = rad(latitude), theta = n * (rad(longitude) - BC.lon0), rho = (A * Math.sqrt(Cc - n * qOf(phi))) / n;
  return { x: BC.fe + rho * Math.sin(theta), y: BC.fn + rho0 - rho * Math.cos(theta) };
}

/** Which inverse a layer needs, by its spatial reference. */
export function projectToLatLon(x: number, y: number, wkid: number): { latitude: number; longitude: number } | null {
  if (wkid === 4326 || wkid === 4269 || wkid === 4617) return { latitude: y, longitude: x };
  if (wkid === 2957 || wkid === 2151 || wkid === 26913) return utmToLatLon(x, y, 13);
  if (wkid === 26912 || wkid === 2956) return utmToLatLon(x, y, 12);
  if (wkid === 26911 || wkid === 2955) return utmToLatLon(x, y, 11);
  if (wkid === 3005 || wkid === 102190) return bcAlbersToLatLon(x, y);
  return null;
}
