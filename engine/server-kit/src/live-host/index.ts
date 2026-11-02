import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { HostError, InstanceHost } from '@engine/live-kernel';
import type { JsonValue, LiveGame } from '@engine/live-kernel';

import type { LiveSocketConnection } from '../auth/live.ts';
import { UUID_PATTERN } from '../commands/run.ts';
import type { MigrationSet } from '../database.ts';
import type { ModuleContext, ServerModule } from '../server.ts';
import { PostgresInstanceStore } from './store.ts';
import type { PostgresInstanceStoreHooks } from './store.ts';

export * from './schema.ts';
export * from './store.ts';

/** Separate, optional migration set owned by the live host; compositions list it after the engine set. */
export const LIVE_HOST_MIGRATIONS: MigrationSet = {
  id: 'live_host', schema: 'live_host_migrations', directory: fileURLToPath(new URL('../../migrations-live', import.meta.url)),
};

export interface LiveHostModuleOptions<S> {
  /** The game plugin, built from the verified content of the booting server. */
  readonly game: (context: ModuleContext) => LiveGame<S>;
  /** Unique per process (default hostname:pid:random). */
  readonly nodeId?: string;
  readonly leaseMs?: number;
  readonly renewEveryMs?: number;
  readonly graceMs?: number;
  readonly hooks?: PostgresInstanceStoreHooks;
  /** Start the real-time tick/lease loop (default true). Tests drive `host().pump()` with a manual clock instead. */
  readonly autoStart?: boolean;
  /** Period of the crash-recovery sweep for expired leases (default 10 s; 0 disables). */
  readonly recoverEveryMs?: number;
}

export interface LiveHostHandle<S> {
  readonly module: ServerModule;
  /** The node's host; available once the module is registered. */
  host(): InstanceHost<S>;
  /**
   * WebSocket command hook for `createAuthModule({ onCommand })`. Returns `undefined` for payloads that are not
   * `live.*` operations so the composition can route them to its other command handlers.
   */
  handleSocketCommand(payload: unknown, identity: { readonly accountId: string }, connection: LiveSocketConnection): Promise<unknown>;
}

type LiveOp =
  | { op: 'live.attach'; instanceId: string; actorId: string; resume?: { epoch: number; seq: number } }
  | { op: 'live.command'; instanceId: string; actorId: string; commandId: string; command: JsonValue };

/**
 * Live instance hosting module (role `live`) over the authenticated `/auth/live` socket. One socket per account is
 * enforced by the auth module's `live_sessions` lease; this module adds instance attach/resume, deduplicated commands and
 * sequenced server pushes. Routing a client to the node that owns an instance is out of scope (single live node, or a
 * client retry after the lease moves).
 */
export function createLiveHostModule<S>(options: LiveHostModuleOptions<S>): LiveHostHandle<S> {
  let host: InstanceHost<S> | undefined;
  const nodeId = options.nodeId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const requireHost = (): InstanceHost<S> => {
    if (!host) throw new Error('live host module is not registered');
    return host;
  };
  const module: ServerModule = {
    name: 'live-host', roles: ['live'],
    async register(app, context) {
      const created = new InstanceHost({ game: options.game(context), store: new PostgresInstanceStore(context.database, options.hooks),
        clock: context.clock, nodeId, contentHash: context.content.contentHash,
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        ...(options.renewEveryMs === undefined ? {} : { renewEveryMs: options.renewEveryMs }),
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        onError: (error, instanceId) => { app.log.error({ instanceId, err: error }, 'live instance error'); } });
      host = created;
      let sweep: ReturnType<typeof setInterval> | undefined;
      if (options.autoStart !== false) {
        created.start();
        const every = options.recoverEveryMs ?? 10_000;
        if (every > 0) {
          sweep = setInterval(() => { void created.recoverExpired().catch(() => {}); }, every);
          sweep.unref();
        }
      }
      app.addHook('onClose', async () => {
        if (sweep) clearInterval(sweep);
        await created.stop();
      });
    },
  };
  return {
    module,
    host: requireHost,
    async handleSocketCommand(payload, identity, connection) {
      const op = parseLiveOp(payload);
      if (op === undefined) return undefined;
      if (op === null) return { type: 'live.error', error: 'invalid_live_command' };
      const live = requireHost();
      try {
        if (op.op === 'live.attach') {
          if (!live.has(op.instanceId) && !await live.recover(op.instanceId)) return { type: 'live.error', error: 'instance_unavailable' };
          const result = await live.attach(op.instanceId, op.actorId, identity.accountId, {
            id: connection.id, push: (message) => { connection.push(message); },
          }, op.resume);
          connection.onClose(() => { void live.detach(op.instanceId, op.actorId, connection.id); });
          return { type: 'live.attached', instanceId: op.instanceId, mode: result.mode };
        }
        const submitted = await live.submit(op.instanceId, op.actorId, identity.accountId, op.commandId, op.command);
        return { type: 'live.ack', instanceId: op.instanceId, commandId: op.commandId, duplicate: submitted.duplicate, ...submitted.ack };
      } catch (error) {
        if (error instanceof HostError) return { type: 'live.error', error: error.code };
        throw error;
      }
    },
  };
}

/** `undefined`: not a live operation; `null`: a malformed live operation. Exact keys only. */
function parseLiveOp(payload: unknown): LiveOp | null | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record['op'] !== 'string' || !record['op'].startsWith('live.')) return undefined;
  const keys = Object.keys(record).sort().join(',');
  const uuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
  if (!uuid(record['instanceId']) || !uuid(record['actorId'])) return null;
  const instanceId = record['instanceId'].toLowerCase(); const actorId = record['actorId'].toLowerCase();
  if (record['op'] === 'live.attach') {
    if (keys === 'actorId,instanceId,op') return { op: 'live.attach', instanceId, actorId };
    if (keys !== 'actorId,instanceId,op,resume') return null;
    const resume = record['resume'] as { epoch?: unknown; seq?: unknown } | null;
    if (resume === null || typeof resume !== 'object' || Object.keys(resume).length !== 2 ||
      !Number.isSafeInteger(resume.epoch) || !Number.isSafeInteger(resume.seq)) return null;
    return { op: 'live.attach', instanceId, actorId, resume: { epoch: resume.epoch as number, seq: resume.seq as number } };
  }
  if (record['op'] === 'live.command' && keys === 'actorId,command,commandId,instanceId,op' && uuid(record['commandId'])) {
    return { op: 'live.command', instanceId, actorId, commandId: record['commandId'].toLowerCase(), command: record['command'] as JsonValue };
  }
  return null;
}
