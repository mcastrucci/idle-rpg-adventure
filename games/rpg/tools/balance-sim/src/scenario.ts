/**
 * Region 1 balance scenario: reference builds, loadouts, automation rules and the modelling parameters of the hourly
 * reports.
 *
 * **Everything here is PROVISIONAL.** The builds are the paper design's reference builds
 * (docs/design/region-1.md §4.2–§4.3) and exist only as balance-sim inputs; they are not content, not a build system
 * and not a decision on open decision #13 (attribute points, slots). Gear progression per level, potion counts, the
 * live route and the regen numbers are modelling assumptions documented in the README and in every report.
 */
import { AutomationRulesSchema } from '@rpg/rpg-schema';
import type { AutomationRule } from '@rpg/rpg-schema';
import type { AttributeMap } from '@rpg/rpg-stats';

export interface HeroLoadout {
  /** Equipped skills (`skill:basic_attack` included). */
  readonly skills: readonly string[];
  /** Ordered automation rules (≤ 6). */
  readonly rules: readonly AutomationRule[];
}

export interface HeroBuildDef {
  /** Short stable key used in seeds and reports. */
  readonly key: string;
  readonly name: string;
  /** Allocated attributes per hero level (every simulated level must be present). */
  readonly attributesByLevel: Readonly<Record<number, AttributeMap>>;
  /** Equipped item IDs per hero level (resolved against the content's equipment items). */
  readonly gearByLevel: (level: number) => readonly string[];
  /** Loadout for common fights, idle hunting and the live route. */
  readonly loadout: HeroLoadout;
  /** Loadout for mini-boss attempts. */
  readonly bossLoadout: HeroLoadout;
  /**
   * Skills a scripted attentive live player uses by hand: `guard` to pre-empt telegraphs, `cleanse` against DoTs.
   * A skill is only used if it is in the loadout of that fight.
   */
  readonly live: { readonly guard?: string; readonly cleanse?: string };
}

/** A live farming route: which encounter tables the player visits and which groups they walk past. */
export interface LiveRouteDef {
  readonly name: string;
  /** Fights per hour of play (travel, looting and instance resets included). */
  readonly encountersPerHour: number;
  /** Encounter tables visited, chosen uniformly per encounter. */
  readonly tables: readonly string[];
  /** A rolled group made only of these enemies is skipped (re-rolled at no time cost). */
  readonly skipGroupsOnlyOf: readonly string[];
  /** HP restored between fights, bp of max HP (short rest at 1%/tick, A9; the rest is spent on potions). */
  readonly restBetweenFightsBp: number;
  /** Minor potions available per hour (bought in Sanctuary). */
  readonly potionsPerHour: number;
}

export interface Scenario {
  readonly name: string;
  readonly builds: readonly HeroBuildDef[];
  /** Encounter tables whose distinct groups form the per-group cells. */
  readonly cellTables: readonly string[];
  /** Mini-boss encounter (single enemy). */
  readonly boss: string;
  readonly potion: string;
  /** Potions carried into every common-fight cell. */
  readonly cellPotions: number;
  /** Potions carried into a mini-boss attempt (design §7.4: 4 minor potions). */
  readonly bossPotions: number;
  /** Idle activities simulated per hour. */
  readonly idleActivities: readonly string[];
  /** Potions escrowed per idle hour. */
  readonly idlePotionsPerHour: number;
  readonly liveRoute: LiveRouteDef;
}

const P = 'item:minor_healing_potion';

function attrs(STR: number, AGI: number, INT: number, VIT: number, SPI: number): AttributeMap {
  return { STR, AGI, INT, VIT, SPI };
}

function validRules(rules: unknown): AutomationRule[] {
  return AutomationRulesSchema.parse(rules);
}

/**
 * Bulwark (bruiser/tank). L1/L3/L5 spreads are the design's; L2/L4/L6 continue its +4/level pattern
 * (STR +1, VIT +2, SPI +1). Rules are design §4.3 verbatim.
 */
