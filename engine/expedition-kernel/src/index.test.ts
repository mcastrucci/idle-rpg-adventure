import { describe, expect, it } from 'vitest';

import { EXPEDITION_KERNEL_PACKAGE } from './index.ts';

describe('@engine/expedition-kernel', () => {
  it('exports its package name', () => {
    expect(EXPEDITION_KERNEL_PACKAGE).toBe('@engine/expedition-kernel');
  });
});
