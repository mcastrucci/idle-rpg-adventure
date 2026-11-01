import { describe, expect, it } from 'vitest';

import { SURVIVAL_SANDBOX_PACKAGE } from './index.ts';

describe('@survival/sandbox', () => {
  it('exports its package name', () => {
    expect(SURVIVAL_SANDBOX_PACKAGE).toBe('@survival/sandbox');
  });
});
