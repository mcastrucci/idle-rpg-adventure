import { describe, expect, it } from 'vitest';

import { createDatabase } from './database.ts';

const config = { databaseUrl: 'postgres://unused:unused@localhost:1/unused', poolMax: 1, databaseTimeoutMs: 100 };

describe('database lifecycle boundaries', () => {
  it('handles idle connection errors even without a server logger or active query', async () => {
    const database = createDatabase(config);
    try { expect(() => database.pool.emit('error', new Error('idle socket closed'))).not.toThrow(); }
    finally { await database.close(); }
  });
  it('notifies the configured telemetry handler and safely consumes late close errors', async () => {
    const received: Error[] = [];
    const database = createDatabase(config, { onIdleError: (error) => { received.push(error); } });
    await database.close();
    const error = new Error('late socket close');
    expect(() => database.pool.emit('error', error)).not.toThrow();
    expect(received).toEqual([error]);
  });
  it('rejects game migration journals that override engine ownership or contain SQL identifiers', () => {
    for (const set of [
      { id: 'engine', schema: 'rpg', directory: '/unused' },
      { id: 'rpg', schema: 'drizzle', directory: '/unused' },
      { id: 'rpg', schema: 'rpg;drop_schema', directory: '/unused' },
    ]) expect(() => createDatabase(config, { migrationSets: [set] })).toThrow('migration sets');
  });
});
