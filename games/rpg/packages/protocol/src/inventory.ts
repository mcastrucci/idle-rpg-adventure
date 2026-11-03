/** Safe, versioned inventory projection shared by the RPG server and browser. */
export type InventoryActivityState = 'none' | 'live' | 'expedition';
export type InventorySlot = 'weapon' | 'offhand' | 'head' | 'chest' | 'legs' | 'hands' | 'feet' | 'accessory';
export type InventoryItemKind = 'equipment' | 'consumable' | 'material' | 'quest';
export type InventoryStat = 'STR' | 'AGI' | 'INT' | 'VIT' | 'SPI' | 'maxHp' | 'power' | 'armor' | 'resist' | 'critBp' | 'haste' | 'healPower';
export type InventoryAttributes = Readonly<Record<'STR' | 'AGI' | 'INT' | 'VIT' | 'SPI', number>>;

export interface InventoryItemDto {
  readonly id: string;
  readonly kind: InventoryItemKind;
  readonly nameKey?: string;
  readonly slot?: InventorySlot;
  readonly levelRequired?: number;
  readonly stats?: Readonly<Partial<Record<InventoryStat, number>>>;
  readonly stackable: boolean;
}

export type InventoryAssetDto =
  | { readonly kind: 'currency'; readonly currency: string }
  | { readonly kind: 'stack'; readonly item: string }
  | { readonly kind: 'unique'; readonly itemId: string };

export interface InventoryHoldingDto {
  readonly asset: InventoryAssetDto;
  readonly container: string;
  readonly qty: number;
  readonly itemId?: string;
  readonly definition?: string;
  readonly slot?: string | null;
  /** Opaque instance data. The browser must not infer authored stat meanings from rolls. */
  readonly rolls?: unknown;
}

export interface InventorySnapshotDto {
  readonly actorId: string;
  readonly holdings: readonly InventoryHoldingDto[];
  readonly actorVersion: number;
  readonly activityState: InventoryActivityState;
  readonly level: number;
  readonly attributes: InventoryAttributes;
  readonly completedAreas: readonly string[];
  readonly catalog: { readonly contentHash: string; readonly items: readonly InventoryItemDto[] };
  readonly starterKit?: { readonly claimed: boolean; readonly items: readonly string[] };
}

export interface MerchantOfferDto {
  readonly id: string;
  readonly item: string;
  readonly buyPrice: { readonly currency: 'gold'; readonly amount: number };
  readonly stock: 'infinite';
  readonly requiresCompletedArea?: string;
}
export interface MerchantCatalogDto {
  readonly merchants: readonly { readonly id: string; readonly offers: readonly MerchantOfferDto[] }[];
}

const slots: readonly string[] = ['weapon', 'offhand', 'head', 'chest', 'legs', 'hands', 'feet', 'accessory'];
const kinds: readonly string[] = ['equipment', 'consumable', 'material', 'quest'];
const stats: readonly string[] = ['STR', 'AGI', 'INT', 'VIT', 'SPI', 'maxHp', 'power', 'armor', 'resist', 'critBp', 'haste', 'healPower'];
const attrs: readonly string[] = ['STR', 'AGI', 'INT', 'VIT', 'SPI'];
const activityStates: readonly string[] = ['none', 'live', 'expedition'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cloneJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new TypeError('inventory roll data is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => cloneJson(item, depth + 1)));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('invalid inventory roll data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !('value' in (descriptors[key] ?? {})))) throw new TypeError('invalid inventory roll data');
  return Object.freeze(Object.fromEntries(keys.map(key => [key as string, cloneJson(descriptors[key as string]?.value, depth + 1)])));
}

