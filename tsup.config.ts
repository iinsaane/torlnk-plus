import { defineConfig } from "tsup";

export default defineConfig({
  entry: { plus: "src/plus/index.tsx", worker: "src/plus/worker.ts", "search-worker": "src/plus/search-worker.ts", "webtorrent-worker": "src/plus/webtorrent-worker.ts", supervisor: "src/plus/supervisor.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  shims: false,
  minify: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
  },
});
