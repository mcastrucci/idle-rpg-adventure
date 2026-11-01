import { describe, expect, it } from 'vitest';

import { RPG_STATS_PACKAGE } from './index.ts';

describe('@rpg/rpg-stats', () => {
  it('exports its package name', () => {
    expect(RPG_STATS_PACKAGE).toBe('@rpg/rpg-stats');
  });
});
