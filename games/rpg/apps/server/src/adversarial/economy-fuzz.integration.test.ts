/**
 * Spike 3 (#13): seeded, concurrent fuzzing of the player-facing economy paths against real PostgreSQL.
 *
 * Operations go through the same public HTTP routes players use (inventory commands, expedition start/cancel/read,
 * live start) with real `command_id`s, plus the settlement job handler and the live host for closing instances. After
 * every round (and at the end) a REPEATABLE READ audit asserts the ledger invariants, activity-lock consistency and
 * at-most-once settlement. Business rejections (busy, insufficient funds, idempotency conflict, start gates) are
 * expected; any 5xx, unexpected status/error code or invariant violation fails the test.
 *
 * Reproduce a run with `ECONOMY_FUZZ_SEED=<printed seed>`. The sequence of generated operations is a pure function of
 * the seed (given the same database state); the interleaving of concurrent requests is up to PostgreSQL and the Node
 * scheduler, so a failing seed is a strong lead, not a guaranteed byte-for-byte replay. `ECONOMY_FUZZ_ROUNDS` and
 * `ECONOMY_FUZZ_OPS` scale the run.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentDirectory } from '@engine/content-compiler';
import type { LiveConnection } from '@engine/live-kernel';
import { applyLedgerDeltas, AuthService, checkLedgerInvariants, createDatabase, itemInstances, ManualClock, parseServerConfig } from '@engine/server-kit';
import type { Database, ServerConfig } from '@engine/server-kit';
import plugin from '@rpg/content-plugin';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCharacterService } from '../characters/service.ts';
import { createRpgDatabase, createRpgServer, createRpgLiveHost } from '../index.ts';
import type { RpgLiveHost } from '../index.ts';
import { recordAreaCompletion } from '../expeditions/progress.ts';
import { expeditions } from '../expeditions/schema.ts';
import { createExpeditionService } from '../expeditions/service.ts';

const adminUrl = process.env['TEST_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) throw new Error('CI must supply TEST_DATABASE_URL for the real PostgreSQL economy fuzz test');

const REGION = 'area:region_1';
const HUNT = 'idle:region_1.hunt';
const POTION = 'item:minor_healing_potion';
const SAP = 'item:sap_tonic';
const SWORD = 'item:rusty_sword';
/** Authored materials with a sell value (glowcap 2, amber resin 3 gold). */
const MATERIALS = [{ item: 'item:glowcap', value: 2 }, { item: 'item:amber_resin', value: 3 }] as const;
const START_AT = 1_800_000_000_000;
const MINUTE = 60_000;
const OFFERS = [
  { id: 'offer:minor_healing_potion', item: POTION, price: 12 },
  { id: 'offer:sap_tonic', item: SAP, price: 18 },
  { id: 'offer:healing_potion', item: 'item:healing_potion', price: 40 },
] as const;
const STARTING_GOLD = 160;
const STARTING_POTIONS = 3;
const BASE_PLAYERS = 6;
/** Commands are retained for 24 simulated hours; only replay inside that window (older ids are a 410 tombstone case). */
const COMMAND_REPLAY_WINDOW_MS = 20 * 60 * MINUTE;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
const SEED = intFromEnv('ECONOMY_FUZZ_SEED', randomInt(1, 0xffff_ffff), 1, 0xffff_ffff);
const ROUNDS = intFromEnv('ECONOMY_FUZZ_ROUNDS', 30, 1, 500);
const OPS_PER_ROUND = intFromEnv('ECONOMY_FUZZ_OPS', 20, 1, 200);
/** Explicit budget: about 0.3 s per round alone, 2 s per round of headroom for a loaded CI machine (default size: 2 min). */
const FUZZ_TIMEOUT_MS = 60_000 + ROUNDS * 2_000;

/** mulberry32: tiny, fast, 32-bit deterministic generator; test infrastructure only (not simulator code). */
class Prng {
  #state: number;
  constructor(seed: number) { this.#state = seed >>> 0; }
  u32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(maxExclusive: number): number { return this.u32() % maxExclusive; }
  chance(percent: number): boolean { return this.int(100) < percent; }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RangeError('cannot pick from an empty list');
    return item;
  }
}

interface Player {
  readonly label: string;
  readonly accountId: string;
  readonly sessionToken: string;
  readonly actorId: string;
  readonly swords: readonly string[];
  readonly model: { spentGold: number; earnedGold: number; bought: Map<string, number>; sold: Map<string, number>; starts: number };
}
interface Reply { readonly status: number; readonly body: unknown }
interface Applied { readonly atMs: number; readonly player: Player; readonly url: string; readonly envelope: unknown; readonly reply: Reply;
  readonly variant: (() => unknown) | null }

const errorOf = (body: unknown): string | undefined =>
  body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : undefined;

