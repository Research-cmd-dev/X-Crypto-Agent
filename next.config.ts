import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only packages that should not be bundled into the client.
  serverExternalPackages: ["@trigger.dev/sdk", "@octokit/rest"],
  eslint: {
    // Keep `next build` focused on type/build errors in CI; lint runs separately.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
