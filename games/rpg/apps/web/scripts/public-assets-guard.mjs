/**
 * Guard for `public/` (#160): it is copied verbatim into the web build and the Docker image, so it may only hold
 * runtime assets. Native art sources belong in games/rpg/art/; background WebPs stay within the download budget.
 * CLI: `node public-assets-guard.mjs [publicDir]`; exits 1 and lists every violation.
 */
import { readdirSync, statSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BACKGROUND_WEBP_BYTES = 600 * 1024;

const SOURCE_MARKERS = ['/source/', '-native'];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Returns one message per violation, with paths relative to `publicDir` and `/` separators. */
export function findPublicAssetViolations(publicDir) {
  const violations = [];
  for (const file of walk(publicDir)) {
    const rel = `/${relative(publicDir, file).split(/[\\/]/).join('/')}`;
    const lower = rel.toLowerCase();
    if (SOURCE_MARKERS.some((marker) => lower.includes(marker)) && /\.(png|psd|tif|tiff|kra|aseprite)$/.test(lower)) {
      violations.push(`${rel.slice(1)}: native art source is not a runtime asset; keep it under games/rpg/art/`);
    }
    if (/\/backgrounds\/.*\.webp$/.test(lower)) {
      const bytes = statSync(file).size;
      if (bytes > MAX_BACKGROUND_WEBP_BYTES) violations.push(`${rel.slice(1)}: ${bytes} bytes exceeds the ${MAX_BACKGROUND_WEBP_BYTES} byte background budget`);
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));
  const violations = findPublicAssetViolations(publicDir);
  if (violations.length > 0) {
    process.stderr.write(`public/ guard failed:\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('public/ guard passed\n');
}
