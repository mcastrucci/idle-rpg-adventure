/**
 * Frozen completion baselines (ADR-0008, docs/spec/conquest-rules.md §2): once an area's completion rule has a
 * `frozen` baseline in a published bundle, later builds must keep it and must keep every location of that published
 * pool, still tagged with the pool tag. Adding locations (tagged or not) is always allowed.
 */
import { poolLocations, type CompletionRule, type World } from '@engine/world';

import type { JsonPath } from './errors.ts';

/** A baseline violation with a path inside the *current* world (`['areas', i, ...]` / `['locations', i, ...]`). */
export interface BaselineViolation {
  readonly code: 'baseline.areaRemoved' | 'baseline.frozenChanged' | 'baseline.poolLocationRemoved' | 'baseline.poolLocationUntagged';
  readonly path: JsonPath;
  readonly message: string;
}

const FROZEN_FIELDS = ['poolSize', 'requiredCount', 'at'] as const;

export function checkFrozenBaselines(previous: World, current: World): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  const areaIndex = new Map(current.areas.map((area, i) => [area.id, i]));
  const locationIndex = new Map(current.locations.map((loc, i) => [loc.id, i]));

  for (const prevArea of previous.areas) {
    const prevRule = prevArea.completion;
    if (!prevRule?.frozen) continue;
    const i = areaIndex.get(prevArea.id);
    const area = i === undefined ? undefined : current.areas[i];
    if (i === undefined || area === undefined) {
      violations.push({
        code: 'baseline.areaRemoved',
        path: ['areas'],
        message: `Area "${prevArea.id}" has a published frozen baseline but no longer exists`,
      });
      continue;
    }
    const rulePath = ['areas', i, 'completion'];
    const frozen = area.completion?.frozen;
    if (!frozen) {
      violations.push({
        code: 'baseline.frozenChanged',
        path: rulePath,
        message: `Area "${area.id}" lost its published frozen baseline`,
      });
    } else {
      for (const field of FROZEN_FIELDS) {
        if (frozen[field] !== prevRule.frozen[field]) {
          violations.push({
            code: 'baseline.frozenChanged',
            path: [...rulePath, 'frozen', field],
            message: `Frozen ${field} changed from ${JSON.stringify(prevRule.frozen[field])} to ${JSON.stringify(frozen[field])} in "${area.id}"`,
          });
        }
      }
    }

    const rule: CompletionRule | undefined = area.completion;
    const tag = rule?.pool.tag ?? prevRule.pool.tag;
    const inArea = new Set(area.locations);
    for (const locId of poolLocations(prevArea, prevRule, previous.locations)) {
      const j = locationIndex.get(locId);
      const loc = j === undefined ? undefined : current.locations[j];
      if (j === undefined || loc === undefined || !inArea.has(locId)) {
        violations.push({
          code: 'baseline.poolLocationRemoved',
          path: ['areas', i, 'locations'],
          message: `Location "${locId}" of the published pool of "${area.id}" was removed from the area`,
        });
      } else if (!loc.tags.includes(tag)) {
        violations.push({
          code: 'baseline.poolLocationUntagged',
          path: ['locations', j, 'tags'],
          message: `Location "${locId}" of the published pool of "${area.id}" lost the pool tag "${tag}"`,
        });
      }
    }
  }
  return violations;
}
