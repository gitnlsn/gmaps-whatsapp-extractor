import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` opens TCP sockets; it must not be bundled into the server chunk.
  serverExternalPackages: ["pg"],
  typedRoutes: false,

  // @leads/core ships TypeScript source rather than a build artifact, so Next
  // has to compile it like first-party code. Without this the workspace import
  // fails at build time under pnpm's symlinked node_modules.
  transpilePackages: ["@leads/core"],

  // `next dev` and `next build` both write to the build directory, so running a
  // build while the dev server is up corrupts both (the build fails resolving
  // chunks the dev server has just rewritten). Overriding this lets a
  // verification build run alongside dev: NEXT_DIST_DIR=.next-build npm run build
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