describe.skipIf(!adminUrl)('seeded concurrent economy fuzz against real PostgreSQL (spike 3, #13)', () => {
  let admin: Database;
  let database: Database;
  let config: ServerConfig;
  let app: Awaited<ReturnType<typeof createRpgServer>>;
  let worker: Awaited<ReturnType<typeof createRpgServer>> | undefined;
  let live: RpgLiveHost;
  let directory: string;
  let auth: AuthService;
  let content: Extract<ReturnType<typeof compileContentDirectory>, { ok: true }>['bundle'];
  const databaseName = `economy_fuzz_${randomUUID().replaceAll('-', '')}`;
  const clock = new ManualClock(START_AT);
  const rng = new Prng(SEED);
  const seedRng = new Prng(SEED ^ 0x9e37_79b9);
  const players: Player[] = [];
  const applied: Applied[] = [];
  const violations: string[] = [];
  const stats = new Map<string, number>();
  let round = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'economy-fuzz-'));
    const compiled = compileContentDirectory(fileURLToPath(new URL('../../../../content', import.meta.url)), plugin);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    content = compiled.bundle;
    const path = join(directory, 'bundle.json');
    await writeFile(path, JSON.stringify(content));
    const base = parseServerConfig({ DATABASE_URL: adminUrl, CONTENT_BUNDLE_PATH: path, LOG_LEVEL: 'error' });
    admin = createDatabase(base);
    restoreClientQuery = recordRejectedQueries((admin.pool as unknown as { Client: { prototype: { query: QueryFunction } } }).Client);
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(base.databaseUrl); url.pathname = `/${databaseName}`;
    config = { ...base, databaseUrl: url.toString(), roles: ['api', 'live'] };
    database = createRpgDatabase(config);
    await database.migrate();
    // The manual clock runs for many simulated hours; keep guest sessions valid for the whole run.
    auth = new AuthService(database, clock, { sessionTtlMs: 30 * 24 * 60 * MINUTE });
    live = createRpgLiveHost({ autoStart: false, nodeId: 'economy-fuzz', leaseMs: 30_000, graceMs: 60_000 });
    app = await createRpgServer(config, { clock, live, seedSource: () => seedRng.u32() });
    // The real PostgreSQL-backed settlement worker races the lazy reads and the explicit job-handler calls below.
    worker = await createRpgServer({ ...config, roles: ['worker'] }, { clock });
  }, 60_000);

  afterAll(async () => {
    restoreClientQuery?.();
    await worker?.close();
    await app?.close();
    await database?.close();
    if (admin) {
      try { await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  // ---- helpers ---------------------------------------------------------------------------------------------------
  const where = () => `[seed=${SEED} round=${round}]`;
  const bump = (key: string) => stats.set(key, (stats.get(key) ?? 0) + 1);
  const violate = (message: string) => { violations.push(`${where()} ${message}`); };
  const bearer = (player: Pick<Player, 'sessionToken'>) => ({ authorization: `Bearer ${player.sessionToken}` });
  const envelope = (operation: string, payload: Record<string, unknown>, commandId: string = randomUUID()) =>
    ({ command_id: commandId, operation, payload });

  async function createPlayer(label: string, options: { gold: number; potions: number; swords: number; materials?: number }): Promise<Player> {
    const session = await auth.guest(randomBytes(32).toString('base64url'));
    const hero = await database.db.transaction(tx => createCharacterService(tx, content as never).create(session.accountId, { name: 'Fuzz hero' }));
    const deltas = [] as { actorId: string; asset: { kind: 'currency'; currency: 'gold' } | { kind: 'stack'; item: string } | { kind: 'unique_mint'; item: string }; qty: number }[];
    if (options.gold) deltas.push({ actorId: hero.actorId, asset: { kind: 'currency', currency: 'gold' }, qty: options.gold });
    if (options.potions) deltas.push({ actorId: hero.actorId, asset: { kind: 'stack', item: POTION }, qty: options.potions });
    if (options.swords) deltas.push({ actorId: hero.actorId, asset: { kind: 'unique_mint', item: SWORD }, qty: options.swords });
    if (options.materials) for (const material of MATERIALS) deltas.push({ actorId: hero.actorId, asset: { kind: 'stack', item: material.item }, qty: options.materials });
    if (deltas.length) await database.db.transaction(tx => applyLedgerDeltas(tx, { type: 'test_fixture', id: `${hero.actorId}:fuzz` }, deltas));
    await database.db.transaction(tx => recordAreaCompletion(tx, clock, hero.actorId, REGION));
    const swords = (await database.db.select().from(itemInstances).where(eq(itemInstances.actorId, hero.actorId))).map(row => row.id).sort();
    const player: Player = { label, accountId: session.accountId, sessionToken: session.sessionToken, actorId: hero.actorId, swords,
      model: { spentGold: 0, earnedGold: 0, bought: new Map(), sold: new Map(), starts: 0 } };
    players.push(player);
    return player;
  }

  /**
   * Environmental failures that say nothing about the economy: PostgreSQL out of connection slots (53300, e.g. several
   * `pnpm check` runs sharing one server), a client/statement timeout, or a dropped connection. Issue #135: under load
   * `settleJob` once threw "sorry, too many clients already" and was reported as an invariant violation.
   */
  const INFRASTRUCTURE_PATTERN = /too many clients|remaining connection slots|timeout exceeded when trying to connect|Connection terminated|query read timeout|statement timeout|canceling statement|ECONNRESET|ECONNREFUSED|57P01/i;
  /** Drizzle wraps driver errors ("Failed query: ..."), so the SQLSTATE and the message live somewhere on the `cause` chain. */
  const isInfrastructureError = (error: unknown): boolean => {
    for (let current = error, depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
      const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (code === '53300' || code === '57014' || code === '57P01' || code === '08006' || code === '08003' || code === '08001') return true;
      if (INFRASTRUCTURE_PATTERN.test(typeof message === 'string' ? message : String(current))) return true;
      current = cause;
    }
    return false;
  };
  const INFRA_ATTEMPTS = 6;
  const backoff = (attempt: number) => new Promise<void>(resolve => { setTimeout(resolve, 100 * attempt * attempt); });

  /**
   * Direct service calls (settlement job handlers) are idempotent and retried by the real job queue, so an infrastructure
   * failure is retried here too. A genuine failure, or an infrastructure failure that outlasts the retries, is reported;
   * the latter under its own `INFRASTRUCTURE` label so nobody mistakes it for a ledger breach.
   */
  async function directCall<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); }
      catch (error) {
        if (!isInfrastructureError(error)) { violate(`${name} threw ${String(error)}`); return undefined; }
        bump(`infraRetry:${name}`);
        if (attempt >= INFRA_ATTEMPTS) { violate(`INFRASTRUCTURE (not an economy invariant breach): ${name} failed ${attempt} times: ${String(error)}`); return undefined; }
        await backoff(attempt);
      }
    }
  }

  // ---- driver-level error recorder -------------------------------------------------------------------------------------
  /**
   * The server answers every unexpected failure with an opaque 500 `internal_error`, and its error log has no request id and
   * only a sanitised code, so a 500 cannot be tied to its cause through the logs. Instead every rejected query of every `pg`
   * client in this process (the app's and worker's drizzle pools, pg-boss, the audit transaction: all share one `pg` module
   * and its `Client.prototype.query`) is recorded here with a sequence number, and a 500 is judged by the errors recorded
   * while its request was in flight.
   *
   * Deliberately strict: windows of concurrent requests overlap, so a non-infrastructure error (deadlock 40P01, serialization
   * failure 40001, unique violation 23505, ...) from a neighbouring request also condemns a 500 that happened at the same time.
   * That can only make the fuzz fail more often, never hide a bug.
   *
   * Residual gap: a 500 caused by a non-database bug (a thrown invariant) that overlaps an infrastructure error of another
   * request would be retried. It would pass only if the retry then succeeded; a deterministic bug fails again and is reported.
   */
  interface RecordedDbError { readonly seq: number; readonly code: string | undefined; readonly text: string; readonly infrastructure: boolean }
  const recordedDbErrors: RecordedDbError[] = [];
  let dbErrorSeq = 0;
  const describeError = (error: unknown): string => {
    const parts: string[] = [];
    for (let current = error, depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
      const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
      parts.push(`${typeof code === 'string' ? `[${code}] ` : ''}${typeof message === 'string' ? message : String(current)}`);
      current = cause;
    }
    return parts.join(' <- ');
  };
  function recordDbError(error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    recordedDbErrors.push({ seq: ++dbErrorSeq, code: typeof code === 'string' ? code : undefined, text: describeError(error), infrastructure: isInfrastructureError(error) });
    if (recordedDbErrors.length > 5000) recordedDbErrors.shift();
  }
  type QueryFunction = (this: unknown, ...args: unknown[]) => unknown;
  let restoreClientQuery: (() => void) | undefined;
  function recordRejectedQueries(Client: { prototype: { query: QueryFunction } }): () => void {
    const original = Client.prototype.query;
    Client.prototype.query = function patched(this: unknown, ...args: unknown[]) {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = (error: unknown, ...rest: unknown[]) => { if (error) recordDbError(error); return (last as QueryFunction)(error, ...rest); };
      }
      const result = original.apply(this, args);
      // Observe the rejection without changing the returned promise; a Submittable or callback query returns something else.
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(undefined, (error: unknown) => { recordDbError(error); });
      }
      return result;
    };
    return () => { Client.prototype.query = original; };
  }

  /**
   * An opaque 500 is retried (same `command_id`, which applies once or replays, also after a connection lost at COMMIT) only
   * when at least one database error was recorded while the request ran and every one of them is infrastructure. A 500 with
   * any other database error, or with none at all, is an economy/server failure and is reported at once with the details.
   */
  async function withRetry(send: () => Promise<Reply>): Promise<Reply> {
    for (let attempt = 1; ; attempt++) {
      const before = dbErrorSeq;
      const reply = await send();
      if (reply.status !== 500 || errorOf(reply.body) !== 'internal_error') return reply;
      const during = recordedDbErrors.filter(entry => entry.seq > before);
      if (during.length === 0) { violate(`unexpected 500 internal_error with no database error recorded (a server bug, not infrastructure): ${JSON.stringify(reply.body)}`); return reply; }
      const other = during.filter(entry => !entry.infrastructure);
      if (other.length > 0) { violate(`unexpected 500 internal_error; non-infrastructure database error(s) while it ran: ${other.map(entry => `${entry.code ?? 'no SQLSTATE'}: ${entry.text}`).join(' | ')}`); return reply; }
      bump('infraRetry:http500');
      if (attempt >= INFRA_ATTEMPTS) { violate(`INFRASTRUCTURE (not an economy invariant breach): 500 persisted after ${attempt} attempts: ${during.map(entry => entry.text).join(' | ')}`); return reply; }
      await backoff(attempt);
    }
  }
  const toReply = (response: { statusCode: number; body: string; json: () => unknown }): Reply => ({ status: response.statusCode, body: response.body.length ? response.json() : null });
  const post = (player: Player, url: string, payload: unknown): Promise<Reply> =>
    withRetry(async () => toReply(await app.inject({ method: 'POST', url, headers: bearer(player), payload: payload as never })));
  const getJson = (player: Player, url: string): Promise<Reply> =>
    withRetry(async () => toReply(await app.inject({ method: 'GET', url, headers: bearer(player) })));

  /** Classifies one reply: only the listed statuses/error codes are acceptable; anything else is recorded as a failure. */
  function expectReply(name: string, reply: Reply, allowed: { ok: readonly number[]; rejected?: readonly string[]; gate?: boolean; badRequest?: readonly string[] }): boolean {
    const error = errorOf(reply.body);
    if (allowed.ok.includes(reply.status)) { bump(`${name}:${reply.status}`); return true; }
    const business = reply.status === 409 && error !== undefined && (allowed.rejected ?? []).includes(error);
    const gate = allowed.gate === true && reply.status === 400 && error !== undefined && (error.startsWith('start.') || error === 'invalid_live_start');
    const badRequest = reply.status === 400 && error !== undefined && (allowed.badRequest ?? []).includes(error);
    if (business || gate || badRequest) { bump(`${name}:${reply.status}:${error}`); return false; }
    violate(`${name}: unexpected ${reply.status} ${JSON.stringify(reply.body)}`);
    return false;
  }

  async function runningExpeditionOf(actorId: string) {
    const [row] = await database.db.select().from(expeditions).where(and(eq(expeditions.actorId, actorId), eq(expeditions.status, 'running')));
    return row;
  }
  async function actorState(actorId: string) {
    const { rows } = await database.pool.query<{ activity_state: string; activity_id: string | null }>(
      'SELECT activity_state, activity_id FROM actors WHERE actor_id = $1', [actorId]);
    return rows[0];
  }

  // ---- operations (each closure is one concurrent request; model updates happen only on a first-time success) ------
  const INVENTORY = (p: Player) => `/characters/${p.actorId}/inventory/commands`;
  function remember(player: Player, url: string, env: { command_id: string }, reply: Reply, variant: (() => unknown) | null) {
    applied.push({ atMs: clock.nowMs(), player, url, envelope: env, reply, variant });
    if (applied.length > 400) applied.shift();
  }
  const REJECTED = ['busy', 'insufficient_funds', 'item_not_owned', 'activity_conflict'] as const;

  const operations = {
    async buy(player: Player) {
      const offer = rng.pick(OFFERS); const quantity = 1 + rng.int(3);
      const env = envelope('inventory.buy', { actorId: player.actorId, offerId: offer.id, quantity });
      const reply = await post(player, INVENTORY(player), env);
      if (expectReply('buy', reply, { ok: [200], rejected: REJECTED })) {
        player.model.spentGold += offer.price * quantity;
        player.model.bought.set(offer.item, (player.model.bought.get(offer.item) ?? 0) + quantity);
        remember(player, INVENTORY(player), env, reply, () => envelope('inventory.buy', { actorId: player.actorId, offerId: offer.id, quantity: quantity + 1 }, env.command_id));
      }
    },
    async sellMaterial(player: Player) {
      // Mostly authored materials; sometimes a consumable (potion), which must never be sellable (escrowed or not).
      const material = rng.chance(85) ? rng.pick(MATERIALS) : { item: POTION, value: 0 }; const quantity = 1 + rng.int(3);
      const env = envelope('inventory.sellMaterial', { actorId: player.actorId, item: material.item, quantity });
      const reply = await post(player, INVENTORY(player), env);
      if (material.item === POTION) {
        if (reply.status === 200) violate(`sellMaterial: a consumable was sold: ${JSON.stringify(reply.body)}`);
        else expectReply('sellPotion', reply, { ok: [], rejected: ['busy'], badRequest: ['invalid_sell_item'] });
        return;
      }
      if (expectReply('sellMaterial', reply, { ok: [200], rejected: REJECTED })) {
        player.model.earnedGold += material.value * quantity;
        player.model.sold.set(material.item, (player.model.sold.get(material.item) ?? 0) + quantity);
        remember(player, INVENTORY(player), env, reply, () => envelope('inventory.sellMaterial', { actorId: player.actorId, item: material.item, quantity: quantity + 1 }, env.command_id));
      }
    },
    async moveStack(player: Player) {
      const item = rng.pick([POTION, SAP, MATERIALS[0].item]); const quantity = 1 + rng.int(2);
      const [from, to] = rng.chance(50) ? ['inventory', 'storage'] : ['storage', 'inventory'];
      const env = envelope('inventory.move', { actorId: player.actorId, item, quantity, from, to });
      const reply = await post(player, INVENTORY(player), env);
      if (expectReply('moveStack', reply, { ok: [200], rejected: REJECTED })) {
        remember(player, INVENTORY(player), env, reply, () => envelope('inventory.move', { actorId: player.actorId, item, quantity: quantity + 1, from, to }, env.command_id));
      }
    },
    async equip(player: Player) {
      const itemId = rng.pick(player.swords);
      const env = envelope('inventory.equip', { actorId: player.actorId, itemId, slot: 'weapon' });
      const reply = await post(player, INVENTORY(player), env);
      if (expectReply('equip', reply, { ok: [200], rejected: REJECTED })) {
        remember(player, INVENTORY(player), env, reply, () => envelope('inventory.equip', { actorId: player.actorId, itemId, slot: 'chest' }, env.command_id));
      }
    },
    async unequip(player: Player) {
      const env = envelope('inventory.unequip', { actorId: player.actorId, itemId: rng.pick(player.swords) });
      const reply = await post(player, INVENTORY(player), env);
      if (expectReply('unequip', reply, { ok: [200], rejected: REJECTED })) remember(player, INVENTORY(player), env, reply, null);
    },
    async moveUnique(player: Player) {
      const itemId = rng.pick(player.swords);
      const [from, to] = rng.chance(50) ? ['inventory', 'storage'] : ['storage', 'inventory'];
      const env = envelope('inventory.move', { actorId: player.actorId, itemId, from, to });
      const reply = await post(player, INVENTORY(player), env);
      if (expectReply('moveUnique', reply, { ok: [200], rejected: REJECTED })) {
        remember(player, INVENTORY(player), env, reply, () => envelope('inventory.move', { actorId: player.actorId, itemId, from: to, to: from }, env.command_id));
      }
    },
    async startExpedition(player: Player, forcedPotions?: number) {
      const durationMin = rng.pick([15, 30, 60]); const potions = forcedPotions ?? rng.int(3);
      const consumables = potions ? [{ item: POTION, qty: potions }] : [];
      const env = envelope('expedition.start', { actorId: player.actorId,
        request: { areaId: REGION, activityId: HUNT, durationMin, paceBp: 10_000 }, config: { consumables, retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } });
      const reply = await post(player, '/expeditions', env);
      if (expectReply('startExpedition', reply, { ok: [201], rejected: REJECTED, gate: true })) {
        player.model.starts += 1;
        remember(player, '/expeditions', env, reply, () => envelope('expedition.start', { actorId: player.actorId,
          request: { areaId: REGION, activityId: HUNT, durationMin: durationMin === 15 ? 30 : 15, paceBp: 10_000 }, config: { consumables, retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } }, env.command_id));
      }
      return reply;
    },
    async cancel(player: Player) {
      const running = await runningExpeditionOf(player.actorId);
      if (!running) { bump('cancel:skipped'); return; }
      const env = envelope('expedition.cancel', { expeditionId: running.id });
      const url = `/expeditions/${running.id}/cancel`;
      const reply = await post(player, url, env);
      if (expectReply('cancel', reply, { ok: [200], rejected: REJECTED })) remember(player, url, env, reply, null);
    },
    async read(player: Player) {
      const running = await runningExpeditionOf(player.actorId);
      const reply = running && rng.chance(60) ? await getJson(player, `/expeditions/${running.id}`) : await getJson(player, `/characters/${player.actorId}/expeditions`);
      expectReply('read', reply, { ok: [200] });
    },
    async startLive(player: Player, forcedSupplies?: number) {
      const supplies = forcedSupplies ?? rng.int(2);
      const env = { commandId: randomUUID(), actorId: player.actorId, areaId: REGION, supplies: supplies ? [{ item: POTION, qty: supplies }] : [] };
      const reply = await post(player, '/live/start', env);
      expectReply('startLive', reply, { ok: [200], rejected: REJECTED, gate: true });
      return reply;
    },
    async replaySame() {
      const replayable = applied.filter(entry => clock.nowMs() - entry.atMs < COMMAND_REPLAY_WINDOW_MS);
      const original = replayable.length ? rng.pick(replayable) : undefined;
      if (!original) { bump('replaySame:skipped'); return; }
      const reply = await post(original.player, original.url, original.envelope);
      if (reply.status !== original.reply.status || JSON.stringify(reply.body) !== JSON.stringify(original.reply.body)) {
        violate(`replaySame: replay of ${(original.envelope as { command_id: string }).command_id} returned ${reply.status} ${JSON.stringify(reply.body)}, expected ${original.reply.status} ${JSON.stringify(original.reply.body)}`);
      } else bump('replaySame:identical');
    },
    async replayDifferent() {
      const candidates = applied.filter(entry => entry.variant !== null && clock.nowMs() - entry.atMs < COMMAND_REPLAY_WINDOW_MS);
      const original = candidates.length ? rng.pick(candidates) : undefined;
      if (!original?.variant) { bump('replayDifferent:skipped'); return; }
      const reply = await post(original.player, original.url, original.variant());
      if (reply.status === 409 && errorOf(reply.body) === 'command_id_conflict') bump('replayDifferent:conflict');
      else violate(`replayDifferent: same command_id with another payload returned ${reply.status} ${JSON.stringify(reply.body)}`);
    },
  } as const;
  type OperationName = keyof typeof operations;
  const MIX: readonly (readonly [OperationName, number])[] = [
    ['buy', 16], ['sellMaterial', 8], ['moveStack', 12], ['equip', 8], ['unequip', 6], ['moveUnique', 8], ['startExpedition', 14], ['cancel', 8], ['read', 8],
    ['startLive', 7], ['replaySame', 8], ['replayDifferent', 5],
  ];
  function pickOperation(): OperationName {
    let roll = rng.int(MIX.reduce((sum, [, weight]) => sum + weight, 0));
    for (const [name, weight] of MIX) { if (roll < weight) return name; roll -= weight; }
    throw new Error('unreachable operation mix');
  }

  // ---- scenarios ---------------------------------------------------------------------------------------------------
  /** Fresh actor with exactly one potion: every consumer of it races; at most one may win and the unit is never duplicated. */
  async function lastPotionRace() {
    const racer = await createPlayer(`racer-r${round}`, { gold: 0, potions: 1, swords: 0 });
    // Kick-off order decides who reaches the row lock first, so shuffle it to let every kind of consumer win over a run.
    const consumers: { kind: 'expedition' | 'live' | 'move'; ok: number; run: () => Promise<Reply> }[] = [
      { kind: 'expedition', ok: 201, run: () => operations.startExpedition(racer, 1) },
      { kind: 'expedition', ok: 201, run: () => operations.startExpedition(racer, 1) },
      { kind: 'live', ok: 200, run: () => operations.startLive(racer, 1) },
      { kind: 'move', ok: 200, run: () => post(racer, INVENTORY(racer), envelope('inventory.move', { actorId: racer.actorId, item: POTION, quantity: 1, from: 'inventory', to: 'storage' })) },
    ];
    for (let index = consumers.length - 1; index > 0; index--) {
      const other = rng.int(index + 1);
      [consumers[index], consumers[other]] = [consumers[other] as (typeof consumers)[number], consumers[index] as (typeof consumers)[number]];
    }
    const results = await Promise.all(consumers.map(consumer => consumer.run()));
    const winners = consumers.filter((consumer, index) => results[index]?.status === consumer.ok);
    if (winners.length !== 1) violate(`last potion race: expected exactly one winner, got ${winners.length}: ${JSON.stringify(results.map(r => [r.status, errorOf(r.body)]))}`);
    const { rows } = await database.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(qty),0)::text AS total FROM asset_balances WHERE actor_id = $1 AND asset_kind = 'stack' AND asset_ref = $2`, [racer.actorId, POTION]);
    if (rows[0]?.total !== '1') violate(`last potion race: ${rows[0]?.total} potion units exist across containers, expected 1`);
    bump('lastPotionRace');
    for (const winner of winners) bump(`lastPotionRace:${winner.kind}Won`);
  }

  /** While a character is live every mutation is refused with a business error; then the instance is closed (replayed once). */
  async function liveCloseout() {
    const { rows } = await database.pool.query<{ actor_id: string; activity_id: string }>(
      `SELECT actor_id, activity_id FROM actors WHERE activity_state = 'live'`);
    await Promise.all(rows.map(async ({ actor_id: actorId, activity_id: instanceId }) => {
      const player = players.find(candidate => candidate.actorId === actorId);
      if (!player) { violate(`live actor ${actorId} is not a known fuzz player`); return; }
      const attempts = await Promise.all([
        post(player, INVENTORY(player), envelope('inventory.buy', { actorId, offerId: OFFERS[0].id, quantity: 1 })),
        post(player, INVENTORY(player), envelope('inventory.move', { actorId, item: POTION, quantity: 1, from: 'inventory', to: 'storage' })),
        post(player, INVENTORY(player), envelope('inventory.sellMaterial', { actorId, item: MATERIALS[0].item, quantity: 1 })),
        post(player, INVENTORY(player), envelope('inventory.equip', { actorId, itemId: player.swords[0] ?? randomUUID(), slot: 'weapon' })),
        post(player, '/expeditions', envelope('expedition.start', { actorId, request: { areaId: REGION, activityId: HUNT, durationMin: 15, paceBp: 10_000 },
          config: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } })),
        post(player, '/live/start', { commandId: randomUUID(), actorId, areaId: REGION, supplies: [] }),
      ]);
      for (const attempt of attempts) {
        const error = errorOf(attempt.body);
        if (attempt.status !== 409 || (error !== 'busy' && error !== 'activity_conflict')) violate(`mutation while live returned ${attempt.status} ${JSON.stringify(attempt.body)}`);
        else bump('whileLive:refused');
      }
      const connection: LiveConnection = { id: randomUUID(), push: () => {} };
      await live.host().attach(instanceId, actorId, player.accountId, connection);
      const commandId = randomUUID();
      // Two submissions of one live command id race: exactly one applies; the other is a duplicate ack or finds the closed instance gone.
      const closes = await Promise.allSettled([1, 2].map(() => live.host().submit(instanceId, actorId, player.accountId, commandId, { type: 'returnToSanctuary' })));
      const fulfilled = closes.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const refused = closes.flatMap(result => result.status === 'rejected' ? [result.reason as { message?: string }] : []);
      const appliedOnce = fulfilled.filter(value => value.ack.status === 'applied' && !value.duplicate).length === 1;
      if (!appliedOnce || refused.some(reason => reason.message !== 'not_hosted')) violate(`live close replay: ${JSON.stringify(fulfilled)} / ${JSON.stringify(refused.map(r => r.message))}`);
      const state = await actorState(actorId);
      if (state?.activity_state !== 'none') violate(`actor ${actorId} still ${state?.activity_state} after its live instance closed`);
      bump('live:closed');
    }));
  }

  /** Moves the clock to (or just past) an expedition's end and races lazy reads, job handlers, cancels and a replayed cancel. */
  async function settlementRace(): Promise<void> {
    const running = await database.db.select().from(expeditions).where(eq(expeditions.status, 'running'));
    const target = running.length ? rng.pick(running) : undefined;
    if (!target) return;
    clock.set(Math.max(clock.nowMs(), target.endsAtMs + rng.pick([0, 0, 1, 90_000])));
    const due = running.filter(row => row.endsAtMs <= clock.nowMs());
    await Promise.all(due.flatMap(row => {
      const player = players.find(candidate => candidate.actorId === row.actorId);
      if (!player) return [];
      const cancelId = randomUUID();
      const cancelEnvelope = envelope('expedition.cancel', { expeditionId: row.id }, cancelId);
      const job = () => directCall('settleJob', () => database.db.transaction(tx => createExpeditionService(tx, clock, content as never).settleJob(row.id, row.revision)));
      return [
        getJson(player, `/expeditions/${row.id}`).then(reply => { expectReply('settle.lazyRead', reply, { ok: [200] }); }),
        getJson(player, `/characters/${row.actorId}/expeditions`).then(reply => { expectReply('settle.list', reply, { ok: [200] }); }),
        job().then(() => { bump('settle.job'); }),
        job().then(() => { bump('settle.job'); }),
        Promise.all([post(player, `/expeditions/${row.id}/cancel`, cancelEnvelope), post(player, `/expeditions/${row.id}/cancel`, cancelEnvelope)])
          .then(([a, b]) => {
            expectReply('settle.cancel', a, { ok: [200] }); expectReply('settle.cancel', b, { ok: [200] });
            if (JSON.stringify(a.body) !== JSON.stringify(b.body)) violate(`concurrent replay of one cancel command_id returned different bodies for ${row.id}`);
          }),
      ];
    }));
    bump(`settleRace:due=${Math.min(due.length, 3)}`);
  }

  // ---- audit --------------------------------------------------------------------------------------------------------
  async function audit(label: string): Promise<void> {
    const issues = await database.db.transaction(async tx => {
      const found: string[] = [];
      const runningIds = (await tx.select({ id: expeditions.id }).from(expeditions).where(eq(expeditions.status, 'running'))).map(row => row.id);
      for (const issue of await checkLedgerInvariants(tx, [], runningIds)) found.push(`ledger invariant: ${issue}`);
      const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await tx.execute(query)).rows as unknown as T[];

      const negatives = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM asset_balances WHERE qty < 0`);
      if (negatives[0]?.n) found.push(`${negatives[0].n} negative balances`);

      // activity lock consistency, both directions
      const expeditionMismatch = await q<{ actor_id: string }>(sql`
        SELECT a.actor_id FROM actors a WHERE a.activity_state = 'expedition'
          AND (SELECT count(*) FROM rpg_expeditions e WHERE e.id = a.activity_id AND e.actor_id = a.actor_id AND e.status = 'running') <> 1
        UNION ALL
        SELECT e.actor_id FROM rpg_expeditions e JOIN actors a ON a.actor_id = e.actor_id
          WHERE e.status = 'running' AND (a.activity_state <> 'expedition' OR a.activity_id <> e.id)
        UNION ALL
        SELECT e.actor_id FROM rpg_expeditions e WHERE e.status = 'running' GROUP BY e.actor_id HAVING count(*) > 1`);
      for (const row of expeditionMismatch) found.push(`actor ${row.actor_id}: activity state disagrees with running expeditions`);
      const liveMismatch = await q<{ actor_id: string }>(sql`
        SELECT a.actor_id FROM actors a WHERE a.activity_state = 'live'
          AND (SELECT count(*) FROM live_instances l WHERE l.instance_id = a.activity_id AND l.status = 'active'
               AND l.participants @> jsonb_build_array(jsonb_build_object('actorId', a.actor_id::text))) <> 1
        UNION ALL
        SELECT a.actor_id FROM actors a JOIN live_instances l ON l.status = 'active'
          AND l.participants @> jsonb_build_array(jsonb_build_object('actorId', a.actor_id::text))
          WHERE a.activity_state <> 'live' OR a.activity_id <> l.instance_id`);
      for (const row of liveMismatch) found.push(`actor ${row.actor_id}: activity state disagrees with active live instances`);

      // at-most-once settlement; terminal expeditions have exactly one, running ones none
      const duplicates = await q<{ id: string; n: number }>(sql`
        SELECT split_part(source_id, ':', 1) AS id, count(*)::int AS n FROM ledger_batches
          WHERE source_type = 'expedition_settlement' GROUP BY 1 HAVING count(*) > 1`);
      for (const row of duplicates) found.push(`expedition ${row.id} settled ${row.n} times`);
      const settlementCounts = await q<{ id: string; status: string; n: number }>(sql`
        SELECT e.id, e.status, (SELECT count(*)::int FROM ledger_batches b WHERE b.source_type = 'expedition_settlement'
          AND split_part(b.source_id, ':', 1) = e.id::text) AS n FROM rpg_expeditions e`);
      for (const row of settlementCounts) {
        if ((row.status === 'running' && row.n !== 0) || (row.status !== 'running' && row.n !== 1)) found.push(`expedition ${row.id} (${row.status}) has ${row.n} settlement batches`);
      }
      const startBatches = await q<{ id: string }>(sql`
        SELECT e.id FROM rpg_expeditions e WHERE (SELECT count(*) FROM ledger_batches b WHERE b.source_type = 'expedition_start' AND b.source_id = e.id::text || ':start') <> 1`);
      for (const row of startBatches) found.push(`expedition ${row.id} has no single start escrow batch`);

      // model accounting: each first-time successful command applied exactly once, rejected/replayed ones never
      for (const player of players) {
        const spent = await q<{ spent: string }>(sql`
          SELECT COALESCE(sum(qty), 0)::text AS spent FROM ledger_entries WHERE actor_id = ${player.actorId}::uuid AND source_type = 'rpg_command'
            AND asset_kind = 'currency' AND asset_ref = 'gold' AND from_container = 'inventory' AND to_container IS NULL`);
        if (Number(spent[0]?.spent) !== player.model.spentGold) found.push(`${player.label}: ledger spent ${spent[0]?.spent} gold, model says ${player.model.spentGold}`);
        const earned = await q<{ earned: string }>(sql`
          SELECT COALESCE(sum(qty), 0)::text AS earned FROM ledger_entries WHERE actor_id = ${player.actorId}::uuid AND source_type = 'rpg_command'
            AND asset_kind = 'currency' AND asset_ref = 'gold' AND from_container IS NULL AND to_container = 'inventory'`);
        if (Number(earned[0]?.earned) !== player.model.earnedGold) found.push(`${player.label}: ledger earned ${earned[0]?.earned} gold from sales, model says ${player.model.earnedGold}`);
        for (const material of MATERIALS) {
          const sold = await q<{ qty: string }>(sql`
            SELECT COALESCE(sum(qty), 0)::text AS qty FROM ledger_entries WHERE actor_id = ${player.actorId}::uuid AND source_type = 'rpg_command'
              AND asset_kind = 'stack' AND asset_ref = ${material.item} AND from_container = 'inventory' AND to_container IS NULL`);
          if (Number(sold[0]?.qty) !== (player.model.sold.get(material.item) ?? 0)) found.push(`${player.label}: ledger sold ${sold[0]?.qty} ${material.item}, model says ${player.model.sold.get(material.item) ?? 0}`);
        }
        for (const offer of OFFERS) {
          const got = await q<{ qty: string }>(sql`
            SELECT COALESCE(sum(qty), 0)::text AS qty FROM ledger_entries WHERE actor_id = ${player.actorId}::uuid AND source_type = 'rpg_command'
              AND asset_kind = 'stack' AND asset_ref = ${offer.item} AND from_container IS NULL AND to_container = 'inventory'`);
          if (Number(got[0]?.qty) !== (player.model.bought.get(offer.item) ?? 0)) found.push(`${player.label}: ledger granted ${got[0]?.qty} ${offer.item}, model says ${player.model.bought.get(offer.item) ?? 0}`);
        }
        const started = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM rpg_expeditions WHERE actor_id = ${player.actorId}::uuid`);
        if (started[0]?.n !== player.model.starts) found.push(`${player.label}: ${started[0]?.n} expeditions persisted, model says ${player.model.starts}`);
      }
      if (found.length) found.push(`audit snapshot (same REPEATABLE READ transaction):\n${await diagnose(tx, runningIds)}`);
      return found;
    }, { isolationLevel: 'repeatable read' });
    for (const issue of issues) violate(`${label}: ${issue}`);
  }

  /**
   * Row-level detail for a failed audit, read inside the failing audit's own snapshot. `checkLedgerInvariants` only names the
   * broken invariant, which is not enough to analyse a one-in-N flake after the fact.
   */
  async function diagnose(tx: Parameters<Parameters<Database['db']['transaction']>[0]>[0], runningIds: readonly string[]): Promise<string> {
    const dump = async (title: string, query: ReturnType<typeof sql>) => {
      try { return `-- ${title}\n${JSON.stringify((await tx.execute(query)).rows, null, 1)}`; }
      catch (error) { return `-- ${title}: diagnostic query failed: ${String(error)}`; }
    };
    return [
      `clockMs=${clock.nowMs()} wallMs=${Date.now()} runningExpeditionIds=${JSON.stringify(runningIds)}`,
      await dump('balance mismatches (side: expected = ledger sum, actual = asset_balances)', sql`
        WITH changes AS (
          SELECT actor_id, asset_kind, asset_ref, COALESCE(to_container, 'inventory') AS container, qty AS delta
            FROM ledger_entries WHERE to_container IS NOT NULL OR (from_container IS NULL AND to_container IS NULL)
          UNION ALL
          SELECT actor_id, asset_kind, asset_ref, COALESCE(from_container, 'inventory'), -qty FROM ledger_entries WHERE from_container IS NOT NULL
        ), expected AS (SELECT actor_id, asset_kind, asset_ref, container, SUM(delta)::integer AS qty FROM changes
                         GROUP BY 1,2,3,4 HAVING asset_kind IN ('stack','currency') AND SUM(delta) <> 0),
        actual AS (SELECT actor_id, asset_kind, asset_ref, container, qty FROM asset_balances WHERE qty <> 0)
        SELECT COALESCE(e.actor_id, a.actor_id) AS actor_id, COALESCE(e.asset_kind, a.asset_kind) AS asset_kind,
               COALESCE(e.asset_ref, a.asset_ref) AS asset_ref, COALESCE(e.container, a.container) AS container, e.qty AS expected, a.qty AS actual
          FROM expected e FULL JOIN actual a USING (actor_id, asset_kind, asset_ref, container) WHERE e.qty IS DISTINCT FROM a.qty LIMIT 50`),
      await dump('batches whose entry_count differs from their entries', sql`
        SELECT b.source_type, b.source_id, b.entry_count, COALESCE(e.n, 0) AS entries FROM ledger_batches b LEFT JOIN
          (SELECT source_type, source_id, COUNT(*)::integer AS n FROM ledger_entries GROUP BY 1,2) e USING (source_type, source_id)
          WHERE COALESCE(e.n, 0) <> b.entry_count LIMIT 50`),
      await dump('escrow holdings', sql`
        SELECT actor_id, container, asset_ref, qty FROM asset_balances WHERE container LIKE 'escrow:%' AND qty > 0 ORDER BY container LIMIT 100`),
      await dump('expeditions (id, actor, status, outcome, revision, settlement batches)', sql`
        SELECT e.id, e.actor_id, e.status, e.outcome, e.revision, e.ends_at_ms,
               (SELECT count(*)::int FROM ledger_batches b WHERE b.source_type = 'expedition_settlement' AND split_part(b.source_id, ':', 1) = e.id::text) AS settlements
          FROM rpg_expeditions e ORDER BY e.created_at DESC LIMIT 60`),
      await dump('actors with an activity lock', sql`SELECT actor_id, activity_state, activity_id FROM actors WHERE activity_state <> 'none'`),
      await dump('active live instances', sql`SELECT instance_id, status, participants FROM live_instances WHERE status = 'active'`),
    ].join('\n');
  }

  async function endRound(label: string) {
    // Print the full detail eagerly and put it into the assertion message: a flaky failure must be diagnosable from the log alone.
    if (violations.length) console.error(`economy fuzz: ${violations.length} violation(s) after ${label} (seed=${SEED}):\n${violations.join('\n')}`);
    expect(violations.join('\n'), `economy fuzz violations (replay with ECONOMY_FUZZ_SEED=${SEED}) after ${label}`).toBe('');
  }

  // ---- the test -----------------------------------------------------------------------------------------------------
  it(`holds every economy invariant over ${ROUNDS} rounds x ${OPS_PER_ROUND} concurrent operations`, async () => {
    console.info(`economy fuzz: seed=${SEED} rounds=${ROUNDS} opsPerRound=${OPS_PER_ROUND} (reproduce with ECONOMY_FUZZ_SEED=${SEED})`);
    for (let index = 0; index < BASE_PLAYERS; index++) {
      await createPlayer(`p${index}`, { gold: STARTING_GOLD, potions: STARTING_POTIONS, swords: 2, materials: 8 });
    }
    const started = Date.now();
    for (round = 1; round <= ROUNDS; round++) {
      const batch: Promise<unknown>[] = [lastPotionRace()];
      for (let index = 0; index < OPS_PER_ROUND; index++) {
        const player = rng.pick(players.slice(0, BASE_PLAYERS));
        batch.push(operations[pickOperation()](player).catch((error: unknown) => {
          violate(`${isInfrastructureError(error) ? 'INFRASTRUCTURE (not an economy invariant breach): ' : ''}operation threw ${String(error)}`);
        }));
      }
      await Promise.all(batch);
      await audit('after concurrent batch');
      await liveCloseout();
      if (rng.chance(50)) await settlementRace();
      clock.advance(rng.int(15 * MINUTE));
      await audit('after settlement race');
      await endRound(`round ${round}`);
    }

    // Drain: let every expedition end, settle all of them concurrently through every path, then expect a quiet system.
    round = ROUNDS + 1;
    const remaining = await database.db.select().from(expeditions).where(eq(expeditions.status, 'running'));
    clock.set(Math.max(clock.nowMs(), ...remaining.map(row => row.endsAtMs)) + MINUTE);
    await Promise.all(remaining.flatMap(row => {
      const player = players.find(candidate => candidate.actorId === row.actorId);
      if (!player) return [];
      const job = () => directCall('settleJob', () => database.db.transaction(tx => createExpeditionService(tx, clock, content as never).settleJob(row.id, row.revision)));
      return [getJson(player, `/expeditions/${row.id}`).then(reply => { expectReply('drain.lazyRead', reply, { ok: [200] }); }), job(), job()];
    }));
    await liveCloseout();
    await audit('final');
    await endRound('final drain');

    const ids = players.map(player => player.actorId);
    const still = await database.db.select().from(expeditions).where(and(inArray(expeditions.actorId, ids), eq(expeditions.status, 'running')));
    expect(still).toEqual([]);
    const { rows: busy } = await database.pool.query(`SELECT actor_id FROM actors WHERE activity_state <> 'none'`);
    expect(busy).toEqual([]);
    expect(await database.db.transaction(tx => checkLedgerInvariants(tx, [], []))).toEqual([]);

    const statuses = await database.pool.query<{ status: string; outcome: string | null; n: number }>(
      'SELECT status, outcome, count(*)::int AS n FROM rpg_expeditions GROUP BY 1, 2 ORDER BY 1, 2');
    const jobs = await database.pool.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM pgboss.job WHERE name = 'rpg.expedition.settle' GROUP BY 1 ORDER BY 1`);
    for (const row of statuses.rows) stats.set(`expeditions:${row.status}:${row.outcome ?? 'none'}`, row.n);
    for (const row of jobs.rows) stats.set(`pgbossSettleJobs:${row.state}`, row.n);
    const summary = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}=${count}`).join(' ');
    console.info(`economy fuzz summary: seed=${SEED} players=${players.length} elapsedMs=${Date.now() - started} ${summary}`);

    // The scenarios must actually have exercised the paths they claim to (guards against a vacuous run).
    const count = (key: string) => stats.get(key) ?? 0;
    expect(count('lastPotionRace')).toBe(ROUNDS);
    expect(count('buy:200')).toBeGreaterThan(0);
    expect(count('startExpedition:201')).toBeGreaterThan(0);
    expect(count('replaySame:identical')).toBeGreaterThan(0);
  }, FUZZ_TIMEOUT_MS);

  it('classifies environmental failures apart from invariant violations and retries idempotent job calls (#135)', async () => {
    round = 0;
    violations.length = 0;
    const exhausted = () => Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    expect(isInfrastructureError(exhausted())).toBe(true);
    expect(isInfrastructureError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isInfrastructureError(new Error('Failed query: select 1', { cause: new Error('Query read timeout') }))).toBe(true);
    expect(isInfrastructureError(new Error('duplicate key value violates unique constraint'))).toBe(false);
    let calls = 0;
    // Two exhausted-slot failures, then success: retried silently, no violation.
    await expect(directCall('selfCheckJob', async () => {
      if (++calls < 3) throw exhausted();
      return 'done';
    })).resolves.toBe('done');
    expect(violations).toEqual([]);
    // A real failure is never retried and is reported as a normal violation.
    calls = 0;
    await directCall('selfCheckJob', async () => { calls++; throw new Error('settlement mismatch'); });
    expect(calls).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('selfCheckJob threw');
    expect(violations[0]).not.toContain('INFRASTRUCTURE');
    // An outage that outlasts the retries is reported, under its own label.
    violations.length = 0;
    await directCall('selfCheckJob', async () => { throw exhausted(); });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('INFRASTRUCTURE (not an economy invariant breach)');
    violations.length = 0;
  }, 30_000);

  it('records rejected queries of every pg client in the process (a silent failure to patch would show here)', async () => {
    const codes = () => recordedDbErrors.map(entry => entry.code);
    const before = recordedDbErrors.length;
    await expect(database.pool.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
    await expect(admin.pool.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
    await expect(database.db.execute(sql`SELECT 1/0`)).rejects.toBeDefined();
    await expect(database.db.transaction(async tx => { await tx.execute(sql`SELECT 1/0`); })).rejects.toBeDefined();
    await new Promise<void>(resolve => { database.pool.query('SELECT 1/0', () => { resolve(); }); });
    // pool, admin pool, drizzle statement, drizzle transaction client and a callback-style query: five recorded errors.
    expect(codes().slice(before)).toEqual(['22012', '22012', '22012', '22012', '22012']);
    // The HTTP app and the worker app use the same pool class, hence the same patched prototype.
    expect(recordedDbErrors.slice(before).every(entry => !entry.infrastructure)).toBe(true);
  }, 30_000);

  it('retries a 500 only when the database errors recorded while it ran are all infrastructure (#135)', async () => {
    round = 0;
    violations.length = 0;
    const reply500: Reply = { status: 500, body: { error: 'internal_error' } };
    const ok: Reply = { status: 201, body: { id: 'x' } };
    const exhausted = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });

    // (a) a 500 whose recorded cause is connection exhaustion is retried with the same request and then succeeds.
    let calls = 0;
    const retried = await withRetry(async () => {
      if (++calls === 1) { recordDbError(exhausted); return reply500; }
      return ok;
    });
    expect(retried).toBe(ok);
    expect(calls).toBe(2);
    expect(violations).toEqual([]);

    // (b) a 500 whose recorded cause is a deadlock, or any other non-infrastructure error, is never retried.
    for (const cause of [Object.assign(new Error('deadlock detected'), { code: '40P01' }), new Error('boom')]) {
      calls = 0; violations.length = 0;
      const reply = await withRetry(async () => { calls++; recordDbError(cause); return reply500; });
      expect(reply).toBe(reply500);
      expect(calls).toBe(1);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('non-infrastructure database error');
      expect(violations[0]).toContain(cause.message);
    }
    expect(violations[0]).toContain('boom');
    // A mixed window (infrastructure plus a deadlock of a neighbour) is condemned too: strict on overlap.
    calls = 0; violations.length = 0;
    await withRetry(async () => { calls++; recordDbError(exhausted); recordDbError(Object.assign(new Error('deadlock detected'), { code: '40P01' })); return reply500; });
    expect(calls).toBe(1);
    expect(violations[0]).toContain('40P01');

    // (c) a 500 with no recorded database error is a server bug, not infrastructure.
    calls = 0; violations.length = 0;
    await withRetry(async () => { calls++; return reply500; });
    expect(calls).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('no database error recorded');

    // Errors recorded before the request started do not count for it.
    calls = 0; violations.length = 0;
    recordDbError(exhausted);
    await withRetry(async () => { calls++; return reply500; });
    expect(calls).toBe(1);
    expect(violations[0]).toContain('no database error recorded');
    violations.length = 0;
  }, 30_000);

  it('audit self-check: the invariants fail on corrupted balances, orphaned activity locks and double settlement', async () => {
    round = 0;
    violations.length = 0;
    const victim = await createPlayer('self-check', { gold: 50, potions: 0, swords: 0 });
    const started = await operations.startExpedition(victim, 0);
    expect(started.status).toBe(201);
    const { id } = started.body as { id: string };
    const row = await database.db.select().from(expeditions).where(eq(expeditions.id, id));
    clock.set(Math.max(clock.nowMs(), row[0]?.endsAtMs ?? 0));
    expect((await getJson(victim, `/expeditions/${id}`)).status).toBe(200);
    await audit('self-check baseline');
    expect(violations).toEqual([]);

    async function expectDetected(label: string, fragment: string, tamper: string, restore: string, params: unknown[]) {
      await database.pool.query(tamper, params);
      try { await audit(label); }
      finally {
        // Ledger tables are append-only (triggers), so the restore of an inserted row bypasses them on a dedicated session.
        const client = await database.pool.connect();
        try {
          await client.query("SET session_replication_role = 'replica'");
          await client.query(restore, params);
        } finally { await client.query('RESET session_replication_role'); client.release(); }
      }
      expect(violations.some(message => message.includes(fragment)), `${label} not detected: ${JSON.stringify(violations)}`).toBe(true);
      // A failed audit must carry row-level detail from its own snapshot, and every diagnostic query must itself work.
      const detail = violations.find(message => message.includes('audit snapshot'));
      expect(detail, `${label}: no audit snapshot in ${JSON.stringify(violations)}`).toBeDefined();
      expect(detail).not.toContain('diagnostic query failed');
      if (label === 'inflated balance') expect(detail).toContain('"expected"');
      violations.length = 0;
    }
    await expectDetected('inflated balance', 'ledger invariant',
      `UPDATE asset_balances SET qty = qty + 1 WHERE actor_id = $1 AND asset_ref = 'gold'`,
      `UPDATE asset_balances SET qty = qty - 1 WHERE actor_id = $1 AND asset_ref = 'gold'`, [victim.actorId]);
    await expectDetected('orphan activity lock', 'activity state disagrees',
      `UPDATE actors SET activity_state = 'expedition', activity_id = gen_random_uuid() WHERE actor_id = $1`,
      `UPDATE actors SET activity_state = 'none', activity_id = NULL WHERE actor_id = $1`, [victim.actorId]);
    await expectDetected('double settlement', 'settled 2 times',
      `INSERT INTO ledger_batches (source_type, source_id, fingerprint, entry_count) VALUES ('expedition_settlement', $1 || ':7', repeat('a', 64), 0)`,
      `DELETE FROM ledger_batches WHERE source_type = 'expedition_settlement' AND source_id = $1 || ':7'`, [id]);
    await audit('self-check restored');
    expect(violations).toEqual([]);
  }, 30_000);
});
