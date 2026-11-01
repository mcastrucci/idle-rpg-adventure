import { describe, expect, it } from 'vitest';

import { PROTOCOL_PACKAGE } from './index.ts';

describe('@rpg/protocol', () => {
  it('exports its package name', () => {
    expect(PROTOCOL_PACKAGE).toBe('@rpg/protocol');
  });
});
