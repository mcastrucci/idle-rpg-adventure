/**
 * #154: tappable scene geometry in the live view, against real PostgreSQL and a format-2 content bundle. Region 1 has no
 * authored Tiled scene yet, so the bundle attaches fixture geometry to the production `lantern_ruins` location (it has a
 * flag-gated secret exit). The view a player receives over HTTP must not contain the secret exit's region before the
 * hatch is found, and must contain it afterwards.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory, contentHashOf } from '@engine/content-compiler';
import { AuthService, createDatabase, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { parseLiveCurrent } from '@rpg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { createRpgDatabase, createRpgServer } from '../index.ts';
import { createRpgLiveHost, startRpgLiveInstance } from './index.ts';
import type { RpgLiveHost } from './index.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for scene geometry PostgreSQL tests');
const RUINS = 'loc:region_1.lantern_ruins';
const SECRET = 'exit:region_1.lantern_ruins.sunken_greenhouse';
const token = () => randomBytes(32).toString('base64url');

describe.skipIf(!adminUrl)('live view scene geometry (real PostgreSQL, format-2 bundle)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let directory: string;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  let auth: AuthService;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let live: RpgLiveHost;
  const databaseName = `scene_geometry_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'scene-geometry-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const world = structuredClone(compiled.bundle.world) as { locations: { id: string; scene?: string; exits: { id: string }[] }[] };
    const ruins = world.locations.find((location) => location.id === RUINS);
    if (!ruins) throw new Error('lantern_ruins is missing');
    ruins.scene = 'scenes/region_1/lantern_ruins.tmj';
    const rect = (x: number) => ({ x, y: 100, width: 40, height: 40 });
    const body = {
      format: 2 as const, game: compiled.bundle.game, world, collections: compiled.bundle.collections,
      scenes: { [RUINS]: { width: 543, height: 724, background: 'scenes/region_1/lantern_ruins.png',
        exits: Object.fromEntries(ruins.exits.map((exit, index) => [exit.id, rect(index * 100)])),
        hotspots: { cracked_panel: rect(400) }, enemyAnchors: {}, resources: { 'res:alloy_scrap#0': { x: 5, y: 5 } } } },
    };
    content = { ...body, contentHash: contentHashOf(body) } as never;
    const bundlePath = join(directory, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: bundlePath, LOG_LEVEL: 'silent', ROLES: 'api,live' });
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString() };
    database = createRpgDatabase(config);
    await database.migrate();
    auth = new AuthService(database, clock);
    live = createRpgLiveHost({ autoStart: false, nodeId: 'scene-geometry', leaseMs: 30_000, graceMs: 60_000 });
    app = await createRpgServer(config, { clock, live });
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps an undiscovered secret exit out of the payload and sends it after the hatch is found', async () => {
    const session = await auth.guest(token());
    const hero = await database.db.transaction((tx) => createCharacterService(tx, content as never).create(session.accountId, { name: 'Scene hero' }));
    const headers = { authorization: `Bearer ${session.sessionToken}` };
    const instanceId = await startRpgLiveInstance(live, database, { actorIds: [hero.actorId], area: 'area:region_1', location: RUINS });
    const current = async () => {
      const response = await app.inject({ url: `/live/current/${hero.actorId}`, headers });
      expect(response.statusCode).toBe(200);
      return { raw: response.body, parsed: parseLiveCurrent(response.json()).current?.view };
    };

    const before = await current();
    expect(before.raw).not.toContain(SECRET);
    expect(before.parsed?.scene).toMatchObject({ width: 543, height: 724 });
    expect(before.parsed?.scene?.regions).toEqual([
      { id: 'exit:region_1.lantern_ruins.tangle_orchard', kind: 'exit', x: 20, y: 120, r: 20 },
      { id: 'exit:region_1.lantern_ruins.pump_station', kind: 'exit', x: 120, y: 120, r: 20 },
      { id: 'cracked_panel', kind: 'hotspot', x: 420, y: 120, r: 20 }]);

    await live.host().attach(instanceId, hero.actorId, session.accountId, { id: randomUUID(), push: () => {} });
    const result = await live.host().submit(instanceId, hero.actorId, session.accountId, randomUUID(), { type: 'interact', hotspotId: 'cracked_panel' } as never);
    expect(result.ack.status).toBe('applied');
    const after = await current();
    expect(after.parsed?.scene?.regions.map((region) => region.id)).toEqual([
      'exit:region_1.lantern_ruins.tangle_orchard', 'exit:region_1.lantern_ruins.pump_station', SECRET, 'cracked_panel']);
    expect((after.parsed?.['exits'] as { id: string }[]).find((exit) => exit.id === SECRET)).toMatchObject({ open: true });
  });
});
