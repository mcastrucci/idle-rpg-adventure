import { humanizeId, labelOrHumanized } from '../../content/labels.ts';
import { t } from '../../i18n/index.ts';

/** Catalog keys for the closed sets the inventory shows by name; anything else falls back to a humanized ID. */
const SLOT_KEYS: Readonly<Record<string, string>> = {
  weapon: 'ui.inventory.slot.weapon',
  offhand: 'ui.inventory.slot.offhand',
  head: 'ui.inventory.slot.head',
  chest: 'ui.inventory.slot.chest',
  legs: 'ui.inventory.slot.legs',
  hands: 'ui.inventory.slot.hands',
  feet: 'ui.inventory.slot.feet',
  accessory: 'ui.inventory.slot.accessory',
};

const KIND_KEYS: Readonly<Record<string, string>> = {
  equipment: 'ui.inventory.kind.equipment',
  consumable: 'ui.inventory.kind.consumable',
  material: 'ui.inventory.kind.material',
  quest: 'ui.inventory.kind.quest',
  currency: 'ui.inventory.kind.currency',
};

const CONTAINER_KEYS: Readonly<Record<string, string>> = {
  inventory: 'ui.inventory.container.inventory',
  storage: 'ui.inventory.container.storage',
  equipped: 'ui.inventory.container.equipped',
};

const CURRENCY_KEYS: Readonly<Record<string, string>> = {
  gold: 'ui.common.gold',
};

function labelFrom(table: Readonly<Record<string, string>>, value: string): string {
  const key = table[value];
  return key === undefined ? labelOrHumanized(value) : t(key);
}

export const slotLabel = (slot: string): string => labelFrom(SLOT_KEYS, slot);
export const kindLabel = (kind: string): string => labelFrom(KIND_KEYS, kind);
export const containerLabel = (container: string): string => labelFrom(CONTAINER_KEYS, container);
export const currencyLabel = (currency: string): string => labelFrom(CURRENCY_KEYS, currency);

/** Best name for a holding or definition ID when the server catalog has no entry: catalog text, then humanized. */
export const fallbackName = (value: string): string => labelOrHumanized(value);

export { humanizeId };
