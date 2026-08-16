import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` opens TCP sockets; it must not be bundled into the server chunk.
  serverExternalPackages: ["pg"],
  typedRoutes: false,
};

export default nextConfig;
