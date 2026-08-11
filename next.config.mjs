// Identifies this build. Baked into both the client bundle and the server at
// build time (via `env`), so a running client can compare itself against the
// deployed server and notice when it is out of date — an installed PWA can
// otherwise keep an old bundle alive for days.
//
// It MUST come from the environment: this config is evaluated once per
// compilation (server and client separately), so generating a value here
// would hand the two halves different ids and fake a permanent update prompt.
// The Dockerfile stamps one per image build; "dev" disables the check.
const buildId =
  process.env.NEXT_PUBLIC_BUILD_ID?.trim() ||
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ||
  "dev";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  ...(buildId === "dev" ? {} : { generateBuildId: async () => buildId }),
  headers: async () => [
    {
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Service-Worker-Allowed", value: "/" },
      ],
    },
  ],
};

export default nextConfig;
