import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const entries: Array<[string, string]> = [
  ["src/frontend/app.ts", "static/js/app.js"],
  ["src/frontend/session.ts", "static/js/session.js"],
  ["src/frontend/chat.ts", "static/js/chat.js"],
];

for (const [entryPoint, outfile] of entries) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    legalComments: "none",
    banner: {
      js: `// Generated from ${entryPoint}. Do not edit static/js output directly.`,
    },
  });
}
