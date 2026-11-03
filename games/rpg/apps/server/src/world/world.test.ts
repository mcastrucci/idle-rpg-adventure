import type { Requirement } from '@engine/world';
import { describe, expect, it } from 'vitest';

import { mandatoryDefeatedEnemyIds } from './http.ts';

const defeated = (enemy: string) => ({ game: 'defeated', enemy }) as Requirement;

describe('mandatory boss projection', () => {
  it('collects defeated predicates required by every conjunction branch', () => {
    expect(mandatoryDefeatedEnemyIds({ all: [defeated('enemy:a'), { any: [defeated('enemy:b'), defeated('enemy:c')] }] } as Requirement))
      .toEqual(['enemy:a']);
  });

  it('does not treat alternatives or negated defeat predicates as mandatory', () => {
    expect(mandatoryDefeatedEnemyIds({ any: [defeated('enemy:a'), defeated('enemy:b')] } as Requirement)).toEqual([]);
    expect(mandatoryDefeatedEnemyIds({ not: defeated('enemy:a') } as Requirement)).toEqual([]);
  });

  it('keeps a boss mandatory when every alternative requires it', () => {
    expect(mandatoryDefeatedEnemyIds({ any: [
      { all: [defeated('enemy:a'), { flag: 'route.open' }] },
      { all: [defeated('enemy:a'), { flag: 'route.opened' }] },
    ] } as Requirement)).toEqual(['enemy:a']);
  });
});
