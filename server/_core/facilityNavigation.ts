import type { CoordinatePrecision } from "../../shared/facilities";

type Point = { lat: number; lon: number };
export type FacilityLinkInput = { precision: CoordinatePrecision; entrance?: Point; site?: Point; phone?: string; email?: string; websiteUrl?: string; accountRegistrationUrl?: string; googleMapsPlaceUrl?: string };
export type FacilityLinks = { googleDirections: string | null; googlePlace: string | null; appleDirections: string | null; androidIntent: string | null; tel: string | null; mailto: string | null; website: string | null; accountRegistration: string | null };

export function buildFacilityLinks(input: FacilityLinkInput): FacilityLinks {
  const routable = input.precision === "verified_entrance" || input.precision === "verified_site";
  const point = routable ? input.entrance ?? input.site : undefined;
  const destination = point ? `${point.lat},${point.lon}` : null;
  const google = destination ? new URL("https://www.google.com/maps/dir/") : null;
  if (google && destination) { google.searchParams.set("api", "1"); google.searchParams.set("destination", destination); }
  const apple = destination ? new URL("https://maps.apple.com/") : null;
  if (apple && destination) { apple.searchParams.set("daddr", destination); apple.searchParams.set("dirflg", "d"); }
  const phone = input.phone?.replace(/[^+\d]/g, "") || null;
  return {
    googleDirections: google?.toString() ?? null, googlePlace: input.googleMapsPlaceUrl ?? null,
    appleDirections: apple?.toString() ?? null, androidIntent: destination ? `geo:${destination}?q=${encodeURIComponent(destination)}` : null,
    tel: phone ? `tel:${phone}` : null, mailto: input.email ? `mailto:${encodeURIComponent(input.email)}` : null,
    website: input.websiteUrl ?? null, accountRegistration: input.accountRegistrationUrl ?? null,
  };
}
