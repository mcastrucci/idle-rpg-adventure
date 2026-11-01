import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.ts';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = 'fixtures/sample-content';
const GAME = 'fixtures/sample-game.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'content-cli-'));
  temps.push(dir);
  return dir;
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    cwd: packageDir,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

describe('content-cli', () => {
  it('validates the sample content', async () => {
    const { code, stdout } = await run('validate', SAMPLE, '--game', GAME);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Content OK \(contentHash [0-9a-f]{64}\)\n$/);
  });

  it('builds a bundle and checks it against itself as --previous', async () => {
    const out = path.join(tempDir(), 'dist', 'bundle.json');
    expect((await run('build', SAMPLE, '--game', GAME, '--out', out)).code).toBe(0);
    const bundle = JSON.parse(readFileSync(out, 'utf8')) as { contentHash: string; game: string };
    expect(bundle.game).toBe('sample');
    expect((await run('build', SAMPLE, '--game', GAME, '--out', out, '--previous', out)).code).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { contentHash: string }).contentHash).toBe(bundle.contentHash);
  });

  it('fails a build whose frozen baseline changed, printing grouped errors', async () => {
    const dir = tempDir();
    const previous = path.join(dir, 'previous.json');
    expect((await run('build', SAMPLE, '--game', GAME, '--out', previous)).code).toBe(0);
    const root = path.join(dir, 'content');
    cpSync(path.join(packageDir, SAMPLE), root, { recursive: true });
    const areaFile = path.join(root, 'world/areas/grove.json');
    const area = JSON.parse(readFileSync(areaFile, 'utf8')) as { completion: { frozen: { at: string } } };
    area.completion.frozen.at = '2026-12-24';
    writeFileSync(areaFile, JSON.stringify(area));

    const { code, stderr } = await run('build', root, '--game', GAME, '--out', path.join(dir, 'out.json'), '--previous', previous);
    expect(code).toBe(1);
    expect(stderr).toContain('world/areas/grove.json\n  baseline.frozenChanged  $.completion.frozen.at  ');
    expect(stderr).toContain('1 error\n');
  });

  it('prints Mermaid graphs of the world map and of one area', async () => {
    const world = await run('graph', SAMPLE, '--game', GAME);
    expect(world.code).toBe(0);
    expect(world.stdout).toContain('graph LR');
    expect(world.stdout).toContain('area_camp(("area:camp<br/>hub"))');
    expect(world.stdout).toContain('area_camp -- "route:camp_to_grove" --> area_grove');

    const area = await run('graph', SAMPLE, '--game', GAME, '--area', 'area:grove');
    expect(area.stdout).toContain('graph TD');
    expect(area.stdout).toContain('loc_grove_pond -. "exit:grove.pond_hollow" .-> loc_grove_hollow');

    expect((await run('graph', SAMPLE, '--game', GAME, '--area', 'area:nowhere')).code).toBe(2);
  });

  it('exports JSON Schemas for world and game collections', async () => {
    const { code, stdout } = await run('schema', '--game', GAME);
    expect(code).toBe(0);
    const schemas = JSON.parse(stdout) as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(schemas)).toEqual(['areas', 'locations', 'routes', 'widgets']);
    expect(schemas['widgets']?.properties).toHaveProperty('location');
  });

  it('reports usage errors with exit code 2', async () => {
    expect((await run()).code).toBe(2);
    expect((await run('validate', SAMPLE)).stderr).toContain('--game <module> is required');
    expect((await run('frobnicate', SAMPLE, '--game', GAME)).code).toBe(2);
    expect((await run('validate', SAMPLE, '--game', './missing.ts')).stderr).toContain('Cannot load game module');
  });

  it('runs as a real process through bin.ts (Node type stripping)', () => {
    const ok = spawnSync(process.execPath, ['src/bin.ts', 'validate', SAMPLE, '--game', GAME], { cwd: packageDir, encoding: 'utf8' });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Content OK');

    const bad = spawnSync(process.execPath, ['src/bin.ts', 'validate', 'fixtures', '--game', GAME], { cwd: packageDir, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('file.unknownCollection');
  });
});
