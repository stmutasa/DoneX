/**
 * Google Places (New) text search over REST, using the Maps API key from
 * Settings. No SDK, no map embed — just place resolution for task locations.
 */
import "server-only";
import { settingsRepo } from "@/lib/db/repos";
import type { PlaceResult } from "@/lib/types";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

export const MAPS_NOT_CONFIGURED =
  "No Maps API key — add one in Settings → Google to attach locations";

export function mapsConfigured(): boolean {
  return !!settingsRepo.getApp().google.mapsApiKey.trim();
}

/** Turns Google's error wording into the actual fix. */
function explainPlacesError(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("api_key_invalid") || lower.includes("api key not valid")) {
    return "Google rejected the Maps API key — re-copy it from Google Cloud → Credentials";
  }
  if (lower.includes("permission_denied") || lower.includes("has not been used") || lower.includes("is disabled")) {
    return "Enable the “Places API (New)” for your project in Google Cloud, then try again";
  }
  if (lower.includes("referer") || lower.includes("restricted")) {
    return "The Maps key's restrictions block this server — in Google Cloud, set the key's application restriction to “None” (or IP-based)";
  }
  return `Place search failed (${status})`;
}

export async function searchPlaces(
  query: string,
  near?: { lat: number; lng: number } | null,
): Promise<PlaceResult[]> {
  const apiKey = settingsRepo.getApp().google.mapsApiKey.trim();
  if (!apiKey) throw new Error(MAPS_NOT_CONFIGURED);

  const body: Record<string, unknown> = { textQuery: query, maxResultCount: 6 };
  if (near) {
    // Bias (not restrict) toward the user's position so "CVS" finds theirs.
    body.locationBias = {
      circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30_000 },
    };
  }

  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(explainPlacesError(res.status, raw));
  }

  const data = (await res.json()) as {
    places?: {
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    }[];
  };

  return (data.places ?? [])
    .map((p) => ({
      name: p.displayName?.text?.trim() || "",
      address: p.formattedAddress?.trim() || "",
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    }))
    .filter(
      (p): p is PlaceResult =>
        !!p.name && typeof p.lat === "number" && typeof p.lng === "number",
    );
}
