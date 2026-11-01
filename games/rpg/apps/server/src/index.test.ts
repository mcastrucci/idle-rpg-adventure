import { describe, expect, it } from 'vitest';

import { SERVER_APP } from './index.ts';

describe('@rpg/server', () => {
  it('exports its package name', () => {
    expect(SERVER_APP).toBe('@rpg/server');
  });
});