function object(input: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('invalid inventory DTO object');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in (descriptors[key] ?? {}))) || required.some(key => !keys.includes(key))) throw new TypeError('invalid inventory DTO fields');
  return input as Record<string, unknown>;
}
const safeInt = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function parseInventorySnapshotDto(input: unknown): InventorySnapshotDto {
  const root = object(input, ['actorId', 'holdings', 'actorVersion', 'activityState', 'level', 'attributes', 'completedAreas', 'catalog', 'starterKit'],
    ['actorId', 'holdings', 'actorVersion', 'activityState', 'level', 'attributes', 'completedAreas', 'catalog']);
  if (typeof root['actorId'] !== 'string' || !uuid.test(root['actorId']) || !Array.isArray(root['holdings']) || !safeInt(root['actorVersion']) || !activityStates.includes(String(root['activityState'])) ||
      !safeInt(root['level'], 1) || !Array.isArray(root['completedAreas']) || !root['completedAreas'].every(str)) throw new TypeError('invalid inventory snapshot');
  const attributes = object(root['attributes'], attrs, attrs);
  if (attrs.some(key => !safeInt(attributes[key]))) throw new TypeError('invalid inventory attributes');
  const catalog = object(root['catalog'], ['contentHash', 'items'], ['contentHash', 'items']);
  if (typeof catalog['contentHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(catalog['contentHash']) || !Array.isArray(catalog['items'])) throw new TypeError('invalid inventory catalog');
  const items = catalog['items'].map(raw => {
    const item = object(raw, ['id', 'kind', 'nameKey', 'slot', 'levelRequired', 'stats', 'stackable'], ['id', 'kind', 'stackable']);
    if (!str(item['id']) || !kinds.includes(String(item['kind'])) || typeof item['stackable'] !== 'boolean' ||
        (item['nameKey'] !== undefined && !str(item['nameKey'])) ||
        (item['slot'] !== undefined && !slots.includes(String(item['slot']))) ||
        (item['levelRequired'] !== undefined && !safeInt(item['levelRequired'], 1))) throw new TypeError('invalid inventory item');
    if (item['kind'] === 'equipment' && (item['slot'] === undefined || item['stackable'] !== false)) throw new TypeError('invalid equipment item');
    if (item['kind'] !== 'equipment' && (item['slot'] !== undefined || item['levelRequired'] !== undefined || item['stats'] !== undefined)) {
      throw new TypeError('invalid non-equipment fields');
    }
    let parsedStats: InventoryItemDto['stats'];
    if (item['stats'] !== undefined) {
      const values = object(item['stats'], stats);
      if (Object.values(values).some(value => !Number.isSafeInteger(value))) throw new TypeError('invalid item stats');
      parsedStats = Object.freeze({ ...values }) as InventoryItemDto['stats'];
    }
    return Object.freeze({ id: item['id'], kind: item['kind'] as InventoryItemKind,
      ...(item['nameKey'] === undefined ? {} : { nameKey: item['nameKey'] as string }),
      ...(item['slot'] === undefined ? {} : { slot: item['slot'] as InventorySlot }),
      ...(item['levelRequired'] === undefined ? {} : { levelRequired: item['levelRequired'] as number }),
      ...(parsedStats === undefined ? {} : { stats: parsedStats }), stackable: item['stackable'] });
  });
  const holdings = root['holdings'].map(raw => {
    const holding = object(raw, ['asset', 'container', 'qty', 'itemId', 'definition', 'slot', 'rolls'], ['asset', 'container', 'qty']);
    if (!str(holding['container']) || !safeInt(holding['qty'], 1) ||
        (holding['itemId'] !== undefined && (typeof holding['itemId'] !== 'string' || !uuid.test(holding['itemId']))) || (holding['definition'] !== undefined && !str(holding['definition'])) ||
        (holding['slot'] !== undefined && holding['slot'] !== null && !str(holding['slot']))) throw new TypeError('invalid inventory holding');
    const asset = object(holding['asset'], ['kind', 'currency', 'item', 'itemId'], ['kind']);
    let parsedAsset: InventoryAssetDto;
    if (asset['kind'] === 'currency' && str(asset['currency']) && Object.keys(asset).length === 2) parsedAsset = { kind: 'currency', currency: asset['currency'] };
    else if (asset['kind'] === 'stack' && str(asset['item']) && Object.keys(asset).length === 2) parsedAsset = { kind: 'stack', item: asset['item'] };
    else if (asset['kind'] === 'unique' && typeof asset['itemId'] === 'string' && uuid.test(asset['itemId']) && Object.keys(asset).length === 2) parsedAsset = { kind: 'unique', itemId: asset['itemId'].toLowerCase() };
    else throw new TypeError('invalid inventory asset');
    if (parsedAsset.kind === 'unique' && (holding['qty'] !== 1 || (holding['itemId'] !== undefined && (holding['itemId'] as string).toLowerCase() !== parsedAsset.itemId))) {
      throw new TypeError('unique holding identity mismatch');
    }
    return Object.freeze({ asset: Object.freeze(parsedAsset), container: holding['container'], qty: holding['qty'] as number,
      ...(holding['itemId'] === undefined ? {} : { itemId: (holding['itemId'] as string).toLowerCase() }),
      ...(holding['definition'] === undefined ? {} : { definition: holding['definition'] as string }),
      ...(holding['slot'] === undefined ? {} : { slot: holding['slot'] as string | null }),
      ...(holding['rolls'] === undefined ? {} : { rolls: cloneJson(holding['rolls']) }) });
  });
  let starterKit: InventorySnapshotDto['starterKit'];
  if (root['starterKit'] !== undefined) {
    const kit = object(root['starterKit'], ['claimed', 'items'], ['claimed', 'items']);
    if (typeof kit['claimed'] !== 'boolean' || !Array.isArray(kit['items']) || !kit['items'].every(str)) throw new TypeError('invalid starter kit state');
    starterKit = Object.freeze({ claimed: kit['claimed'], items: Object.freeze([...(kit['items'] as string[])]) });
  }
  return Object.freeze({ actorId: (root['actorId'] as string).toLowerCase(), holdings: Object.freeze(holdings), actorVersion: root['actorVersion'] as number,
    activityState: root['activityState'] as InventoryActivityState, level: root['level'] as number,
    attributes: Object.freeze({ ...attributes }) as InventoryAttributes, completedAreas: Object.freeze([...(root['completedAreas'] as string[])]),
    catalog: Object.freeze({ contentHash: catalog['contentHash'], items: Object.freeze(items) }),
    ...(starterKit === undefined ? {} : { starterKit }) });
}

export function parseMerchantCatalogDto(input: unknown): MerchantCatalogDto {
  const root = object(input, ['merchants'], ['merchants']);
  if (!Array.isArray(root['merchants'])) throw new TypeError('invalid merchant catalog');
  const merchants = root['merchants'].map(raw => {
    const merchant = object(raw, ['id', 'offers'], ['id', 'offers']);
    if (!str(merchant['id']) || !Array.isArray(merchant['offers'])) throw new TypeError('invalid merchant');
    const offers = merchant['offers'].map(row => {
      const offer = object(row, ['id', 'item', 'buyPrice', 'stock', 'requiresCompletedArea'], ['id', 'item', 'buyPrice', 'stock']);
      const price = object(offer['buyPrice'], ['currency', 'amount'], ['currency', 'amount']);
      if (!str(offer['id']) || !str(offer['item']) || price['currency'] !== 'gold' || !safeInt(price['amount'], 1) || (price['amount'] as number) > 2_147_483_647 || offer['stock'] !== 'infinite' ||
          (offer['requiresCompletedArea'] !== undefined && !str(offer['requiresCompletedArea']))) throw new TypeError('invalid merchant offer');
      return Object.freeze({ id: offer['id'], item: offer['item'], buyPrice: Object.freeze({ currency: 'gold' as const, amount: price['amount'] as number }), stock: 'infinite' as const,
        ...(offer['requiresCompletedArea'] === undefined ? {} : { requiresCompletedArea: offer['requiresCompletedArea'] as string }) });
    });
    return Object.freeze({ id: merchant['id'], offers: Object.freeze(offers) });
  });
  return Object.freeze({ merchants: Object.freeze(merchants) });
}
