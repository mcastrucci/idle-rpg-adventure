import type { SceneImage, SceneSpec } from '@engine/client-kit';

import { sceneForLocation as placeholderSceneForLocation } from './placeholderScene.ts';

const BACKGROUND_SIZE = { width: 1086, height: 1448 } as const;

/** Paths and dimensions from public/assets/region-1/manifest.json. */
export const REGION_1_BACKGROUNDS = {
  'loc:region_1.portal_clearing': 'portal-clearing',
  'loc:region_1.irrigation_terraces': 'irrigation-terraces',
  'loc:region_1.seed_vault_heart': 'seed-vault-heart',
  'loc:region_1.overgrown_causeway': 'overgrown-causeway',
  'loc:region_1.old_well': 'old-well',
  'loc:region_1.tangle_orchard': 'tangle-orchard',
  'loc:region_1.glowcap_grotto': 'glowcap-grotto',
  'loc:region_1.lantern_ruins': 'lantern-ruins',
  'loc:region_1.pump_station': 'pump-station',
  'loc:region_1.vault_antechamber': 'vault-antechamber',
  'loc:region_1.sunken_greenhouse': 'sunken-greenhouse',
} as const;

export function regionBackgroundUrl(stem: string, baseUrl = import.meta.env.BASE_URL): string {
  return `${baseUrl.replace(/\/$/, '')}/assets/region-1/backgrounds/webp/${stem}.webp`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const fail = (error: Error) => {
      image.onload = null;
      image.onerror = null;
      reject(error);
    };
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      void image.decode().then(() => resolve(image), (error: unknown) => reject(error));
    };
    image.onerror = () => fail(new Error(`Failed to load scene background: ${src}`));
    image.src = src;
  });
}

function background(locationId: string, stem: string): SceneImage {
  const src = regionBackgroundUrl(stem);
  return {
    key: `${locationId}:bg`,
    ...BACKGROUND_SIZE,
    load: () => loadImage(src),
  };
}

/** Native flattened Region 1 backgrounds. Geometry waits for the compiled scene bundle (#154). */
export function sceneForRegionLocation(locationId: string): SceneSpec {
  if (!Object.hasOwn(REGION_1_BACKGROUNDS, locationId)) return placeholderSceneForLocation(locationId);
  const stem = REGION_1_BACKGROUNDS[locationId as keyof typeof REGION_1_BACKGROUNDS];
  return { id: locationId, background: background(locationId, stem), layers: [], regions: [] };
}
