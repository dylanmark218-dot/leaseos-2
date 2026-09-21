/**
 * v22.17 — The channel banks, seeded unverified.
 *
 * These are candidate rows carrying their citation, not regulatory truth.
 * Every row lands `unverified`, which means `transmitAuthorization` can never
 * return `authorized` from a seed alone — the channel-record gate answers
 * `unknown` until a person opens the cited ISED page and verifies the row
 * against it. That is the same rule the tax and compliance seeds live under,
 * and it is the rule that keeps a stale frequency out of a driver's hand.
 *
 * Two things are seeded and two are deliberately not:
 *
 *   SEEDED      the standardized banks — BC resource-road and loading
 *               channels, the Canadian CB/GRS allocation, and the western and
 *               northern mobile-only frequencies commonly called LADD.
 *   NOT SEEDED  company and operator channels. Those come from the operator's
 *               own road-use document or a posted sign, through the import and
 *               observation paths, because a frequency scraped from a scanner
 *               site may be expired, reassigned, or licensed to somebody else.
 *
 * Public-safety and amateur allocations are not seeded at all. They are real
 * and they are documented, and neither is a trucking channel.
 */

import type { GeoCondition, RadioChannel } from "./commRoute";

export const CHANNEL_SEED_RETRIEVAL_DATE = new Date("2026-09-11T00:00:00Z");

const ISED_BC_RR_CITATION =
  "ISED — Conditions of Licence appendix: RR British Columbia Resource Road Channels";
const ISED_B1_CITATION =
  "ISED — Conditions of Licence appendix B1: Western and Northern Canada Mobile-Only Frequencies";
const ISED_CB_CITATION =
  "ISED — RSS-236: General Radio Service equipment operating in the band 26.960–27.410 MHz";

const base = (o: Partial<RadioChannel>): RadioChannel => ({
  channelKey: "",
  alias: "",
  serviceClass: "land_mobile_b1",
  systemType: "simplex",
  rxMHz: null,
  txMHz: null,
  toneRxHz: null,
  toneTxHz: null,
  bandwidthKHz: null,
  maxPowerW: null,
  licenceRequired: true,
  conditions: [],
  sourceKey: "ised_b1_western",
  sourceCitation: ISED_B1_CITATION,
  sourceVersion: "retrieved 2026-09-11",
  verificationStatus: "unverified",
  ...o,
});

/* ------------------------------------------------------------------ */
/* BC resource road: RR-01 … RR-35                                      */
/* ------------------------------------------------------------------ */

/**
 * Kilometre and location calls on posted resource roads. BC's own guidance is
 * that the whole bank is programmed and the posted sign governs, so every one
 * of these carries `posted_use_only` — which resolves to
 * `requires_posted_channel` rather than `authorized` unless the governing
 * assignment for that road came from a sign.
 */
const RR_MHZ = [
  150.080, 150.110, 150.140, 150.185, 150.200, 150.245, 150.260, 150.320, 150.365, 150.410,
  150.440, 150.500, 150.530, 150.545, 150.560, 150.590, 150.680, 150.710, 150.770, 150.830,
  151.010, 151.130, 151.190, 151.220, 151.310, 151.340, 151.370, 151.430, 151.460, 151.490,
  151.520, 151.580, 151.610, 151.640, 151.670,
];

export const BC_RESOURCE_ROAD_CHANNELS: readonly RadioChannel[] = RR_MHZ.map((mhz, i) => {
  const n = String(i + 1).padStart(2, "0");
  return base({
    channelKey: `RR-${n}`,
    alias: `BC Resource Road ${n}`,
    serviceClass: "bc_resource_road",
    rxMHz: mhz,
    txMHz: mhz,
    bandwidthKHz: 11.25,
    licenceRequired: true,
    sourceKey: "ised_bc_rr",
    sourceCitation: ISED_BC_RR_CITATION,
    conditions: [
      { kind: "provinces_permitted", provinces: ["BC"] },
      {
        kind: "posted_use_only",
        note: "Authorized for use where posted on a BC resource road. ISED prohibits amateur, marine and user-programmable radios on this service; the road sign governs over any map.",
      },
    ] as GeoCondition[],
  });
});

