import { describe, expect, it } from 'vitest';

import { LIVE_KERNEL_PACKAGE } from './index.ts';

describe('@engine/live-kernel', () => {
  it('exports its package name', () => {
    expect(LIVE_KERNEL_PACKAGE).toBe('@engine/live-kernel');
  });
});
