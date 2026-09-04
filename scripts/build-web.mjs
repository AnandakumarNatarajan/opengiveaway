// Bundle the isomorphic verifier core into a single IIFE and inline it into the
// HTML template, producing a fully self-contained web/verifier.html that runs
// offline (open it from disk) with no dependencies and no server.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Vendor the supabase-js UMD build so the organizer app has no external CDN
// dependency (works air-gapped / behind strict CSPs). Served at /vendor/.
const vendorDir = join(root, "web/vendor");
mkdirSync(vendorDir, { recursive: true });
copyFileSync(
  join(root, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"),
  join(vendorDir, "supabase.js"),
);
console.log("Vendored web/vendor/supabase.js");

const result = await build({
  entryPoints: [join(root, "src/verify/browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "OGV",
  target: ["es2020"],
  write: false,
  minify: false,
});

const bundle = result.outputFiles[0].text;
const template = readFileSync(join(root, "web/verifier.template.html"), "utf8");
const html = template.replace("/*__BUNDLE__*/", () => bundle);

const outPath = join(root, "web/verifier.html");
writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KiB, self-contained)`);
