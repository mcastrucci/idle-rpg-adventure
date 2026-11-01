import { describe, expect, it } from 'vitest';

import { RPG_SCHEMA_PACKAGE } from './index.ts';

describe('@rpg/rpg-schema', () => {
  it('exports its package name', () => {
    expect(RPG_SCHEMA_PACKAGE).toBe('@rpg/rpg-schema');
  });
});
