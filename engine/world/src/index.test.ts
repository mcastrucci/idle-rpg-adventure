import { describe, expect, it } from 'vitest';

import { WORLD_PACKAGE } from './index.ts';

describe('@engine/world', () => {
  it('exports its package name', () => {
    expect(WORLD_PACKAGE).toBe('@engine/world');
  });
});
