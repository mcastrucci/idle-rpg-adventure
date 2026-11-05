import { SPRITE_INDEX } from './regionArt.ts';
import type { SpriteArt, SpriteIndex } from './regionArt.ts';

/** The only hero appearance shipped in Region 1; every controlled hero uses it until appearances become content. */
export const HERO_SPRITE_ID = 'hero_max';

/**
 * Manifest sprite ID for an enemy. Combat actors carry their content name key (`enemy.<slug>.name`) and the manifest
 * keys its sprites by the content enemy ID (`enemy:<slug>`), so the key is the whole mapping: no table to keep in sync.
 */
export function enemySpriteId(nameKey: string | undefined): string | null {
  const slug = nameKey === undefined ? undefined : /^enemy\.(.+)\.name$/.exec(nameKey)?.[1];
  return slug === undefined ? null : `enemy:${slug}`;
}

/** The sprite for an enemy, or `null` when the manifest has none (the scene then draws a labelled silhouette). */
export function enemySprite(nameKey: string | undefined, index: SpriteIndex = SPRITE_INDEX): SpriteArt | null {
  const id = enemySpriteId(nameKey);
  return id === null ? null : index.get(id) ?? null;
}

export function heroSprite(index: SpriteIndex = SPRITE_INDEX): SpriteArt | null {
  return index.get(HERO_SPRITE_ID) ?? null;
}
