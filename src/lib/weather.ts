/**
 * One-line daily forecast via Open-Meteo (free, keyless), used to make the
 * morning briefing weather-aware. Best-effort: any failure returns "".
 */
import "server-only";

const CACHE_TTL_MS = 30 * 60_000;
let cache: { key: string; at: number; line: string } | null = null;

export async function todayWeatherLine(lat: number, lng: number, tz: string): Promise<string> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.line;

  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
      temperature_unit: "fahrenheit",
      timezone: tz,
      forecast_days: "1",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as {
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
        weather_code?: number[];
      };
    };
    const hi = data.daily?.temperature_2m_max?.[0];
    const lo = data.daily?.temperature_2m_min?.[0];
    const rain = data.daily?.precipitation_probability_max?.[0];
    const code = data.daily?.weather_code?.[0];
    if (typeof hi !== "number") return "";

    const parts = [`high ${Math.round(hi)}°F`];
    if (typeof lo === "number") parts.push(`low ${Math.round(lo)}°F`);
    if (typeof code === "number") parts.push(describeWeatherCode(code));
    if (typeof rain === "number" && rain >= 25) parts.push(`${Math.round(rain)}% chance of rain`);

    const line = parts.filter(Boolean).join(", ");
    cache = { key, at: Date.now(), line };
    return line;
  } catch {
    return "";
  }
}

/** WMO weather codes → plain words. */
function describeWeatherCode(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "mostly clear";
  if (code === 3) return "overcast";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzly";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 86) return "snow showers";
  return "stormy";
}