/* ------------------------------------------------------------------ */
/* BC loading / worksite: LD-01 … LD-14                                 */
/* ------------------------------------------------------------------ */

/** Worksites and loading areas — a different purpose from the RR bank, and kept apart from it. */
const LD_MHZ = [
  151.700, 151.745, 151.790, 151.805, 151.850, 150.485, 153.215,
  154.665, 152.330, 153.635, 157.590, 159.750, 164.010, 165.960,
];

export const BC_LOADING_CHANNELS: readonly RadioChannel[] = LD_MHZ.map((mhz, i) => {
  const n = String(i + 1).padStart(2, "0");
  return base({
    channelKey: `LD-${n}`,
    alias: `BC Loading ${n}`,
    serviceClass: "bc_loading",
    rxMHz: mhz,
    txMHz: mhz,
    bandwidthKHz: 11.25,
    licenceRequired: true,
    sourceKey: "ised_bc_rr",
    sourceCitation: ISED_BC_RR_CITATION,
    conditions: [
      { kind: "provinces_permitted", provinces: ["BC"] },
      { kind: "posted_use_only", note: "Loading and worksite use where assigned. ISED states geographical restrictions for LD-02 through LD-05 that are not loaded here." },
    ] as GeoCondition[],
  });
});

/* ------------------------------------------------------------------ */
/* Canadian CB / General Radio Service: 1 … 40                          */
/* ------------------------------------------------------------------ */

/**
 * Licence-exempt, and the only bank here that is. Note that channels 23, 24
 * and 25 are not in ascending order — that is the allocation, not a typo, and
 * a test pins it because "fixing" it would be a real defect.
 *
 * Channel 19 is widely monitored for road information in many areas. It is
 * not a mandatory or universal trucking channel and is not seeded as one.
 */
const CB_MHZ = [
  26.965, 26.975, 26.985, 27.005, 27.015, 27.025, 27.035, 27.055, 27.065, 27.075,
  27.085, 27.105, 27.115, 27.125, 27.135, 27.155, 27.165, 27.175, 27.185, 27.205,
  27.215, 27.225, 27.255, 27.235, 27.245, 27.265, 27.275, 27.285, 27.295, 27.305,
  27.315, 27.325, 27.335, 27.345, 27.355, 27.365, 27.375, 27.385, 27.395, 27.405,
];

const CB_NOTES: Record<number, string> = {
  9: "Emergency communications",
  11: "Calling channel",
  13: "Marine search and rescue",
  19: "Used in many areas for road information",
  23: "Land search and rescue",
};

