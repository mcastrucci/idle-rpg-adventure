import { describe, expect, it } from 'vitest';

import { CLIENT_KIT_PACKAGE } from './index.ts';

describe('@engine/client-kit', () => {
  it('exports its package name', () => {
    expect(CLIENT_KIT_PACKAGE).toBe('@engine/client-kit');
  });
});
