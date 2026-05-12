/**
 * Widget bundle inlining + HTML loading for MCP App resources.
 *
 * MCP App widgets render inside a sandboxed iframe with a strict CSP — they
 * cannot fetch script bundles from a CDN. So the @modelcontextprotocol/ext-apps
 * browser bundle has to be inlined into the widget HTML at server startup.
 *
 * The bundle ships as an ESM file ending in `export {...}`. We rewrite the
 * export statement into a `globalThis.ExtApps = {...}` assignment so a plain
 * `<script type="module">` block inside the widget HTML can grab it via the
 * global without ever issuing a network request.
 *
 * Widget HTML files live in `src/widgets/`; at build time `npm run build`
 * copies them to `dist/widgets/`. At dev/test time we also fall back to the
 * `src/widgets/` path (since `tsx watch` runs straight off source). Tests
 * that mock this module will short-circuit the file I/O entirely.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Lazy-cached so we only do the file read + rewrite once per process even if
// multiple widgets reuse the same bundle.
let cachedBundle: string | null = null;

/**
 * Read the ext-apps browser bundle and rewrite its trailing `export {...}`
 * into `globalThis.ExtApps = {...}` so the widget can pick it up via the
 * global. The `() => bundle` replacer form on `String.replace` is deliberate:
 * the minified bundle is full of `$` sequences that a string replacement
 * would mangle.
 */
export function getExtAppsBundle(): string {
  if (cachedBundle !== null) return cachedBundle;
  const bundlePath = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const raw = readFileSync(bundlePath, "utf8");
  cachedBundle = raw.replace(/export\{([^}]+)\};?\s*$/, (_, body: string) => {
    const entries = body
      .split(",")
      .map((pair) => {
        const [local, exported] = pair.split(" as ").map((s) => s.trim());
        const key = exported ?? local;
        return `${key}:${local}`;
      })
      .join(",");
    return `globalThis.ExtApps={${entries}};`;
  });
  return cachedBundle;
}

/**
 * Resolve a widget HTML file. We check `dist/widgets/<name>` first (production
 * post-build) and then `src/widgets/<name>` (dev mode via tsx, or running
 * tests). Throws with a clear message if neither path exists — that's a build
 * misconfiguration, not a user error.
 */
function resolveWidgetPath(filename: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From src/lib/widgets.ts → ../widgets/<filename> in source tree.
  // From dist/lib/widgets.js → ../widgets/<filename> in build output.
  const local = resolve(here, "..", "widgets", filename);
  if (existsSync(local)) return local;

  // Belt-and-suspenders: when running from dist, fall back to looking in the
  // sibling src/widgets/ for dev runs that load compiled output without the
  // copy-widgets step.
  const repoRoot = resolve(here, "..", "..");
  const sourceFallback = resolve(repoRoot, "src", "widgets", filename);
  if (existsSync(sourceFallback)) return sourceFallback;

  throw new Error(
    `Widget HTML not found: tried ${local} and ${sourceFallback}. ` +
    `Run \`npm run build\` to copy widgets into dist/.`
  );
}

/**
 * Load a widget HTML file and inline the ext-apps bundle into the
 * `/*__EXT_APPS_BUNDLE__*\/` placeholder. The result is the fully
 * self-contained HTML the MCP host renders inside its iframe.
 */
export function loadWidgetHtml(filename: string): string {
  const html = readFileSync(resolveWidgetPath(filename), "utf8");
  const bundle = getExtAppsBundle();
  return html.replace("/*__EXT_APPS_BUNDLE__*/", () => bundle);
}