export const CB_GRS_CHANNELS: readonly RadioChannel[] = CB_MHZ.map((mhz, i) => {
  const n = i + 1;
  return base({
    channelKey: `CB-${String(n).padStart(2, "0")}`,
    alias: CB_NOTES[n] ? `CB ${n} — ${CB_NOTES[n]}` : `CB ${n}`,
    serviceClass: "cb_grs",
    systemType: "cb",
    rxMHz: mhz,
    txMHz: mhz,
    maxPowerW: 4,
    licenceRequired: false,
    sourceKey: "ised_cb_grs",
    sourceCitation: ISED_CB_CITATION,
    conditions: [{ kind: "provinces_permitted", provinces: ["AB", "BC", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL", "YT", "NT", "NU"] }],
  });
});

/* ------------------------------------------------------------------ */
/* ISED B1 — western and northern mobile-only                           */
/* ------------------------------------------------------------------ */

/**
 * The bank Alberta backroad trucking actually runs on, and the one where a
 * static menu is most dangerous: these are licensed mobile frequencies with
 * geographic exclusions written into the authorization. LAD-1 is not usable
 * across most of southern and central Alberta; LAD-2 and LAD-3 are not listed
 * for Alberta at all. A driver whose radio happens to contain LAD-2 is not
 * thereby authorized to key up on it in Alberta, and this is the bank that
 * makes LeaseOS able to say so.
 *
 * The exclusion centres below are approximate town positions — good enough to
 * decide a 50–100 km radius, and carrying their own unverified status like
 * every other field here.
 */
export const ISED_B1_WESTERN_CHANNELS: readonly RadioChannel[] = [
  base({
    channelKey: "AB-153.050",
    alias: "153.050 MHz",
    rxMHz: 153.050, txMHz: 153.050,
    conditions: [
      { kind: "provinces_permitted", provinces: ["AB"] },
      { kind: "excluded_within_radius", latitude: 51.0375, longitude: -113.3817, radiusKm: 90, placeName: "Strathmore" },
    ],
  }),
  base({
    channelKey: "LAD-1",
    alias: "LADD 1 — 154.100 MHz",
    rxMHz: 154.100, txMHz: 154.100,
    conditions: [
      { kind: "provinces_permitted", provinces: ["AB", "BC", "YT", "NT", "NU"] },
      { kind: "excluded_south_of_latitude", latitude: 53.5, note: "Alberta exclusion south of 53°30′00″" },
      { kind: "excluded_within_radius", latitude: 54.2667, longitude: -110.7333, radiusKm: 100, placeName: "Bonnyville" },
    ],
  }),
  base({
    channelKey: "LAD-3",
    alias: "LADD 3 — 154.325 MHz",
    rxMHz: 154.325, txMHz: 154.325,
    // Not listed for Alberta. This is the row that stops LeaseOS telling an
    // Alberta driver to use LADD 3 because their radio has it programmed.
    conditions: [{ kind: "provinces_permitted", provinces: ["BC", "YT", "NT", "NU"] }],
  }),
  base({
    channelKey: "LAD-2",
    alias: "LADD 2 — 158.940 MHz",
    rxMHz: 158.940, txMHz: 158.940,
    conditions: [{ kind: "provinces_permitted", provinces: ["BC", "YT", "NT", "NU"] }],
  }),
  base({
    channelKey: "AB-162.210",
    alias: "162.210 MHz",
    rxMHz: 162.210, txMHz: 162.210,
    conditions: [
      { kind: "provinces_permitted", provinces: ["AB"] },
      { kind: "excluded_within_radius", latitude: 51.4333, longitude: -114.0333, radiusKm: 50, placeName: "Crossfield" },
    ],
  }),
  base({
    channelKey: "AB-163.050",
    alias: "163.050 MHz",
    rxMHz: 163.050, txMHz: 163.050,
    conditions: [{ kind: "provinces_permitted", provinces: ["AB", "SK", "MB"] }],
  }),
  base({
    channelKey: "AB-165.480",
    alias: "165.480 MHz",
    rxMHz: 165.480, txMHz: 165.480,
    conditions: [{ kind: "provinces_permitted", provinces: ["AB", "SK", "MB"] }],
  }),
  base({
    channelKey: "AB-166.620",
    alias: "166.620 MHz",
    rxMHz: 166.620, txMHz: 166.620,
    // ISED states several geographical exclusions for this frequency that are
    // not captured here. The channel stays unverified, so every authorization
    // it could produce is UNKNOWN — which is the correct answer while the
    // exclusions are unread, and better than a confident permission.
    conditions: [{ kind: "provinces_permitted", provinces: ["AB"] }],
  }),
  base({
    channelKey: "AB-168.120",
    alias: "168.120 MHz",
    rxMHz: 168.120, txMHz: 168.120,
    conditions: [
      { kind: "provinces_permitted", provinces: ["AB"] },
      { kind: "excluded_within_radius", latitude: 51.4254, longitude: -116.1773, radiusKm: 50, placeName: "Lake Louise" },
    ],
  }),
  base({
    channelKey: "LAD-4",
    alias: "LADD 4 — 173.370 MHz",
    rxMHz: 173.370, txMHz: 173.370,
    conditions: [{ kind: "provinces_permitted", provinces: ["AB", "BC", "SK", "YT", "NT", "NU"] }],
  }),
];

export const ALL_CHANNEL_SEEDS: readonly RadioChannel[] = [
  ...BC_RESOURCE_ROAD_CHANNELS,
  ...BC_LOADING_CHANNELS,
  ...CB_GRS_CHANNELS,
  ...ISED_B1_WESTERN_CHANNELS,
];

/**
 * What the seeds are and are not, carried to any screen that shows them.
 * A seed is a candidate; an unverified candidate authorizes nothing.
 */
export const CHANNEL_SEED_CAVEAT =
  "Seeded from the cited ISED publications and unverified. A channel authorizes no transmission until a person verifies its record against the citation, and the channel posted on the road governs over any of it.";
