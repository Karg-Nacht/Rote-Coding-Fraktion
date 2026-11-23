import { build } from "esbuild";
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["electron", "node:sqlite"],
  packages: "external",
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
});
