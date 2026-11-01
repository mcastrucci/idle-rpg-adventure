import { describe, expect, it } from 'vitest';

import { SIM_CORE_PACKAGE } from './index.ts';

describe('@engine/sim-core', () => {
  it('exports its package name', () => {
    expect(SIM_CORE_PACKAGE).toBe('@engine/sim-core');
  });
});
