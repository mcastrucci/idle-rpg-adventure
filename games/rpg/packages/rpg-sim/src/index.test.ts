import { describe, expect, it } from 'vitest';

import { RPG_SIM_PACKAGE } from './index.ts';

describe('@rpg/rpg-sim', () => {
  it('exports its package name', () => {
    expect(RPG_SIM_PACKAGE).toBe('@rpg/rpg-sim');
  });
});
