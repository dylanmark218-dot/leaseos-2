/**
 * Québec 511 roadworks, from the MTMD's WFS as published on Données Québec (`travaux-routiers`).
 *
 * Pure. No key. The WFS answers a GeoJSON FeatureCollection with `numberMatched`; each feature's
 * properties include `identifiant` (one per impediment — a work site, `identifiantChantier`, can
 * have several), `routeAutoroute`, `entraveType` ("Majeure (semaine)", "Mineure (fin de
 * semaine)"…), `entrave` (the impediment itself: "Route fermée en tout temps", "Fermeture de 1 voie
 * sur 2"…), `entravesLieesAuxChargesEtDimensions` (height, width and load limits), `debut`, `fin`
 * and `miseAJour` as `YYYY/MM/DD hh:mm:ss` Eastern time, and English and French descriptions.
 *
 * The load-and-dimension field is the reason this source is worth having for trucks: "Hauteur
 * libre : 4,3 mètres" is a clearance. It is carried into the headline in the publisher's words and
 * the advisory is typed as a restriction — and it stays advisory, because a roadworks feed
 * reporting a clearance is not the verified structure record a route may be cleared or blocked on.
 */

import type { AdvisorySeverity, AdvisoryType, RoadAdvisory } from "../advisoryImpact";
import type { FeedEndpoint } from "../feedHttp";
import type { Normalizer } from "../feedIngest";
import { clip, EXTERNAL_REF_MAX, fromDateText, HEADLINE_MAX, IncompleteSnapshotError, ROAD_NAME_MAX } from "./fields";
import { coveringCircle, geometryCoordinates } from "./placement";

export const QUEBEC_TIMEZONE = "America/Toronto";

export const QUEBEC_ROADWORKS_ENDPOINT: FeedEndpoint = {
  sourceKey: "qc_mtmd_roadworks",
  url: "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:chantiers_mtmdet&srsname=EPSG:4326&outputformat=geojson",
  credentialStyle: { kind: "none" },
  timeoutMs: 60_000,
  acceptHeader: "application/geo+json, application/json",
};

export const QUEBEC_SNAPSHOT = "full" as const;

export function parseQuebecRoadworks(body: string): unknown[] {
  const parsed = JSON.parse(body) as { type?: string; features?: unknown; numberMatched?: unknown } | null;
  if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("expected a GeoJSON FeatureCollection");
  }
  // A WFS that matched more than it returned has truncated the listing; withdrawing on it is wrong.
  if (typeof parsed.numberMatched === "number" && parsed.numberMatched > parsed.features.length) {
    throw new IncompleteSnapshotError(
      `the service matched ${parsed.numberMatched} works and returned ${parsed.features.length}; ingesting it as the whole would withdraw live works`,
    );
  }
  return parsed.features;
}

type Props = {
  identifiant?: string;
  routeAutoroute?: string;
  entraveType?: string;
  entrave?: string;
  entravesLieesAuxChargesEtDimensions?: string;
  debut?: string;
  fin?: string;
  miseAJour?: string;
  descriptionAnglais?: string;
  descriptionFrancais?: string;
  identificationDesTravaux?: string;
};

/** A road, motorway or bridge closed outright is a closure. A ramp or an access closed is not. */
const FULL_CLOSURE = /^(route|autoroute|pont|tunnel|chemin|rang)\s+ferm[ée]e?/i;

export function quebecSeverity(p: Pick<Props, "entrave" | "entraveType">): AdvisorySeverity {
  if (FULL_CLOSURE.test((p.entrave ?? "").trim())) return "closure";
  const t = (p.entraveType ?? "").trim().toLowerCase();
  if (t.startsWith("majeure")) return "major";
  if (t.startsWith("mineure")) return "minor";
  return "unknown";
}

export function quebecRoadworksNormalizer(retrievedAt: Date): Normalizer {
  return (raw, index) => {
    const f = (raw ?? {}) as { id?: unknown; properties?: Props; geometry?: unknown };
    const p = f.properties ?? {};
    const externalRef = clip(p.identifiant ?? (f.id === undefined ? null : String(f.id)), EXTERNAL_REF_MAX);
    if (!externalRef) return { ok: false, reason: `feature ${index} has no identifiant` };

    const loads = clip(p.entravesLieesAuxChargesEtDimensions, 200);
    const description = clip(p.descriptionAnglais, HEADLINE_MAX) ?? clip(p.descriptionFrancais, HEADLINE_MAX) ?? clip(p.identificationDesTravaux, HEADLINE_MAX);
    if (!description) return { ok: false, reason: `work ${externalRef} has no description` };
    const headline = clip(loads ? `${description} — Charges et dimensions : ${loads}` : description, HEADLINE_MAX)!;

    const severity = quebecSeverity(p);
    const advisoryType: AdvisoryType = severity === "closure" ? "closure" : loads ? "restriction" : "construction";
    const circle = coveringCircle(geometryCoordinates(f.geometry));
    const route = clip(p.routeAutoroute, ROAD_NAME_MAX);

    const advisory: RoadAdvisory = {
      sourceKey: "qc_mtmd_roadworks",
      externalRef,
      advisoryType,
      severity,
      headline,
      roadName: route ? clip(`Route ${route}`, ROAD_NAME_MAX) : null,
      point: circle?.point ?? null,
      radiusMetres: circle?.radiusMetres ?? null,
      effectiveFrom: fromDateText(p.debut, QUEBEC_TIMEZONE),
      effectiveTo: fromDateText(p.fin, QUEBEC_TIMEZONE),
      sourceUpdatedAt: fromDateText(p.miseAJour, QUEBEC_TIMEZONE),
      retrievedAt,
      advisoryOnly: true,
    };
    return { ok: true, advisory };
  };
}
