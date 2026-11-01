import { describe, expect, it } from 'vitest';

import { WEB_APP } from './index.ts';

describe('@rpg/web', () => {
  it('exports its package name', () => {
    expect(WEB_APP).toBe('@rpg/web');
  });
});
