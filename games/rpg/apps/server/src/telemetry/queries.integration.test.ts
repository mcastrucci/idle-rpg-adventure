import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import { AuthService, createDatabase, ManualClock } from '@engine/server-kit';
import type { Database } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { RPG_MIGRATIONS } from '../migrations.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for telemetry query tests');

describe('telemetry SQL source parsing', () => {
  it('extracts nine nonempty PostgreSQL queries without depending on a database', async () => {
    const source = await readFile(fileURLToPath(new URL('../../../../../../docs/queries/telemetry.sql', import.meta.url)), 'utf8');
    const sections = source.split(/(?=^-- Q\d+:)/m).filter(section => /^-- Q\d+:/m.test(section));
    const queries = sections.map(section => section.split('\n').filter(line => !line.startsWith('--')).join('\n').trim());
    expect(queries).toHaveLength(9);
    expect(queries.every(query => query.length > 0)).toBe(true);
  });
});

describe.skipIf(!adminUrl)('internal telemetry SQL (real PostgreSQL)', () => {
  let admin: Database;
  let database: Database;
  let auth: AuthService;
  let bundle: ReturnType<typeof compileBundle>;
  const databaseName = `rpg_telemetry_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(1_900_000_000_000);

  function compileBundle() {
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    return compiled.bundle;
  }

  beforeAll(async () => {
    bundle = compileBundle();
    const base = { databaseUrl: adminUrl as string, poolMax: 5, databaseTimeoutMs: 10000 };
    admin = createDatabase(base);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    database = createDatabase({ ...base, databaseUrl: url.toString() }, { migrationSets: [RPG_MIGRATIONS] });
    await database.migrate();
    auth = new AuthService(database, clock);
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  });

  it('executes each checked-in report query against migrated PostgreSQL and bounds crashed sessions at last_seen_at', async () => {
    const session = await auth.guest(randomBytes(32).toString('base64url'));
    const character = await database.db.transaction(tx => createCharacterService(tx, bundle as never).create(session.accountId, { name: 'Telemetry hero' }));
    const connectionId = randomUUID();
    await database.pool.query(`INSERT INTO rpg_connection_sessions (connection_id,account_id,started_at,last_seen_at,ended_at)
      VALUES ($1,$2,to_timestamp($3/1000.0),to_timestamp($4/1000.0),NULL)`,
      [connectionId, session.accountId, clock.nowMs() - 10_000, clock.nowMs() - 2_000]);
    await database.pool.query(`INSERT INTO rpg_area_discoveries (actor_id,area_id,location_id,discovered_at)
      VALUES ($1,'area:fixture','loc:fixture',to_timestamp($2/1000.0))`, [character.actorId, clock.nowMs() - 60_000]);
    const instanceId = randomUUID();
    await database.pool.query(`INSERT INTO live_instances
      (instance_id,game_id,game_version,content_hash,participants,status,node_id,lease_generation,lease_expires_at,
       checkpoint,checkpoint_seq,outcome,result,created_at,updated_at,closed_at)
      VALUES ($1,'rpg','test','testhash',$2::jsonb,'closed','test-node',1,to_timestamp($3/1000.0),
       '{}'::jsonb,0,'complete',NULL,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0))`,
      [instanceId, JSON.stringify([{ actorId: character.actorId }]), clock.nowMs(), clock.nowMs() - 3_600_000, clock.nowMs(), clock.nowMs()]);
    await database.pool.query(`INSERT INTO rpg_live_entries (instance_id,actor_id,area_id,started_at)
      VALUES ($1,$2,'area:fixture',to_timestamp($3/1000.0))`, [instanceId, character.actorId, clock.nowMs() - 3_600_000]);
    await database.pool.query(`INSERT INTO rpg_live_xp_events (instance_id,actor_id,source_id,occurred_at,granted_xp)
      VALUES ($1,$2,'xp:a',to_timestamp($3/1000.0),10),($1,$2,'xp:b',to_timestamp($3/1000.0),20)`, [instanceId, character.actorId, clock.nowMs()]);
    await database.pool.query(`INSERT INTO rpg_live_deaths
      (death_id,actor_id,instance_id,area_id,location_id,occurred_at,expires_at,status,xp_before_level,
       xp_before_into_level,xp_before_total,xp_lost,xp_after_level,xp_after_into_level,xp_after_total,causes,bag_snapshot)
      VALUES ($1,$2,$3,'area:fixture','loc:fixture',to_timestamp($4/1000.0),to_timestamp($5/1000.0),
       'recovered',1,10,10,5,1,5,5,'[]'::jsonb,'{}'::jsonb)`,
      [randomUUID(), character.actorId, instanceId, clock.nowMs(), clock.nowMs() + 60_000]);

    async function liveInstance(startMs: number, closeMs: number) {
      const id = randomUUID();
      await database.pool.query(`INSERT INTO live_instances
        (instance_id,game_id,game_version,content_hash,participants,status,node_id,lease_generation,lease_expires_at,
         checkpoint,checkpoint_seq,outcome,result,created_at,updated_at,closed_at)
        VALUES ($1,'rpg','test','testhash',$2::jsonb,'closed','test-node',1,to_timestamp($3/1000.0),
         '{}'::jsonb,0,'complete',NULL,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0))`,
        [id, JSON.stringify([{ actorId: character.actorId }]), clock.nowMs(), startMs, closeMs, closeMs]);
      await database.pool.query(`INSERT INTO rpg_live_entries (instance_id,actor_id,area_id,started_at)
        VALUES ($1,$2,'area:fixture',to_timestamp($3/1000.0))`, [id, character.actorId, startMs]);
      return id;
    }
    await liveInstance(clock.nowMs() - 30_000, clock.nowMs()); // no XP row: known zero
    await liveInstance(clock.nowMs(), clock.nowMs()); // recorded entry, but zero elapsed duration is excluded from rates
    const legacyInstanceId = randomUUID();
    await database.pool.query(`INSERT INTO live_instances
      (instance_id,game_id,game_version,content_hash,participants,status,node_id,lease_generation,lease_expires_at,
       checkpoint,checkpoint_seq,outcome,result,created_at,updated_at,closed_at)
      VALUES ($1,'rpg','legacy','legacyhash',$2::jsonb,'closed','test-node',1,to_timestamp($3/1000.0),
       '{}'::jsonb,0,'complete',NULL,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0))`,
      [legacyInstanceId, JSON.stringify([{ actorId: character.actorId }]), clock.nowMs(), clock.nowMs() - 10_000, clock.nowMs(), clock.nowMs()]);
    await database.pool.query(`INSERT INTO rpg_completed_areas (actor_id,area_id,completed_at)
      VALUES ($1,'area:fixture',to_timestamp($2/1000.0))`, [character.actorId, clock.nowMs() - 20_000]);
    await database.pool.query(`INSERT INTO rpg_region_conquered_events (actor_id,area_id,occurred_at)
      VALUES ($1,'area:fixture',to_timestamp($2/1000.0))`, [character.actorId, clock.nowMs() - 20_000]);

    async function expedition(status: 'completed' | 'cancelled' | 'running', report: unknown, opts: { recovery?: boolean; zero?: boolean } = {}) {
      const id = randomUUID(); const startMs = clock.nowMs() - 120_000;
      const endMs = opts.zero ? startMs : startMs + 60_000;
      const recovered = opts.recovery === true;
      const settledAt = status === 'running' ? null : new Date(clock.nowMs());
      const settledReason = status === 'running' ? null : recovered ? 'version_unavailable' : status === 'cancelled' ? 'cancelled' : 'completed';
      const settledCutoff = status === 'running' || recovered ? null : 0;
      const outcome = status === 'completed' ? 'completed' : null;
      await database.pool.query(`INSERT INTO rpg_expeditions
        (id,actor_id,account_id,area_id,activity_id,status,starts_at_ms,planned_ends_at_ms,ends_at_ms,duration_min,
         pace_bp,seed,revision,kernel_version,simulator_id,simulator_version,content_hash,budget,config,snapshot,escrow,
         timeline_compressed,timeline_hash,settled_at,settled_reason,settled_cutoff,outcome,terminal_report,created_at)
        VALUES ($1,$2,$3,'area:fixture','activity:test',$4,$5,$6,$7,1,10000,'seed',0,'kernel','sim','sim:1',
         'hash',1,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'timeline','hash',$8,$9,$10,$11,$12::jsonb,to_timestamp($5/1000.0))`,
        [id, character.actorId, session.accountId, status, startMs, startMs + 180_000, endMs, settledAt, settledReason,
          settledCutoff, outcome, report === null ? null : JSON.stringify(report)]);
    }
    const xp = [{ actorId: character.actorId, xpEarned: 20, xpPenaltyLost: 0, xpPenaltyApplied: false }];
    const validReport = { version: 1, kind: 'settled', endsAtMs: clock.nowMs() - 60_000, xp, outcome: 'completed', segments: [] };
    const deathReport = { ...validReport, segments: [{ events: [
      { type: 'death', actorId: character.actorId }, { type: 'death', actorId: character.actorId },
    ] }] };
    await expedition('completed', deathReport); // repeated owner death events count as one death-affected expedition, with zero XP penalty
    await expedition('cancelled', { ...validReport, outcome: 'cancelled', segments: [{ events: [] }] });
    await expedition('completed', { ...validReport, endsAtMs: clock.nowMs() - 120_000 }, { zero: true });
    await expedition('cancelled', { version: 1, kind: 'escrow_returned', xp, segments: [] }, { recovery: true });
    await expedition('completed', { version: 99, kind: 'settled', endsAtMs: clock.nowMs() - 60_000, xp, segments: [] });
    await expedition('running', null);
    // These two records intentionally match on every Q8 grouping field and report value; each id must remain a run.
    await expedition('completed', validReport);
    await expedition('completed', validReport);
    await expedition('completed', { ...validReport, endsAtMs: 'not-a-number' });
    await expedition('completed', { ...validReport, xp: [{ actorId: character.actorId, xpEarned: '20', xpPenaltyLost: 0 }] });
    await expedition('completed', { ...validReport, xp: [...xp, ...xp] });
    await expedition('completed', { ...validReport, version: '1' });
    await expedition('completed', { ...validReport, endsAtMs: clock.nowMs() + 100_000 });
    await expedition('completed', null); // legacy terminal row with SQL NULL report

    const source = await readFile(fileURLToPath(new URL('../../../../../../docs/queries/telemetry.sql', import.meta.url)), 'utf8');
    const sections = source.split(/(?=^-- Q\d+:)/m).filter(section => /^-- Q\d+:/m.test(section));
    expect(sections).toHaveLength(9);
    const results = [];
    for (const section of sections) {
      const query = section.split('\n').filter(line => !line.startsWith('--')).join('\n');
      results.push(await database.pool.query(query));
    }
    expect(results[0]?.rows).toMatchObject([{ account_id: session.accountId, connection_intervals: '1', observed_connected_seconds: '8.000000' }]);
    expect(results[0]?.rows[0]?.open_or_crashed_intervals).toBe('1');
    expect(results[1]?.rows).toHaveLength(1);
    expect(results[1]?.rows[0]?.actor_id).toBe(character.actorId);
    expect(Number(results[1]?.rows[0]?.['seconds_from_first_recorded_discovery_to_conquest'])).toBe(40);
    expect(results[2]?.rows).toHaveLength(14);
    expect(results[2]?.rows.find(row => row['status'] === 'running')).toMatchObject({ rate_covered: false, coverage_status: 'unsupported_or_recovery_report' });
    expect(results[2]?.rows.every(row => typeof row['rate_covered'] === 'boolean')).toBe(true);
    expect(results[2]?.rows.find(row => row['effective_duration_ms'] === '0')).toMatchObject({ rate_covered: false, coverage_status: 'unknown_or_zero_duration' });
    expect(results[3]?.rows).toHaveLength(1);
    expect(results[3]?.rows[0]).toMatchObject({ actor_id: character.actorId, area_id: 'area:fixture', closed_observed_entries: '3', positive_duration_entries: '2', excluded_nonpositive_duration_entries: '1', covered_elapsed_seconds: '3630.000000', gross_xp: '30', known_death_xp_penalty_lost: '5', net_xp: '25' });
    expect(Number(results[3]?.rows[0]?.['gross_xp_per_hour'])).toBeCloseTo(30 * 3600 / 3630, 8);
    expect(results[4]?.rows[0]).toMatchObject({ same_area_return_at: expect.any(Date) });
    expect(results[5]?.rows[0]?.availability).toBe('unavailable_unsupported');
    expect(results[6]?.rows[0]).toMatchObject({ starts: '14', running: '1', cancelled: '2', terminal_expeditions: '13', death_report_covered_expeditions: '9', expeditions_with_recorded_actor_death: '1', death_report_unknown_expeditions: '4', reports_with_actor_xp_penalty_applied: '0', unsupported_or_recovery_reports: '4' });
    expect(results[7]?.rows[0]).toMatchObject({ terminal_expeditions: '13', covered_expeditions: '4', excluded_or_uncovered_expeditions: '9', effective_duration_ms: '240000', gross_xp: '80', xp_penalty_lost: '0', net_xp: '80' });
    expect(Number(results[7]?.rows[0]?.['gross_xp_per_hour'])).toBe(1200);
    expect(Number(results[7]?.rows[0]?.['net_xp_per_hour'])).toBe(1200);
    expect(results[8]?.rows[0]).toMatchObject({ instrumented_attributed_participations: '3', legacy_or_unattributed_participations: '1', excluded_nonpositive_duration: '1' });
  });
});
