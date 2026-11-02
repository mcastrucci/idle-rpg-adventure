/**
 * THROWAWAY spike 3 (#13) prototype — not production code, not imported by anything.
 *
 * The same 2-player live room as the in-house `InstanceHost` (engine/live-kernel), on Colyseus 0.18: commands carry a
 * `commandId` (deduplicated by our own room code), the server ticks only while "fighting", events are broadcast with a
 * sequence number, dropped clients get a reconnection grace (`allowReconnection`) during which the fight continues,
 * and after the grace the participant is `left`. Game logic is a counter stub: the comparison is about hosting
 * semantics, not combat.
 */
import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { schema, t } from '@colyseus/schema';

export const DuoState = schema({
  phase: t.string().default('exploring'),
  tick: t.number().default(0),
  enemyHp: t.number().default(0),
}, 'DuoState');

export interface DuoOptions { readonly graceSeconds: number; readonly tickMs: number }
export type ParticipantStatus = 'connected' | 'disconnected' | 'left';

export class DuoRoom extends Room {
  override maxClients = 2;
  override state = new DuoState();
  graceSeconds = 60;
  tickMs = 500;
  /** Our own dedupe: Colyseus has no command idempotency. In memory only — lost with the process. */
  readonly applied = new Map<string, string>();
  readonly statuses = new Map<string, ParticipantStatus>();
  seq = 0;

  override onCreate(options: DuoOptions): void {
    this.graceSeconds = options.graceSeconds; this.tickMs = options.tickMs;
    this.onMessage('command', (client: Client, message: { commandId: string; type: string }) => {
      const key = `${client.sessionId}:${message.commandId}`;
      const prior = this.applied.get(key);
      if (prior !== undefined) { client.send('ack', { commandId: message.commandId, status: prior, duplicate: true }); return; }
      let status = 'rejected';
      if (message.type === 'engage' && this.state.phase === 'exploring') {
        this.state.phase = 'fighting'; this.state.enemyHp = 20; status = 'applied';
        this.event({ type: 'engaged' });
        // Ticks only while fighting: the interval is installed here and cleared when the fight ends.
        this.setSimulationInterval(() => { this.fightTick(); }, this.tickMs);
      }
      this.applied.set(key, status);
      client.send('ack', { commandId: message.commandId, status, duplicate: false });
    });
  }

  fightTick(): void {
    this.state.tick += 1; this.state.enemyHp -= 1;
    this.event({ type: 'hit', enemyHp: this.state.enemyHp });
    if (this.state.enemyHp <= 0) {
      this.state.phase = 'exploring';
      this.setSimulationInterval(); // stop ticking
      this.event({ type: 'victory' });
    }
  }

  event(payload: Record<string, unknown>): void {
    this.seq += 1;
    // Broadcasts are fire-and-forget: a client that is disconnected misses them (no replay buffer in Colyseus).
    this.broadcast('event', { seq: this.seq, ...payload });
  }

  override onJoin(client: Client): void {
    this.statuses.set(client.sessionId, 'connected');
    this.event({ type: 'participant', sessionId: client.sessionId, status: 'connected' });
  }

  override async onDrop(client: Client): Promise<void> {
    this.statuses.set(client.sessionId, 'disconnected');
    this.event({ type: 'participant', sessionId: client.sessionId, status: 'disconnected' });
    // The simulation interval keeps running: no pause while disconnected. Rejection on timeout → onLeave.
    await this.allowReconnection(client, this.graceSeconds).catch(() => {});
  }

  override onReconnect(client: Client): void {
    this.statuses.set(client.sessionId, 'connected');
    this.event({ type: 'participant', sessionId: client.sessionId, status: 'connected' });
  }

  override onLeave(client: Client): void {
    this.statuses.set(client.sessionId, 'left');
    this.event({ type: 'participant', sessionId: client.sessionId, status: 'left' });
  }
}
