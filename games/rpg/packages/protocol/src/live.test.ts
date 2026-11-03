import { describe, expect, it } from 'vitest';
import { parseLiveClientRequest, parseLiveServerFrame } from './live.ts';

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
    expect(parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 9, source: 'game',
      event: { type: 'gathered', nodeId: 'node:one', drops: [{ item: 'item:herb', qty: 2 }], gold: 3 } })).toMatchObject({ type: 'live.event' });
    expect(parseLiveServerFrame({ type: 'live.ack', instanceId, commandId: actorId, status: 'applied', duplicate: true }))
      .toMatchObject({ status: 'applied', duplicate: true });
    expect(() => parseLiveServerFrame({ ...snapshot, view: { phase: 'exploring', state: { checkpoint: {} } } })).toThrow();
    expect(() => parseLiveServerFrame({ ...snapshot, view: { phase: 'exploring', newPrivateView: [] } })).toThrow();
    expect(() => parseLiveServerFrame({ type: 'live.event', instanceId, epoch: 2, seq: 9, source: 'game', event: { type: 'x', stateAfter: {} } })).toThrow();
  });
});
