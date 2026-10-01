import type { NextConfig } from "next";
const config: NextConfig = {
  typescript: { tsconfigPath: "tsconfig.hosted.json" },
  poweredByHeader: false,
};
export default config;
