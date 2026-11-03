/**
 * Cross-document RPG checks (the plugin's `validate` hook). They run after schemas, the world graph and every
 * reference resolved, so referenced entities exist. Error codes are namespaced `rpg.*`.
 */
import type { CompiledContent, ContentEntity, PluginIssue } from '@engine/content-compiler';
import { walkRequirement } from '@engine/world';
import type { SceneGeometry } from '@engine/world';
import type { Enemy, Hotspot, Item, Merchant, Skill } from '@rpg/rpg-schema';

import { XP_CURVE_ID } from './collections.ts';
import { completionDefeatedEnemies } from './references.ts';

export const RPG_ISSUE_CODES = {
  telegraphWithoutWindup: 'rpg.telegraphWithoutWindup',
  completionEnemyNotBoss: 'rpg.completionEnemyNotBoss',
  activitiesOnNonExplorable: 'rpg.activitiesOnNonExplorable',
  xpCurveMissing: 'rpg.xpCurveMissing',
  xpCurveUnexpected: 'rpg.xpCurveUnexpected',
  aiSkillNotKnown: 'rpg.aiSkillNotKnown',
  exitFlagNeverSet: 'rpg.exitFlagNeverSet',
  merchantOfferIdDuplicate: 'rpg.merchantOfferIdDuplicate',
  merchantOfferInvalidItem: 'rpg.merchantOfferInvalidItem',
} as const;

/** Entities of a game collection, typed by the schema that parsed them. */
function collection<T>(content: CompiledContent, name: string): readonly (T & ContentEntity)[] {
  return (content.collections[name] ?? []) as readonly (T & ContentEntity)[];
}

export function validateRpgContent(content: CompiledContent): PluginIssue[] {
  return [
    ...checkTelegraphWindups(content),
    ...checkCompletionBosses(content),
    ...checkActivityAreas(content),
    ...checkXpCurve(content),
    ...checkAiSkillReady(content),
    ...checkExitFlags(content),
    ...checkMerchantOfferIds(content),
    ...checkMerchantOfferItems(content),
  ];
}

/** Geometry in Tiled must have an exact name-to-entity match with the RPG location data. */
export function validateRpgScenes(content: CompiledContent, scenes: Readonly<Record<string, SceneGeometry>>): PluginIssue[] {
  const issues: PluginIssue[] = [];
  const locations = new Map(content.world.locations.map((location) => [location.id, location]));
  for (const [locationId, scene] of Object.entries(scenes)) {
    const location = locations.get(locationId as typeof content.world.locations[number]['id']) as (typeof content.world.locations[number] & {
      hotspots?: readonly Hotspot[];
      resources?: readonly { node: string; lootTable: string }[];
      enemyAnchors?: readonly string[];
    }) | undefined;
    if (!location) continue;
    compareGeometry(issues, locationId, 'exits', location.exits.map((exit) => exit.id), Object.keys(scene.exits));
    compareGeometry(issues, locationId, 'hotspots', location.hotspots?.map((hotspot) => hotspot.id) ?? [], Object.keys(scene.hotspots));
    const resourceOrdinals = new Map<string, number>();
    const resourceIds = (location.resources ?? []).map((resource) => {
      const ordinal = resourceOrdinals.get(resource.node) ?? 0;
      resourceOrdinals.set(resource.node, ordinal + 1);
      return `${resource.node}#${ordinal}`;
    });
    compareGeometry(issues, locationId, 'resources', resourceIds, Object.keys(scene.resources));
    compareGeometry(issues, locationId, 'enemyAnchors', location.enemyAnchors ?? [], Object.keys(scene.enemyAnchors));
  }
  return issues;
}

function compareGeometry(issues: PluginIssue[], location: string, field: string, jsonIds: readonly string[], geometryIds: readonly string[]): void {
  const expected = [...jsonIds].sort();
  const actual = [...geometryIds].sort();
  if (expected.length === actual.length && expected.every((id, index) => id === actual[index])) return;
  issues.push({ collection: 'locations', id: location, path: [field], code: 'scene.entityParity',
    message: `${field} geometry names must exactly match location JSON IDs (JSON: [${expected.join(', ')}]; Tiled: [${actual.join(', ')}])` });
}

/** Merchant POC buys only stackable consumables; material prices and equipment balance stay undecided. */
function checkMerchantOfferItems(content: CompiledContent): PluginIssue[] {
  const items = new Map<string, Item>(collection<Item>(content, 'items').map(item => [item.id, item]));
  const issues: PluginIssue[] = [];
  for (const merchant of collection<Merchant>(content, 'merchants')) {
    merchant.offers.forEach((offer, index) => {
      const item = items.get(offer.item);
      if (item && (item.kind !== 'consumable' || !item.stackable)) issues.push({
        code: RPG_ISSUE_CODES.merchantOfferInvalidItem, collection: 'merchants', id: merchant.id,
        path: ['offers', index, 'item'], message: `Offer "${offer.id}" must sell a stackable consumable`,
      });
    });
  }
  return issues;
}

/** Buy commands address offers by ID alone, so offer IDs must be globally unique across merchant catalogs. */
function checkMerchantOfferIds(content: CompiledContent): PluginIssue[] {
  const seen = new Set<string>();
  const issues: PluginIssue[] = [];
  for (const merchant of collection<{ id: string; offers: readonly { id: string }[] }>(content, 'merchants')) {
    merchant.offers.forEach((offer, index) => {
      if (seen.has(offer.id)) issues.push({ code: RPG_ISSUE_CODES.merchantOfferIdDuplicate, collection: 'merchants', id: merchant.id,
        path: ['offers', index, 'id'], message: `Offer ID "${offer.id}" is already used in another merchant` });
      seen.add(offer.id);
    });
  }
  return issues;
}

