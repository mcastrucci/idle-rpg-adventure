import { describe, expect, it } from 'vitest';

import { COMMAND_OPERATIONS, parseCommandEnvelope, PROTOCOL_PACKAGE } from './index.ts';

const id = 'cd7228dc-0ea5-4f41-b88f-963d791a34ed';
const envelope = (payload: unknown = {}) => ({ command_id: id, operation: 'character.create', payload });
describe('@rpg/protocol command envelope', () => {
  it('exports the package and an explicit operation allowlist', () => {
    expect(PROTOCOL_PACKAGE).toBe('@rpg/protocol');
    expect(COMMAND_OPERATIONS).toEqual(['character.create', 'character.configure', 'inventory.usePotion']);
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
});
