import { describe, expect, it } from 'vitest';

import { appendOnlyViolations } from './check-append-only.ts';

describe('golden fixtures are append-only', () => {
  const base = { 'v@1.0.0': { a: '01', b: '02' } };

  it('accepts new versions and new cases', () => {
    expect(appendOnlyViolations(base, { ...base, 'v@1.1.0': { a: '11' } })).toEqual([]);
    expect(appendOnlyViolations(base, { 'v@1.0.0': { a: '01', b: '02', c: '03' } })).toEqual([]);
  });

  it('rejects a changed hash under an existing version (behaviour change without a bump)', () => {
    expect(appendOnlyViolations(base, { 'v@1.0.0': { a: '01', b: 'ff' } })).toEqual(['v@1.0.0 / b changed 02 → ff']);
  });

  it('rejects removed cases and versions', () => {
    expect(appendOnlyViolations(base, { 'v@1.0.0': { a: '01' } })).toEqual(['v@1.0.0 / b was removed']);
    expect(appendOnlyViolations(base, {})).toEqual(['version v@1.0.0 was removed']);
  });
});
