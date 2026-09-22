import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The workspace packages ship TypeScript source rather than a build step.
  transpilePackages: ["@platform/db", "@platform/shared"],

  // In a monorepo, Next guesses the trace root from the nearest lockfile and
  // can miss workspace dependencies, which then go missing from the deployed
  // bundle. Point it at the repo root explicitly.
  outputFileTracingRoot: join(here, "..", ".."),

  experimental: {
    // Server actions touch the database pool; keep them on the Node runtime.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
