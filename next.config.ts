import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

// Next.js was inferring workspace root from ~/package-lock.json (home directory),
// which breaks Tailwind/CSS resolution. Pin Turbopack root to this app.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // Some server routes access runtime-configured filesystem paths. Without
  // exclusions, Next's tracer can conservatively pull repository and prior
  // packaging output into the standalone server (and then into the installer).
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**/*",
      "./artifacts/**/*",
      "./data/**/*",
      "./dist-electron/**/*",
      "./docs/**/*",
      "./electron/**/*",
      "./public/**/*",
      "./scripts/**/*",
      "./src/**/*",
      "./tests/**/*",
      "./.env*",
      "./*.md",
      "./components.json",
      "./electron-builder.json",
      "./eslint.config.mjs",
      "./next.config.ts",
      "./postcss.config.mjs",
      "./requirements.txt",
      "./tsconfig*.json",
      "./tsconfig*.tsbuildinfo",
    ],
  },
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;