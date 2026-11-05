import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_BACKGROUND_WEBP_BYTES, findPublicAssetViolations } from './public-assets-guard.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'public-guard-'));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Buffer.alloc(bytes));
  }
  return root;
}

test('accepts runtime art: WebP backgrounds within budget, sprite atlases and JSON', () => {
  const root = tree({
    'assets/region-1/backgrounds/webp/a.webp': MAX_BACKGROUND_WEBP_BYTES,
    'assets/region-1/sprites/hero.png': 300_000,
    'assets/region-1/sprites/hero.json': 100,
    'assets/region-1/manifest.json': 100,
  });
  try { assert.deepEqual(findPublicAssetViolations(root), []); } finally { rmSync(root, { recursive: true }); }
});

test('rejects native PNG sources by folder and by -native suffix', () => {
  const root = tree({
    'assets/region-1/backgrounds/source/a.png': 10,
    'assets/region-1/sprites/hero-native.png': 10,
    'assets/region-1/sprites/Source/b.PNG': 10,
  });
  try {
    const found = findPublicAssetViolations(root);
    assert.equal(found.length, 3);
    assert.ok(found.every((message) => /native art source/.test(message)));
  } finally { rmSync(root, { recursive: true }); }
});

test('rejects a background WebP above 600 KB but not other WebPs', () => {
  const root = tree({
    'assets/region-1/backgrounds/webp/big.webp': MAX_BACKGROUND_WEBP_BYTES + 1,
    'assets/icons/huge.webp': MAX_BACKGROUND_WEBP_BYTES + 1,
  });
  try {
    const found = findPublicAssetViolations(root);
    assert.equal(found.length, 1);
    assert.match(found[0], /region-1\/backgrounds\/webp\/big\.webp/);
  } finally { rmSync(root, { recursive: true }); }
});

test('rejects non-runtime files inside a region folder', () => {
  const root = tree({
    'assets/region-1/previews-360/a.jpg': 10,
    'assets/region-1/mockup/index.html': 10,
    'assets/region-1/generation.json': 10,
    'assets/region-1/README.md': 10,
    'assets/region-1/sprites/atlas.txt': 10,
    'assets/region-1/sprites/sub/x.png': 10,
    'assets/region-1/backgrounds/webp/a.png': 10,
    'assets/region-1/backgrounds/webp/ok.webp': 10,
    'assets/region-1/sprites/ok.png': 10,
    'assets/region-1/manifest.json': 10,
  });
  try {
    const found = findPublicAssetViolations(root);
    assert.equal(found.length, 7);
    assert.ok(found.every((message) => /only manifest\.json/.test(message)));
  } finally { rmSync(root, { recursive: true }); }
});

test('the real public/ folder is clean', () => {
  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  assert.deepEqual(findPublicAssetViolations(publicDir), []);
});
