import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const exposeOnLan = process.argv.includes('--host');

function packageVersion(name: string): string {
  // Read package.json next to the resolved entry (works even when "./package.json" is not exported).
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

/** Emits `build-info.json`: per page entry, the JS reachable from it (raw + gzip bytes), for the bundle-size metric. */
function buildInfo(): Plugin {
  return {
    name: 'render-spike-build-info',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map<string, { code: string; imports: string[]; dynamicImports: string[] }>();
      const entries: { name: string; fileName: string }[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        chunks.set(item.fileName, item);
        if (item.isEntry) entries.push({ name: item.name, fileName: item.fileName });
      }
      const info: Record<string, { files: string[]; rawBytes: number; gzipBytes: number }> = {};
      for (const entry of entries) {
        const seen = new Set<string>();
        const visit = (file: string): void => {
          if (seen.has(file)) return;
          seen.add(file);
          const c = chunks.get(file);
          c?.imports.forEach(visit);
          c?.dynamicImports.forEach(visit);
        };
        visit(entry.fileName);
        let rawBytes = 0;
        let gzipBytes = 0;
        for (const f of seen) {
          const code = Buffer.from(chunks.get(f)?.code ?? '');
          rawBytes += code.length;
          gzipBytes += gzipSync(code, { level: 9 }).length;
        }
        info[entry.name] = { files: [...seen].sort(), rawBytes, gzipBytes };
      }
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: `${JSON.stringify(info, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  // Relative base: dist/ works from any static path (sub-folder hosting, Capacitor's webDir).
  base: './',
  plugins: [buildInfo()],
  define: {
    __PIXI_VERSION__: JSON.stringify(packageVersion('pixi.js')),
    __PHASER_VERSION__: JSON.stringify(packageVersion('phaser')),
  },
  // pnpm forwards `dev -- --host` as a literal `-- --host`, which the Vite CLI ignores; honour it here so both
  // `pnpm --filter @spikes/render-mobile dev --host` and `... dev -- --host` expose the server on the LAN.
  server: { port: 5180, ...(exposeOnLan ? { host: true } : {}) },
  preview: { port: 5180, ...(exposeOnLan ? { host: true } : {}) },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Phaser is a single large module; the bundle size is itself a measured result.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        pixi: resolve(root, 'pixi.html'),
        phaser: resolve(root, 'phaser.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
