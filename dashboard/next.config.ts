import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Strict mode to surface React lifecycle issues early in development.
  reactStrictMode: true,

  // Forward the MCP server's Supabase URL as a build-time constant so
  // server components can call Supabase without NEXT_PUBLIC_ exposure.
  // Add any additional server-only env vars here.
  serverExternalPackages: ["stripe"],
};

export default nextConfig;
