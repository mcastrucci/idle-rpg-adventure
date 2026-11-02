import { describe, expect, it } from 'vitest';

import { COMMAND_OPERATIONS, parseCommandEnvelope, parseExpeditionDto, parseExpeditionOptionsDto, parseExpeditionStartPayload, PROTOCOL_PACKAGE } from './index.ts';

const id = 'cd7228dc-0ea5-4f41-b88f-963d791a34ed';
const envelope = (payload: unknown = {}) => ({ command_id: id, operation: 'character.create', payload });
describe('@rpg/protocol command envelope', () => {
  it('exports the package and an explicit operation allowlist', () => {
    expect(PROTOCOL_PACKAGE).toBe('@rpg/protocol');
    expect(COMMAND_OPERATIONS).toEqual(['character.create', 'character.configure', 'inventory.usePotion', 'expedition.start', 'expedition.cancel', 'expedition.recoverUnavailable']);
  });
  it('shares strict parsing for HTTP and WS JSON and detaches/freeze payloads', () => {
    const input = envelope({ name: 'Ada', nested: { values: [1, true, null] } });
    const parsed = parseCommandEnvelope(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual(parseCommandEnvelope(JSON.parse(JSON.stringify(input))));
    expect(Object.isFrozen(parsed.payload)).toBe(true);
    expect(Object.isFrozen(parsed.payload['nested'])).toBe(true);
    expect(parseCommandEnvelope({ ...input, command_id: id.toUpperCase() }).commandId).toBe(id);
  });
  it.each([null, [], {}, { ...envelope(), extra: true }, { ...envelope(), command_id: 'not-a-uuid' },
    { ...envelope(), operation: 'unbounded.operation' }, envelope([]), envelope({ bad: undefined }), envelope({ bad: Infinity }),
    envelope({ bad: new Date() }), envelope({ tooLong: 'a'.repeat(65_536) })])('rejects invalid or oversized input %#', (input) => {
    expect(() => parseCommandEnvelope(input)).toThrow(TypeError);
  });
  it('rejects cycles, sparse arrays, getters, and excess nesting', () => {
    const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
    const nested = Array.from({ length: 34 }).reduce<unknown>((value) => ({ child: value }), 1);
    for (const payload of [cycle, { sparse: Array(2) }, { get value() { throw new Error('getter must not run'); } }, nested]) {
      expect(() => parseCommandEnvelope(envelope(payload))).toThrow(TypeError);
    }
  });

  it('validates expedition command inputs and server-gated option DTOs', () => {
    const start = parseExpeditionStartPayload({ actorId: id.toUpperCase(), request: { areaId: 'area:ruins', activityId: 'activity:ruins', durationMin: 30, paceBp: 10_000 },
      config: { consumables: [{ item: 'potion:minor', qty: 2 }], retreat: { belowHpBp: 2_500, onlyWhenNoHealing: true } } });
    expect(start.actorId).toBe(id);
    expect(start.config.consumables[0]?.qty).toBe(2);
    expect(() => parseExpeditionStartPayload({ ...start, request: { ...start.request, durationMin: 0 } })).toThrow(TypeError);
    expect(parseExpeditionOptionsDto({ actorId: id, areas: [{ areaId: 'area:ruins', kind: 'explorable', activities: [{ activityId: 'activity:ruins', simulatorId: 'sim:idle', available: true }] }],
      durationsMin: [15, 30], paceBp: { min: 1, max: 20_000, default: 10_000 }, consumables: [] }).areas).toHaveLength(1);
  });

  it('accepts revealed expedition state while rejecting hidden timeline fields', () => {
    const visible = { id, actorId: id, state: 'running', areaId: 'area:ruins', activityId: 'activity:ruins', startsAtMs: 1, plannedEndsAtMs: 10,
      progress: { revealed: 1 }, segments: [{ index: 0, revealAtMs: 2, events: [{ type: 'hit', amount: 3 }] }], revealedDeltas: [],
      cancelPreview: { rewards: [], consumablesUsed: [], consumablesReturned: [], keptProgress: [], converted: false } };
    expect(parseExpeditionDto(visible).segments).toHaveLength(1);
    expect(() => parseExpeditionDto({ ...visible, totalSegments: 99 })).toThrow(TypeError);
    expect(() => parseExpeditionDto({ ...visible, stateAfter: {} })).toThrow(TypeError);
    expect(() => parseExpeditionDto({ ...visible, outcome: { win: true } })).toThrow(TypeError);
  });
});
