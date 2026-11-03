import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseLiveClientRequest, parseLiveCurrent, parseLiveDeathResponse, parseLiveOptions, parseLiveServerFrame,
  parseLiveStartRequest, parseLiveStartResponse } from './live.ts';

const actorId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';

describe('live wire protocol', () => {
  it('validates attach cursors and command IDs with exact fields', () => {
    expect(parseLiveClientRequest({ op: 'live.attach', instanceId, actorId, resume: { epoch: 3, seq: 12 } }))
      .toEqual({ op: 'live.attach', instanceId, actorId, resume: { epoch: 3, seq: 12 } });
    expect(parseLiveClientRequest({ op: 'live.command', instanceId, actorId, commandId: actorId,
      command: { type: 'travel', exitId: 'exit:one' } })).toMatchObject({ commandId: actorId });
    for (const input of [
      { op: 'live.attach', instanceId, actorId, resume: { epoch: -1, seq: 0 } },
      { op: 'live.attach', instanceId, actorId, extra: true },
      { op: 'live.command', instanceId, actorId, commandId: 'bad', command: {} },
      { op: 'live.command', instanceId, actorId, commandId: actorId, command: { checkpoint: {} } },
    ]) expect(() => parseLiveClientRequest(input)).toThrow();
  });

  it('parses snapshots and event envelopes while limiting views to public fields', () => {
    const snapshot = { type: 'live.snapshot', instanceId, epoch: 2, seq: 8,
      view: { phase: 'exploring', heroes: [], runBag: [{ actorId, items: [{ item: 'item:herb', qty: 2 }], gold: 3 }] },
      participants: [{ actorId, status: 'connected' }] };
    expect(parseLiveServerFrame(snapshot)).toMatchObject({ type: 'live.snapshot', epoch: 2, seq: 8 });
    expect(parseLiveServerFrame({ ...snapshot, view: { phase: 'exploring', heroes: [], runBag: [{ actorId, items: [], gold: 0,
      uniques: [{ itemId: actorId, definition: 'iron_sabre', slot: null, rolls: {} }] }] } })).toMatchObject({ type: 'live.snapshot' });
    // This is the exact victory event emitted by createRpgLiveGame; dropping it would create a public sequence gap.
    expect(parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 9, source: 'game',
      event: { type: 'combatRewards', groupId: 'slimes', rewards: [{ actorId, xp: 8, drops: [], gold: 0 }] } })).toMatchObject({ type: 'live.event' });
    expect(parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 10, source: 'game',
      event: { type: 'gathered', nodeId: 'node:one', drops: [{ item: 'item:herb', qty: 2 }], gold: 3 } })).toMatchObject({ type: 'live.event' });
    expect(parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 11, source: 'game',
      event: { type: 'corpseRecovered', actorId, repeat: false } })).toMatchObject({ type: 'live.event' });
    const bossRisk = { locationId: 'location:boss', enemies: [{ enemy: 'enemy:warden', rank: 'boss', level: 5 }],
      heroes: [{ actorId, hp: 20, maxHp: 30, healingConsumables: 1 }], retreatAllowed: false,
      onDeath: ['live.death.run_bag_to_corpse', 'live.death.xp_penalty'], deathConsequences: [{ actorId, xpLost: 4, xpBeforeTotal: 40,
        runBag: { items: [{ item: 'item:herb', qty: 2 }], gold: 3, uniques: [{ itemId: instanceId, definition: 'iron_sabre', slot: null, rolls: {} }] } }] };
    expect(parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 12, source: 'game',
      event: { type: 'bossRoomWarning', exitId: 'exit:boss', risk: bossRisk } })).toMatchObject({ type: 'live.event' });
    expect(() => parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 13, source: 'game',
      event: { type: 'bossRoomWarning', exitId: 'exit:boss', risk: { ...bossRisk, retreatAllowed: true } } })).toThrow();
    expect(() => parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 12, source: 'game',
      event: { type: 'corpseRecovered', actorId, corpseId: instanceId, repeat: false } })).toThrow();
    expect(parseLiveServerFrame({ type: 'live.ack', instanceId, commandId: actorId, status: 'applied', duplicate: true }))
      .toMatchObject({ status: 'applied', duplicate: true });
    expect(() => parseLiveServerFrame({ ...snapshot, view: { phase: 'exploring', state: { checkpoint: {} } } })).toThrow();
    expect(() => parseLiveServerFrame({ ...snapshot, view: { phase: 'exploring', newPrivateView: [] } })).toThrow();
    expect(() => parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 9, source: 'game', event: { type: 'x', stateAfter: {} } })).toThrow();
  });

  it('validates owner death summary DTO including exact unique corpse identities', () => {
    const response = parseLiveDeathResponse({ death: { deathId: instanceId, occurredAt: 1000, areaId: 'region_1', locationId: 'glade',
      xpBefore: { level: 2, xpIntoLevel: 5, totalXp: 105 }, xpLost: 10, xpAfter: { level: 1, xpIntoLevel: 95, totalXp: 95 },
      causes: [{ sourceId: 'warden', label: 'skill:slash', damage: 20 }], corpse: { id: instanceId, status: 'active', expiresAt: 86_401_000,
        contents: { stacks: [{ item: 'healing_draught', qty: 1 }], gold: 3,
          uniques: [{ itemId: actorId, definition: 'iron_sabre', slot: null, rolls: {} }] } } } });
    expect(response.death?.corpse.contents.uniques[0]?.itemId).toBe(actorId);
    expect(parseLiveDeathResponse({ death: null })).toEqual({ death: null });
    expect(() => parseLiveDeathResponse({ death: { corpse: { status: 'unknown' } } })).toThrow();
  });

  it('validates the owner-scoped solo entry DTOs and rejects client-supplied setup fields', () => {
    expect(parseLiveOptions({ actorId, areas: [{ id: 'area:region_1', label: 'The Green March', startLocationId: 'location:gate' }],
      supplies: [{ item: 'item:potion', label: 'Healing draught', availableQty: 3 }] })).toMatchObject({ actorId });
    expect(parseLiveStartRequest({ commandId: instanceId, actorId, areaId: 'area:region_1',
      supplies: [{ item: 'item:potion', qty: 2 }] })).toMatchObject({ actorId, areaId: 'area:region_1' });
    expect(() => parseLiveStartRequest({ commandId: instanceId, actorId, areaId: 'area:region_1', supplies: [], seed: 1 })).toThrow();
    expect(() => parseLiveStartRequest({ commandId: instanceId, actorId, areaId: 'area:region_1',
      supplies: [{ item: 'item:potion', qty: 1 }, { item: 'item:potion', qty: 1 }] })).toThrow(ZodError);
    expect(parseLiveStartResponse({ instanceId })).toEqual({ instanceId });
    expect(parseLiveCurrent({ current: null })).toEqual({ current: null });
    expect(parseLiveCurrent({ current: { instanceId, actorId, view: { phase: 'exploring', heroes: [], groups: [] },
      participants: [{ actorId, status: 'connected' }] } })).toMatchObject({ current: { instanceId, actorId } });
  });
});
