/**
 * Release identity. APP_VERSION is bumped by hand for each release; BUILD_ID is
 * stamped per image build and is what the update check compares.
 */
export const APP_VERSION = "1.9.1";

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

/** Build ids are stamped as b<YYYYMMDDHHMMSS> in UTC at image build time. */
export function buildTime(buildId: string = BUILD_ID): Date | null {
  const m = /^b(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(buildId);
  if (!m) return null;
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

/** Server's build id, or null when it can't be determined. Browser only. */
export async function fetchServerBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const version =
      data && typeof data === "object" ? (data as { version?: unknown }).version : null;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** True when the server is running a different build than this page. */
export async function isUpdateAvailable(): Promise<boolean> {
  if (BUILD_ID === "dev") return false;
  const server = await fetchServerBuildId();
  return !!server && server !== "dev" && server !== BUILD_ID;
}

/** Drop cached bundles so the reload genuinely picks up the new build. */
export async function applyUpdate(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update().catch(() => undefined);
    }
  } catch {
    // Best effort — the reload below still fetches fresh HTML.
  }
  window.location.reload();
}
