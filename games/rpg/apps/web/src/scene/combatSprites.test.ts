import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HERO_SPRITE_ID, enemySprite, enemySpriteId, heroSprite } from './combatSprites.ts';
import { SPRITE_INDEX, buildSpriteIndex } from './regionArt.ts';

const WEB_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(WEB_ROOT, '../../../..');
const manifest = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/assets/region-1/manifest.json'), 'utf8')) as { sprites: { id: string; image: string }[] };
const region1Enemies = JSON.parse(readFileSync(resolve(REPO_ROOT, 'games/rpg/content/enemies/region_1.json'), 'utf8')) as { id: string; nameKey: string }[];

describe('combat sprite resolution', () => {
  it('maps an enemy name key to the manifest sprite of the same content enemy', () => {
    expect(enemySpriteId('enemy.thornback_boar.name')).toBe('enemy:thornback_boar');
    expect(enemySprite('enemy.thornback_boar.name')?.url).toBe(`${import.meta.env.BASE_URL}assets/region-1/sprites/thornback_boar.png`);
    expect(enemySprite('enemy.hollow_matriarch.name')?.id).toBe('enemy:hollow_matriarch');
  });

  it('resolves to null (a silhouette) for an enemy without art or without a name key', () => {
    expect(enemySprite('enemy.glass_wisp.name')).toBeNull();
    expect(enemySprite('skill.guard.name')).toBeNull();
    expect(enemySprite(undefined)).toBeNull();
    expect(enemySpriteId('enemy.name')).toBeNull();
  });

  it('has a sprite for every Region 1 enemy and for the hero, and every one is a shipped file', () => {
    for (const enemy of region1Enemies) expect(enemySprite(enemy.nameKey), enemy.id).not.toBeNull();
    expect(heroSprite()?.id).toBe(HERO_SPRITE_ID);
    for (const sprite of manifest.sprites) {
      expect(SPRITE_INDEX.get(sprite.id)?.url, sprite.id).toBe(`${import.meta.env.BASE_URL}assets/region-1/${sprite.image}`);
      expect(existsSync(resolve(WEB_ROOT, 'public/assets/region-1', sprite.image)), sprite.id).toBe(true);
    }
  });

  it('builds an index from any manifest without fetching anything', () => {
    const index = buildSpriteIndex([{ baseUrl: '/assets/region-9/', sprites: [{ id: 'enemy:glass_wisp', image: 'sprites/glass_wisp.png' }] }]);
    expect(enemySprite('enemy.glass_wisp.name', index)?.url).toBe('/assets/region-9/sprites/glass_wisp.png');
  });
});
