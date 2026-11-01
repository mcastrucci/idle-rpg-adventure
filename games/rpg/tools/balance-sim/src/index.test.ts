import { describe, expect, it } from 'vitest';

import { BALANCE_SIM_TOOL } from './index.ts';

describe('@rpg/balance-sim', () => {
  it('exports its package name', () => {
    expect(BALANCE_SIM_TOOL).toBe('@rpg/balance-sim');
  });
});
