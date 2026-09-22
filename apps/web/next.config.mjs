/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than a build step.
  transpilePackages: ["@platform/db", "@platform/shared"],
  experimental: {
    // Server actions touch the database pool; keep them on the Node runtime.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
