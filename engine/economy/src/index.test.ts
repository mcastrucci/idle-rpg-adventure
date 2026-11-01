import { describe, expect, it } from 'vitest';

import { ECONOMY_PACKAGE } from './index.ts';

describe('@engine/economy', () => {
  it('exports its package name', () => {
    expect(ECONOMY_PACKAGE).toBe('@engine/economy');
  });
});
