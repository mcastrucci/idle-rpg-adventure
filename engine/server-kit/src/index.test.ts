import { describe, expect, it } from 'vitest';

import { SERVER_KIT_PACKAGE } from './index.ts';

describe('@engine/server-kit', () => {
  it('exports its package name', () => {
    expect(SERVER_KIT_PACKAGE).toBe('@engine/server-kit');
  });
});
