/**
 * Reference builds used as test fixtures (not content). Attribute spreads grow linearly per level to mimic point
 * allocation; starter gear has the `EquipmentItem` shape from `@rpg/rpg-schema`.
 */
import type { EquipmentItem } from '@rpg/rpg-schema';

import type { Attribute, AttributeMap } from '../derive.ts';

export interface ReferenceBuild {
  readonly name: string;
  /** Allocated attributes at level 1. */
  readonly base: AttributeMap;
  /** Points allocated per level above 1. */
  readonly perLevel: Readonly<Partial<Record<Attribute, number>>>;
  readonly gear: readonly EquipmentItem[];
}

function equipment(id: string, slot: EquipmentItem['slot'], stats: EquipmentItem['stats']): EquipmentItem {
  return { id: `item:${id}`, kind: 'equipment', slot, stats, value: 10, tags: [], stackable: false };
}

/** Bruiser / tank: STR + VIT, mace, shield and vest. */
export const BRUISER: ReferenceBuild = {
  name: 'bruiser/tank',
  base: { STR: 8, AGI: 3, INT: 1, VIT: 10, SPI: 3 },
  perLevel: { STR: 1, VIT: 2 },
  gear: [
    equipment('training_mace', 'weapon', { power: 4 }),
    equipment('wooden_shield', 'offhand', { armor: 6, maxHp: 10 }),
    equipment('padded_vest', 'chest', { armor: 4, VIT: 2 }),
  ],
};

/** Striker / sustain: INT + AGI + SPI, staff, healing charm and light boots. */
export const STRIKER: ReferenceBuild = {
  name: 'striker/sustain',
  base: { STR: 2, AGI: 8, INT: 9, VIT: 4, SPI: 6 },
  perLevel: { AGI: 1, INT: 1, SPI: 1 },
  gear: [
    equipment('apprentice_staff', 'weapon', { power: 3, critBp: 100 }),
    equipment('charm_of_mending', 'accessory', { healPower: 4, SPI: 1 }),
    equipment('light_boots', 'feet', { haste: 6, AGI: 1 }),
  ],
};

/** Allocated attributes of a build at `level`. */
export function attributesAt(build: ReferenceBuild, level: number): AttributeMap {
  const out = { ...build.base };
  for (const [attr, points] of Object.entries(build.perLevel) as [Attribute, number][]) {
    out[attr] += points * (level - 1);
  }
  return out;
}
