/** Reserved protocol operations. A listed identifier does not imply an implemented handler or route. */
export const COMMAND_OPERATIONS = ['character.create', 'character.configure', 'inventory.usePotion'] as const;
export type CommandOperation = typeof COMMAND_OPERATIONS[number];
export type CommandJson = null | boolean | number | string | readonly CommandJson[] | { readonly [key: string]: CommandJson };
export interface CommandEnvelope {
  readonly commandId: string;
  readonly operation: CommandOperation;
  readonly payload: { readonly [key: string]: CommandJson };
}
export interface CommandEnvelopeWire {
  readonly command_id: string;
  readonly operation: CommandOperation;
  readonly payload: { readonly [key: string]: CommandJson };
}
export const COMMAND_PAYLOAD_MAX_BYTES = 65_536;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** HTTP JSON bodies and decoded WebSocket messages use this same parser. Domain payload validation follows. */
export function parseCommandEnvelope(input: unknown): CommandEnvelope {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid command envelope');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || !['command_id', 'operation', 'payload'].every((key) => keys.includes(key) && 'value' in (descriptors[key] ?? {}))) throw new TypeError('invalid command envelope');
  const commandId: unknown = descriptors['command_id']?.value;
  const operation: unknown = descriptors['operation']?.value;
  const payload: unknown = descriptors['payload']?.value;
  if (typeof commandId !== 'string' || !uuid.test(commandId) || typeof operation !== 'string' || !COMMAND_OPERATIONS.some((value) => value === operation) ||
      payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('invalid command envelope');
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const ancestors = new Set<object>();
  function add(text: string): void {
    bytes += encoder.encode(text).byteLength;
    if (bytes > COMMAND_PAYLOAD_MAX_BYTES) throw new TypeError('command payload is too large');
  }
  function clone(value: unknown, depth: number): CommandJson {
    if (++nodes > 10_000 || depth > 32) throw new TypeError('command payload is too complex');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      add(JSON.stringify(value)); return value;
    }
    if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('invalid command payload');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid command payload object');
    ancestors.add(value);
    const properties = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(value);
    if (Reflect.ownKeys(value).length !== names.length + (Array.isArray(value) ? 1 : 0) || names.some((key) => !('value' in (properties[key] ?? {})))) throw new TypeError('invalid command payload property');
    let result: CommandJson;
    add('[]');
    if (Array.isArray(value)) {
      if (names.length !== value.length || names.some((key, index) => key !== String(index))) throw new TypeError('invalid command payload array');
      result = names.map((key, index) => { if (index > 0) add(','); return clone(properties[key]?.value, depth + 1); });
    } else {
      result = Object.fromEntries(names.map((key, index) => { add(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`); return [key, clone(properties[key]?.value, depth + 1)]; }));
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  return Object.freeze({ commandId: commandId.toLowerCase(), operation: operation as CommandOperation, payload: clone(payload, 0) as CommandEnvelope['payload'] });
}