export const BULWARK: HeroBuildDef = {
  key: 'bulwark',
  name: 'Bulwark',
  attributesByLevel: {
    1: attrs(9, 4, 2, 10, 5),
    2: attrs(10, 4, 2, 12, 6),
    3: attrs(11, 4, 2, 14, 7),
    4: attrs(12, 4, 2, 16, 8),
    5: attrs(13, 4, 2, 18, 9),
    6: attrs(14, 4, 2, 20, 10),
  },
  gearByLevel: (level) => [
    'item:rusty_sword',
    level >= 3 ? 'item:boar_hide_jerkin' : 'item:padded_vest',
    level >= 4 ? 'item:tiller_plate_buckler' : 'item:wooden_buckler',
  ],
  loadout: {
    skills: ['skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
    rules: validRules([
      { when: { selfHpBelowBp: 4000, hasConsumable: P }, do: { useConsumable: P } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
  },
  bossLoadout: {
    skills: ['skill:basic_attack', 'skill:shield_bash', 'skill:guard', 'skill:cleave', 'skill:mend'],
    rules: validRules([
      { when: { selfHpBelowBp: 4000, hasConsumable: P }, do: { useConsumable: P } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { selfHpBelowBp: 5500, skillReady: 'skill:mend' }, do: { useSkill: 'skill:mend', target: 'self' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:shield_bash' }, do: { useSkill: 'skill:shield_bash', target: 'lowestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
  },
  live: { guard: 'skill:guard' },
};

/**
 * Thornblade (striker/sustain). L1/L3/L5 spreads are the design's; L2/L4/L6 interpolate/extrapolate at +4/level.
 * Rules are design §4.3, except that rule 2 (`second_wind`) fires on `selfHasHarmfulEffect` instead of an HP threshold
 * (§9 Q-B7, #71). The boss variant swaps `cleave` for `guard` (rule 3 becomes the telegraph rule).
 */
export const THORNBLADE: HeroBuildDef = {
  key: 'thornblade',
  name: 'Thornblade',
  attributesByLevel: {
    1: attrs(11, 9, 2, 5, 3),
    2: attrs(12, 10, 2, 6, 4),
    3: attrs(14, 11, 2, 7, 4),
    4: attrs(15, 12, 2, 8, 5),
    5: attrs(17, 13, 2, 9, 5),
    6: attrs(18, 14, 2, 10, 6),
  },
  gearByLevel: (level) => [
    'item:rusty_sword',
    level >= 3 ? 'item:boar_hide_jerkin' : 'item:padded_vest',
    ...(level >= 4 ? ['item:lantern_lens'] : []),
  ],
  loadout: {
    skills: ['skill:basic_attack', 'skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:cleave'],
    rules: validRules([
      { when: { selfHpBelowBp: 4000, hasConsumable: P }, do: { useConsumable: P } },
      { when: { selfHasHarmfulEffect: true, skillReady: 'skill:second_wind' }, do: { useSkill: 'skill:second_wind' } },
      { when: { enemiesAtLeast: 2, skillReady: 'skill:cleave' }, do: { useSkill: 'skill:cleave' } },
      { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
      { when: { skillReady: 'skill:rend' }, do: { useSkill: 'skill:rend', target: 'highestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
  },
  bossLoadout: {
    skills: ['skill:basic_attack', 'skill:precise_strike', 'skill:rend', 'skill:second_wind', 'skill:guard'],
    rules: validRules([
      { when: { selfHpBelowBp: 4000, hasConsumable: P }, do: { useConsumable: P } },
      { when: { selfHasHarmfulEffect: true, skillReady: 'skill:second_wind' }, do: { useSkill: 'skill:second_wind' } },
      { when: { enemyTelegraphing: true, skillReady: 'skill:guard' }, do: { useSkill: 'skill:guard' } },
      { when: { skillReady: 'skill:precise_strike' }, do: { useSkill: 'skill:precise_strike', target: 'lowestHpEnemy' } },
      { when: { skillReady: 'skill:rend' }, do: { useSkill: 'skill:rend', target: 'highestHpEnemy' } },
      { when: {}, do: { useSkill: 'skill:basic_attack', target: 'lowestHpEnemy' } },
    ]),
  },
  live: { guard: 'skill:guard', cleanse: 'skill:second_wind' },
};

/** The Region 1 scenario (provisional). */
export const REGION_1_SCENARIO: Scenario = {
  name: 'region-1 (provisional reference builds, design §4.2–§4.3)',
  builds: [BULWARK, THORNBLADE],
  cellTables: [
    'enc:region_1.causeway',
    'enc:region_1.old_well',
    'enc:region_1.orchard',
    'enc:region_1.grotto',
    'enc:region_1.lantern_ruins',
    'enc:region_1.terraces',
    'enc:region_1.pump_station',
    'enc:region_1.greenhouse',
    'enc:region_1.hunt',
    'enc:region_1.gather',
  ],
  boss: 'enemy:hollow_matriarch',
  potion: P,
  cellPotions: 4,
  bossPotions: 4,
  idleActivities: ['idle:region_1.hunt', 'idle:region_1.gather'],
  idlePotionsPerHour: 5,
  liveRoute: {
    name: 'efficient live (lantern/tiller spots, mite-only packs skipped)',
    encountersPerHour: 36,
    tables: ['enc:region_1.lantern_ruins', 'enc:region_1.pump_station', 'enc:region_1.terraces'],
    skipGroupsOnlyOf: ['enemy:glowcap_mite'],
    restBetweenFightsBp: 2000,
    potionsPerHour: 6,
  },
};
