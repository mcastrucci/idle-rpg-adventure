import { describe, expect, it } from 'vitest';

import { CONTENT_COMPILER_PACKAGE } from './index.ts';

describe('@engine/content-compiler', () => {
  it('exports its package name', () => {
    expect(CONTENT_COMPILER_PACKAGE).toBe('@engine/content-compiler');
  });
});