/** Telegraphed boss skills must have a windup (`windupTicks > 0`), otherwise there is nothing to react to. */
function checkTelegraphWindups(content: CompiledContent): PluginIssue[] {
  const skills = new Map<string, Skill>(collection<Skill>(content, 'skills').map((s) => [s.id, s]));
  const issues: PluginIssue[] = [];
  for (const enemy of collection<Enemy>(content, 'enemies')) {
    if (enemy.rank !== 'boss') continue;
    enemy.phases.forEach((phase, i) => {
      phase.telegraphs.forEach((skillId, j) => {
        const skill = skills.get(skillId);
        if (skill && skill.windupTicks <= 0) {
          issues.push({
            code: RPG_ISSUE_CODES.telegraphWithoutWindup,
            collection: 'enemies',
            id: enemy.id,
            path: ['phases', i, 'telegraphs', j],
            message: `Telegraphed skill "${skillId}" has windupTicks ${skill.windupTicks}; telegraphs need windupTicks > 0`,
          });
        }
      });
    });
  }
  return issues;
}

/** Enemies an area's completion requires to be defeated (mandatory bosses) must be `rank: "boss"`. */
function checkCompletionBosses(content: CompiledContent): PluginIssue[] {
  const enemies = new Map<string, Enemy>(collection<Enemy>(content, 'enemies').map((e) => [e.id, e]));
  const issues: PluginIssue[] = [];
  for (const { area, enemy: enemyId, path } of completionDefeatedEnemies(content)) {
    const enemy = typeof enemyId === 'string' ? enemies.get(enemyId) : undefined;
    if (enemy && enemy.rank !== 'boss') {
      issues.push({
        code: RPG_ISSUE_CODES.completionEnemyNotBoss,
        collection: 'areas',
        id: area,
        path,
        message: `Completion requires defeating "${enemy.id}", which is rank "${enemy.rank}"; mandatory enemies must be bosses`,
      });
    }
  }
  return issues;
}

/** Idle activities only exist in explorable areas (hubs and other kinds have no hunting/gathering grounds). */
function checkActivityAreas(content: CompiledContent): PluginIssue[] {
  return content.world.areas
    .filter((area) => area.kind !== 'explorable' && (area.activities?.length ?? 0) > 0)
    .map((area) => ({
      code: RPG_ISSUE_CODES.activitiesOnNonExplorable,
      collection: 'areas',
      id: area.id,
      path: ['activities'],
      message: `Area "${area.id}" is "${area.kind}"; idle activities are only allowed on explorable areas`,
    }));
}

/** Exactly one XP curve, `progression:xp_curve`. */
function checkXpCurve(content: CompiledContent): PluginIssue[] {
  const docs = content.collections['progression'] ?? [];
  const issues: PluginIssue[] = docs
    .filter((doc) => doc.id !== XP_CURVE_ID)
    .map((doc) => ({
      code: RPG_ISSUE_CODES.xpCurveUnexpected,
      collection: 'progression',
      id: doc.id,
      path: ['id'],
      message: `Unexpected progression document "${doc.id}"; the only XP curve is "${XP_CURVE_ID}"`,
    }));
  if (!docs.some((doc) => doc.id === XP_CURVE_ID)) {
    issues.push({
      code: RPG_ISSUE_CODES.xpCurveMissing,
      message: `Missing XP curve "${XP_CURVE_ID}" (progression/xp-curve.json)`,
    });
  }
  return issues;
}

/** An AI rule's `skillReady` condition must name one of the enemy's own skills (the schema checks `do.useSkill`). */
function checkAiSkillReady(content: CompiledContent): PluginIssue[] {
  const issues: PluginIssue[] = [];
  for (const enemy of collection<Enemy>(content, 'enemies')) {
    const known = new Set<string>(enemy.skills);
    enemy.ai.forEach((rule, i) => {
      const skill = rule.when.skillReady;
      if (skill !== undefined && !known.has(skill)) {
        issues.push({
          code: RPG_ISSUE_CODES.aiSkillNotKnown,
          collection: 'enemies',
          id: enemy.id,
          path: ['ai', i, 'when', 'skillReady'],
          message: `AI condition skillReady "${skill}" is not in the enemy's "skills"`,
        });
      }
    });
  }
  return issues;
}

/**
 * A `{ "flag": … }` in an exit requirement must be settable by a hotspot effect (`setFlag`) of a location in the same
 * area: hotspot flags are instance-scoped (open decision #20, provisional), so nothing else can ever open that exit.
 */
function checkExitFlags(content: CompiledContent): PluginIssue[] {
  const areaOf = new Map<string, string>();
  for (const area of content.world.areas) for (const location of area.locations) areaOf.set(location, area.id);
  const settable = new Set<string>();
  for (const location of content.world.locations) {
    const hotspots = ((location as { hotspots?: readonly Hotspot[] }).hotspots ?? []);
    for (const hotspot of hotspots) for (const effect of hotspot.effects ?? []) settable.add(`${areaOf.get(location.id) ?? ''}|${effect.setFlag}`);
  }
  const issues: PluginIssue[] = [];
  for (const location of content.world.locations) {
    location.exits.forEach((exit, i) => {
      if (!exit.requires) return;
      walkRequirement(exit.requires, (node, path) => {
        if (!('flag' in node) || settable.has(`${areaOf.get(location.id) ?? ''}|${node.flag}`)) return;
        issues.push({
          code: RPG_ISSUE_CODES.exitFlagNeverSet,
          collection: 'locations',
          id: location.id,
          path: ['exits', i, 'requires', ...path],
          message: `Exit "${exit.id}" requires flag "${node.flag}", but no hotspot effect in its area sets it`,
        });
      });
    });
  }
  return issues;
}
