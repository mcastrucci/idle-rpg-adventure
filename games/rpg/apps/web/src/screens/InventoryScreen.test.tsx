import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InventoryHoldingDto, InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';
import { DEFAULT_STAT_FORMULAS, deriveStats, statDelta } from '@rpg/rpg-stats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/http.ts';
import type { ApiClient } from '../api/http.ts';
import { CommandUnconfirmedError } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto } from '../api/types.ts';
import { InventoryScreen } from './InventoryScreen.tsx';

const ACTOR = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
const ATTRIBUTES = { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 } as const;
const CHARACTER: CharacterDto = {
  actorId: ACTOR, accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 0,
  attributes: ATTRIBUTES, unspentPoints: 0, skillLoadout: [], automationRules: [],
  activityState: 'none', activityId: null, version: 3,
};
const ITEMS: InventorySnapshotDto['catalog']['items'] = [
  { id: 'item:rusty_sword', kind: 'equipment', nameKey: 'item.rusty_sword.name', slot: 'weapon', stackable: false, stats: { STR: 2, power: 3 } },
  { id: 'item:sapforged_blade', kind: 'equipment', nameKey: 'item.sapforged_blade.name', slot: 'weapon', stackable: false, stats: { STR: 4, power: 9 } },
  { id: 'item:plain_buckler', kind: 'equipment', nameKey: 'item.plain_buckler.name', slot: 'offhand', stackable: false, stats: {} },
  { id: 'item:minor_healing_potion', kind: 'consumable', nameKey: 'item.minor_healing_potion.name', stackable: true },
  { id: 'item:healing_potion', kind: 'consumable', nameKey: 'item.healing_potion.name', stackable: true },
  { id: 'item:boar_hide', kind: 'material', nameKey: 'item.boarHide', stackable: true },
];
const SWORD: InventoryHoldingDto = {
  asset: { kind: 'unique', itemId: '33333333-3333-4333-8333-333333333333' }, container: 'equipped', qty: 1,
  itemId: '33333333-3333-4333-8333-333333333333', definition: 'item:rusty_sword', slot: 'weapon',
};
const CANDIDATE: InventoryHoldingDto = {
  asset: { kind: 'unique', itemId: '44444444-4444-4444-8444-444444444444' }, container: 'inventory', qty: 1,
  itemId: '44444444-4444-4444-8444-444444444444', definition: 'item:sapforged_blade',
};
const POTION: InventoryHoldingDto = { asset: { kind: 'stack', item: 'item:minor_healing_potion' }, container: 'inventory', qty: 5, definition: 'item:minor_healing_potion' };
const BOAR_HIDE: InventoryHoldingDto = { asset: { kind: 'stack', item: 'item:boar_hide' }, container: 'inventory', qty: 12_050, definition: 'item:boar_hide' };
const STORAGE_POTION: InventoryHoldingDto = { ...POTION, container: 'storage', qty: 4 };
const GOLD: InventoryHoldingDto = { asset: { kind: 'currency', currency: 'gold' }, container: 'inventory', qty: 60 };
const UNKNOWN: InventoryHoldingDto = {
  asset: { kind: 'unique', itemId: '55555555-5555-4555-8555-555555555555' }, container: 'inventory', qty: 1,
  itemId: '55555555-5555-4555-8555-555555555555', definition: 'item:removed_legacy_blade', rolls: { legacyPower: 8 },
};
const HASH = 'a'.repeat(64);

function snapshot(actorId = ACTOR, holdings: readonly InventoryHoldingDto[] = [GOLD, SWORD, CANDIDATE, POTION, STORAGE_POTION]): InventorySnapshotDto {
  return { actorId, holdings, actorVersion: 7, activityState: 'none', level: 3, attributes: ATTRIBUTES,
    completedAreas: [], catalog: { contentHash: HASH, items: ITEMS } };
}
function withStarterKit(value: InventorySnapshotDto, claimed = false): InventorySnapshotDto {
  return { ...value, starterKit: { claimed, items: ['item:rusty_sword', 'item:padded_vest', 'item:wooden_buckler'] } };
}

const MERCHANT: MerchantCatalogDto = { merchants: [{ id: 'merchant:sanctuary', offers: [
  { id: 'offer:minor_healing_potion', item: 'item:minor_healing_potion', buyPrice: { currency: 'gold', amount: 12 }, stock: 'infinite' },
  { id: 'offer:healing_potion', item: 'item:healing_potion', buyPrice: { currency: 'gold', amount: 40 }, stock: 'infinite', requiresCompletedArea: 'area:region_1' },
] }] };
const SALE_MERCHANT: MerchantCatalogDto = { ...MERCHANT, sellOffers: [
  { item: 'item:boar_hide', unitPrice: { currency: 'gold', amount: 7 } },
  { item: 'item:minor_healing_potion', unitPrice: { currency: 'gold', amount: 3 } },
  { item: 'item:missing_material', unitPrice: { currency: 'gold', amount: 9 } },
] };

type Outcome = 'ok' | 'unknown' | Error;
interface HarnessOptions {
  initial?: InventorySnapshotDto;
  outcomes?: Outcome[];
  runCommand?: <T,>(request: CommandRequest<T>) => Promise<T>;
  inventoryRead?: (actorId: string, count: number) => Promise<InventorySnapshotDto>;
  merchant?: MerchantCatalogDto;
}

function harness(options: HarnessOptions = {}) {
  let current = options.initial ?? snapshot();
  const outcomes = [...(options.outcomes ?? [])];
  const requests: CommandRequest<unknown>[] = [];
  const readActors: string[] = [];
  const readsByActor = new Map<string, number>();
  const api = {
    request: vi.fn(async (_method: string, path: string) => {
      if (path === '/merchant') return options.merchant ?? MERCHANT;
      const actorId = decodeURIComponent(path.match(/^\/characters\/([^/]+)\/inventory$/)?.[1] ?? '');
      readActors.push(actorId);
      const count = (readsByActor.get(actorId) ?? 0) + 1;
      readsByActor.set(actorId, count);
      return options.inventoryRead ? options.inventoryRead(actorId, count) : actorId === current.actorId ? current : snapshot(actorId, []);
    }),
  } as unknown as ApiClient;
  const runCommand = options.runCommand ?? (async <T,>(request: CommandRequest<T>): Promise<T> => {
    requests.push(request as CommandRequest<unknown>);
    const outcome = outcomes.shift() ?? 'ok';
    if (outcome === 'unknown') throw new CommandUnconfirmedError(request, new Error('connection lost'));
    if (outcome instanceof Error) throw outcome;
    if (request.envelope.operation === 'inventory.claimStarterKit') {
      current = withStarterKit(current, true);
    }
    if (request.envelope.operation === 'inventory.sellMaterial') {
      const item = request.envelope.payload['item'];
      const quantity = request.envelope.payload['quantity'];
      if (typeof item === 'string' && typeof quantity === 'number') {
        const holdings = current.holdings.flatMap((holding) => holding.container === 'inventory' && holding.asset.kind === 'stack' && holding.asset.item === item
          ? holding.qty > quantity ? [{ ...holding, qty: holding.qty - quantity }] : []
          : holding.asset.kind === 'currency' && holding.container === 'inventory' && holding.asset.currency === 'gold'
            ? [{ ...holding, qty: holding.qty + quantity * 7 }] : [holding]);
        current = { ...current, holdings, actorVersion: current.actorVersion + 1 };
      }
    }
    return { actorId: current.actorId, version: current.actorVersion + 1 } as T;
  });
  const refreshCharacter = vi.fn(async () => {});
  const view = (character: CharacterDto | null = CHARACTER, canCommand = true) => render(
    <InventoryScreen character={character} canCommand={canCommand} api={api} runCommand={runCommand} refreshCharacter={refreshCharacter} />,
  );
  return { api, runCommand, requests, readActors, refreshCharacter, view, setSnapshot: (value: InventorySnapshotDto) => { current = value; } };
}

const tab = (name: 'Inventory' | 'Storage' | 'Equipment' | 'Merchant') => within(screen.getByRole('navigation', { name: 'Inventory sections' })).getByRole('button', { name });
const openItem = async (name: string) => { fireEvent.click(await screen.findByRole('button', { name: `Details for ${name}` })); return screen.getByRole('dialog'); };
beforeEach(() => {
  // happy-dom does not implement the native modal dialog methods. Preserve open/close semantics for role and focus checks.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  } });
});
afterEach(() => cleanup());

describe('InventoryScreen', () => {
  it('hides the starter kit when the server does not support the optional contract', async () => {
    const { view } = harness();
    view();
    await screen.findByRole('list', { name: 'Items' });
    expect(screen.queryByRole('heading', { name: 'Starter equipment kit' })).toBeNull();
  });

  it('claims once, shows the pending state, and displays claimed only after the authoritative refresh', async () => {
    let finish: (() => void) | undefined;
    const requests: CommandRequest<unknown>[] = [];
    const runCommand = <T,>(request: CommandRequest<T>) => {
      requests.push(request as CommandRequest<unknown>);
      return new Promise<T>((resolve) => { finish = () => resolve({ actorId: ACTOR, version: 8 } as T); });
    };
    let current = withStarterKit(snapshot(), false);
    const options: HarnessOptions = { initial: current, runCommand };
    const h = harness(options);
    const read = h.api.request as ReturnType<typeof vi.fn>;
    read.mockImplementation(async (_method: string, path: string) => {
      const actorId = decodeURIComponent(path.match(/^\/characters\/([^/]+)\/inventory$/)?.[1] ?? '');
      return actorId === current.actorId ? current : snapshot(actorId, []);
    });
    h.view();
    const claim = await screen.findByRole('button', { name: 'Claim starter kit' });
    expect(screen.getByText('Rusty Sword · Padded Vest · Wooden Buckler')).toBeDefined();
    fireEvent.click(claim);
    fireEvent.click(claim);
    expect(await screen.findByText('Claiming starter kit…')).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.claimStarterKit', payload: { actorId: ACTOR } });
    expect(screen.getByRole('button', { name: 'Claiming…' })).toBeDefined();
    current = withStarterKit(current, true);
    await act(async () => { finish?.(); });
    expect(await screen.findByText('Starter kit claimed. Equip items from your inventory when you are ready.')).toBeDefined();
  });

  it('retries an unconfirmed starter kit claim with the same command id and preserves server claimed state', async () => {
    const { view, requests } = harness({ initial: withStarterKit(snapshot(), false), outcomes: ['unknown', 'ok'] });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim starter kit' }));
    const retry = await screen.findByRole('button', { name: 'Retry exact request' });
    expect(screen.getByText(/result is unknown/i)).toBeDefined();
    fireEvent.click(retry);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.envelope.command_id).toBe(requests[1]?.envelope.command_id);
    expect(await screen.findByText('Starter kit claimed. Equip items from your inventory when you are ready.')).toBeDefined();
  });

  it('disables starter kit claims while the character is in a live activity', async () => {
    const { view } = harness({ initial: withStarterKit({ ...snapshot(), activityState: 'live' }) });
    view();
    expect(await screen.findByRole('button', { name: 'Claim starter kit' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Return to Sanctuary and become idle to claim your kit.')).toBeDefined();
  });

  it('does not show starter kit claiming while a different inventory command is pending', async () => {
    let finish: (() => void) | undefined;
    const { view } = harness({ initial: withStarterKit(snapshot()), runCommand: async <T,>() => new Promise<T>((resolve) => {
      finish = () => resolve({ actorId: ACTOR, version: 8 } as T);
    }) });
    view();
    const dialog = await openItem('Sapforged Blade');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }));
    expect(await screen.findByRole('button', { name: 'Claim starter kit' })).toBeDefined();
    expect(screen.queryByText('Claiming starter kit…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claiming…' })).toBeNull();
    await act(async () => { finish?.(); });
  });

  it('waits for a successful authoritative refresh before showing claimed after a read failure', async () => {
    let current = withStarterKit(snapshot(), false);
    const { view } = harness({ initial: current, inventoryRead: async (actorId, count) => {
      if (count === 2) throw new Error('temporary read error');
      return actorId === current.actorId ? current : snapshot(actorId, []);
    } });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim starter kit' }));
    await screen.findByRole('button', { name: 'Refresh state' });
    expect(screen.queryByText('Starter kit claimed. Equip items from your inventory when you are ready.')).toBeNull();
    current = withStarterKit(current, true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh state' }));
    expect(await screen.findByText('Starter kit claimed. Equip items from your inventory when you are ready.')).toBeDefined();
  });

  it('allows a fresh claim attempt after a terminal rejection', async () => {
    const { view, requests } = harness({ initial: withStarterKit(snapshot()), outcomes: [new ApiError(409, 'starter_kit_unavailable'), 'ok'] });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim starter kit' }));
    await screen.findByText(/starter_kit_unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Claim starter kit' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.envelope.command_id).not.toBe(requests[1]?.envelope.command_id);
    expect(await screen.findByText('Starter kit claimed. Equip items from your inventory when you are ready.')).toBeDefined();
  });

  it('filters server holdings by search and kind, and coalesces same stack rows into the displayed count', async () => {
    const duplicatePotion = { ...POTION, qty: 2 };
    const { view } = harness({ initial: snapshot(ACTOR, [GOLD, POTION, duplicatePotion, { ...POTION, asset: { kind: 'stack', item: 'item:boar_hide' }, definition: 'item:boar_hide', qty: 3 }]) });
    view();
    expect(await screen.findByRole('list', { name: 'Items' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Details for Minor Healing Potion' }).textContent).toContain('×7');
    expect(screen.getByRole('button', { name: 'Details for Boar Hide' })).toBeDefined();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), { target: { value: 'boar' } });
    expect(screen.getByRole('button', { name: 'Details for Boar Hide' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Details for Minor Healing Potion' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by item kind' }), { target: { value: 'consumable' } });
    expect(screen.getByRole('button', { name: 'Details for Minor Healing Potion' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Details for Boar Hide' })).toBeNull();
  });

  it('opens an accessible detail dialog, returns focus after Escape, and shows comparison against the replaced slot', async () => {
    const { view } = harness();
    view();
    const opener = await screen.findByRole('button', { name: 'Details for Sapforged Blade' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Sapforged Blade' });
    expect(within(dialog).getByRole('heading', { name: 'Sapforged Blade' })).toBeDefined();
    expect(within(dialog).getByRole('region', { name: 'Comparison with equipped gear' })).toBeDefined();
    const oldStats = ITEMS[0]?.stats;
    const newStats = ITEMS[1]?.stats;
    if (!oldStats || !newStats) throw new Error('test equipment stats are missing');
    const before = deriveStats({ level: 3, attributes: ATTRIBUTES, equipment: [{ stats: oldStats }] }, DEFAULT_STAT_FORMULAS);
    const after = deriveStats({ level: 3, attributes: ATTRIBUTES, equipment: [{ stats: newStats }] }, DEFAULT_STAT_FORMULAS);
    const expected = statDelta(before, after);
    expect(expected.STR).toBe(2);
    expect(expected.power).toBe(9);
    expect(within(dialog).getByText('+2', { selector: 'strong' })).toBeDefined();
    const comparison = within(dialog).getByRole('region', { name: 'Comparison with equipped gear' });
    expect(within(comparison).getByText('Power').parentElement?.textContent).toContain('+9');
    expect(within(comparison).getByText('Physical power').parentElement?.textContent).toContain('+9');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('equips the selected unique item and submits the exact shared command envelope', async () => {
    const { view, requests } = harness();
    view();
    const dialog = await openItem('Sapforged Blade');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe(`/characters/${ACTOR}/inventory/commands`);
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.equip', payload: { actorId: ACTOR, itemId: CANDIDATE.itemId, slot: 'weapon' } });
  });

  it('unequips an equipped unique item with its instance id and never a catalog id', async () => {
    const { view, requests } = harness();
    view();
    fireEvent.click(tab('Equipment'));
    fireEvent.click(await screen.findByRole('button', { name: /Weapon.*Rusty Sword/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Rusty Sword' })).getByRole('button', { name: 'Unequip Rusty Sword' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.unequip', payload: { actorId: ACTOR, itemId: SWORD.itemId } });
  });

  it('shows the stat loss from unequipping current gear and preserves a known empty stats object', async () => {
    const buckler: InventoryHoldingDto = { ...CANDIDATE, definition: 'item:plain_buckler' };
    const { view } = harness({ initial: snapshot(ACTOR, [SWORD, buckler]) });
    view();
    fireEvent.click(tab('Equipment'));
    fireEvent.click(await screen.findByRole('button', { name: /Weapon.*Rusty Sword/ }));
    const dialog = screen.getByRole('dialog', { name: 'Rusty Sword' });
    expect(within(dialog).getByRole('region', { name: 'Comparison with equipped gear' })).toBeDefined();
    expect(within(dialog).getByText('-2', { selector: 'strong' })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Rusty Sword details' }));
    fireEvent.click(tab('Inventory'));
    fireEvent.click(screen.getByRole('button', { name: 'Details for Plain Buckler' }));
    expect(within(screen.getByRole('dialog', { name: 'Plain Buckler' })).getByText('No stat changes.')).toBeDefined();
  });

  it('moves a unique item by instance id into storage', async () => {
    const { view, requests } = harness();
    view();
    const dialog = await openItem('Sapforged Blade');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to storage' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.move', payload: {
      actorId: ACTOR, itemId: CANDIDATE.itemId, from: 'inventory', to: 'storage',
    } });
  });

  it('treats a documented empty rolls object as comparison safe', async () => {
    const candidate = { ...CANDIDATE, rolls: {} };
    const { view } = harness({ initial: snapshot(ACTOR, [SWORD, candidate]) });
    view();
    const dialog = await openItem('Sapforged Blade');
    expect(within(dialog).getByRole('region', { name: 'Comparison with equipped gear' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' })).toBeDefined();
  });

  it.each([false, null, 0])('does not interpret non-object rolls as empty (%s)', async (rolls) => {
    const candidate = { ...CANDIDATE, rolls };
    const { view } = harness({ initial: snapshot(ACTOR, [SWORD, candidate]) });
    view();
    const dialog = await openItem('Sapforged Blade');
    expect(within(dialog).getByText(/saved rolls the client cannot interpret/)).toBeDefined();
    expect(within(dialog).queryByRole('region', { name: 'Comparison with equipped gear' })).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not interpret nonempty instance rolls and prevents equipping them', async () => {
    const candidate = { ...CANDIDATE, rolls: { bonusPower: 4 } };
    const { view } = harness({ initial: snapshot(ACTOR, [candidate]) });
    view();
    const dialog = await openItem('Sapforged Blade');
    expect(within(dialog).getByText(/saved rolls the client cannot interpret/)).toBeDefined();
    expect(within(dialog).queryByRole('region', { name: 'Comparison with equipped gear' })).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables equip when the item level requirement exceeds the server level', async () => {
    const highLevelCatalog = ITEMS.map((item) => item.id === 'item:sapforged_blade' ? { ...item, levelRequired: 5 } : item);
    const { view } = harness({ initial: { ...snapshot(), catalog: { contentHash: HASH, items: highLevelCatalog } } });
    view();
    const dialog = await openItem('Sapforged Blade');
    expect(within(dialog).getByText(/Required level: 5/)).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves the requested stack quantity from the selected source container to the other container', async () => {
    const { view, requests } = harness();
    view();
    fireEvent.click(tab('Storage'));
    const dialog = await openItem('Minor Healing Potion');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Quantity to move' }), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to inventory' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.move', payload: { actorId: ACTOR, item: 'item:minor_healing_potion', quantity: 3, from: 'storage', to: 'inventory' } });
  });

  it('shows catalog prices, gates locked offers, and submits quantity only when funds cover the exact total', async () => {
    const { view, requests } = harness({ initial: snapshot(ACTOR, [GOLD]) });
    view();
    fireEvent.click(tab('Merchant'));
    const buy = await screen.findByRole('button', { name: 'Buy Minor Healing Potion' });
    expect(screen.getByText('12 Gold')).toBeDefined();
    expect(screen.getByText('40 Gold')).toBeDefined();
    const gated = screen.getByRole('button', { name: 'Buy Healing Potion' }) as HTMLButtonElement;
    expect(gated.disabled).toBe(true);
    const qty = screen.getByRole('spinbutton', { name: 'Quantity for Minor Healing Potion' });
    fireEvent.change(qty, { target: { value: '6' } });
    expect((screen.getByRole('button', { name: 'Buy Minor Healing Potion' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(qty, { target: { value: '2' } });
    fireEvent.click(buy);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.buy', payload: { actorId: ACTOR, offerId: 'offer:minor_healing_potion', quantity: 2 } });
  });

  it('lists only cataloged owned inventory material stacks, prices the exact quantity, and refreshes committed gold and stock', async () => {
    const hiddenMissing: InventoryHoldingDto = { asset: { kind: 'stack', item: 'item:missing_material' }, container: 'inventory', qty: 4, definition: 'item:missing_material' };
    const hiddenStorage: InventoryHoldingDto = { ...BOAR_HIDE, container: 'storage', qty: 8 };
    const hiddenUnique: InventoryHoldingDto = { asset: { kind: 'unique', itemId: '11111111-1111-4111-8111-111111111111' }, container: 'inventory', qty: 1, definition: 'item:boar_hide' };
    const { view, requests } = harness({ initial: snapshot(ACTOR, [GOLD, BOAR_HIDE, hiddenStorage, hiddenMissing, hiddenUnique, POTION]), merchant: SALE_MERCHANT });
    view();
    fireEvent.click(tab('Merchant'));
    await screen.findByRole('heading', { name: 'Sell materials' });
    expect(screen.getByText('Owned: 12050')).toBeDefined();
    expect(screen.getByText('7 gold each')).toBeDefined();
    expect(screen.queryByText('Missing Material')).toBeNull();
    expect(screen.queryByText('Minor Healing Potion')).toBeDefined(); // The buy listing remains intact.
    const saleQty = screen.getByRole('spinbutton', { name: 'Quantity to sell for Boar Hide' }) as HTMLInputElement;
    expect(saleQty.max).toBe('10000');
    fireEvent.change(saleQty, { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Sell 2 Boar Hide for 14 gold' })).toBeDefined();
    const buyQty = screen.getByRole('spinbutton', { name: 'Quantity for Minor Healing Potion' }) as HTMLInputElement;
    expect(buyQty.value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Sell 2 Boar Hide for 14 gold' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.envelope).toMatchObject({ operation: 'inventory.sellMaterial', payload: { actorId: ACTOR, item: 'item:boar_hide', quantity: 2 } });
    await waitFor(() => expect(screen.getByText('Owned: 12048')).toBeDefined());
    expect(screen.getByRole('spinbutton', { name: 'Quantity to sell for Boar Hide' }).getAttribute('max')).toBe('10000');
    expect(screen.getByLabelText('Current gold').textContent).toContain('74');
  });

  it('bounds the sale quantity by available stock and hides sales when the server omits sell offers', async () => {
    const tinyStack = { ...BOAR_HIDE, qty: 3 };
    const supported = harness({ initial: snapshot(ACTOR, [tinyStack]), merchant: SALE_MERCHANT });
    supported.view();
    fireEvent.click(tab('Merchant'));
    const quantity = await screen.findByRole('spinbutton', { name: 'Quantity to sell for Boar Hide' }) as HTMLInputElement;
    expect(quantity.max).toBe('3');
    cleanup();
    const unsupported = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: MERCHANT });
    unsupported.view();
    fireEvent.click(tab('Merchant'));
    await screen.findByRole('button', { name: 'Buy Minor Healing Potion' });
    expect(screen.queryByRole('heading', { name: 'Sell materials' })).toBeNull();
  });

  it('caps quantity so the total fits a database integer and requires a stackable catalog material', async () => {
    const nonStackable: InventorySnapshotDto['catalog']['items'][number] = { id: 'item:nonstackable_material', kind: 'material', stackable: false };
    const nonStackableHolding: InventoryHoldingDto = { asset: { kind: 'stack', item: nonStackable.id }, container: 'inventory', qty: 4, definition: nonStackable.id };
    const value = { ...snapshot(ACTOR, [BOAR_HIDE, nonStackableHolding]), catalog: { contentHash: HASH, items: [...ITEMS, nonStackable] } };
    const merchant: MerchantCatalogDto = { ...MERCHANT, sellOffers: [
      { item: 'item:boar_hide', unitPrice: { currency: 'gold', amount: 2_147_483_647 } },
      { item: nonStackable.id, unitPrice: { currency: 'gold', amount: 1 } },
    ] };
    const { view } = harness({ initial: value, merchant });
    view();
    fireEvent.click(tab('Merchant'));
    const saleQuantity = await screen.findByRole('spinbutton', { name: 'Quantity to sell for Boar Hide' }) as HTMLInputElement;
    expect(saleQuantity.max).toBe('1');
    expect(screen.queryByText('Nonstackable Material')).toBeNull();
  });

  it('keeps empty and over-limit sale quantities invalid instead of silently changing them', async () => {
    const { view } = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: SALE_MERCHANT });
    view();
    fireEvent.click(tab('Merchant'));
    const input = await screen.findByRole('spinbutton', { name: 'Quantity to sell for Boar Hide' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect((screen.getByRole('button', { name: 'Sell Boar Hide' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '10001' } });
    expect(input.value).toBe('10001');
    expect((screen.getByRole('button', { name: 'Sell Boar Hide' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables sales while disconnected or active and retries an unknown sale with the same command id', async () => {
    const disconnected = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: SALE_MERCHANT });
    disconnected.view(CHARACTER, false);
    fireEvent.click(tab('Merchant'));
    expect((await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const active = harness({ initial: { ...snapshot(ACTOR, [BOAR_HIDE]), activityState: 'live' }, merchant: SALE_MERCHANT });
    active.view();
    fireEvent.click(tab('Merchant'));
    expect((await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const retryable = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: SALE_MERCHANT, outcomes: ['unknown', 'ok'] });
    retryable.view();
    fireEvent.click(tab('Merchant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }));
    expect(await screen.findByText(/result is unknown/i)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact request' }));
    await waitFor(() => expect(retryable.requests).toHaveLength(2));
    expect(retryable.requests[0]?.envelope.command_id).toBe(retryable.requests[1]?.envelope.command_id);
    expect(retryable.requests[0]?.envelope).toEqual(retryable.requests[1]?.envelope);
  });

  it('explains a rejected sale and a committed sale whose authoritative refresh fails', async () => {
    const rejected = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: SALE_MERCHANT, outcomes: [new ApiError(400, 'invalid_material')] });
    rejected.view();
    fireEvent.click(tab('Merchant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }));
    expect(await screen.findByText(/server rejected this material sale \(invalid_material\)/i)).toBeDefined();
    expect(rejected.requests).toHaveLength(1);
    cleanup();
    const refreshFailure = harness({ initial: snapshot(ACTOR, [GOLD, BOAR_HIDE]), merchant: SALE_MERCHANT, inventoryRead: async (actorId, count) => {
      if (count > 1) throw new Error('offline');
      return snapshot(actorId, [GOLD, BOAR_HIDE]);
    } });
    refreshFailure.view();
    fireEvent.click(tab('Merchant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }));
    expect(await screen.findByRole('button', { name: 'Refresh state' })).toBeDefined();
    expect(screen.getByText(/change was saved, but the latest state could not be loaded/i)).toBeDefined();
    expect(refreshFailure.requests).toHaveLength(1);
  });

  it('uses material-specific copy and refreshes when the server rejects a stale sale quantity', async () => {
    const { view, requests, readActors } = harness({ initial: snapshot(ACTOR, [BOAR_HIDE]), merchant: SALE_MERCHANT, outcomes: [new ApiError(400, 'insufficient_funds')] });
    view();
    fireEvent.click(tab('Merchant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sell 1 Boar Hide for 7 gold' }));
    expect(await screen.findByText(/requested material quantity is no longer available/i)).toBeDefined();
    await waitFor(() => expect(readActors.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/not enough gold for this purchase/i)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('keeps empty actors empty and does not fabricate starter holdings', async () => {
    const { view, requests } = harness({ initial: snapshot(ACTOR, []) });
    view();
    expect(await screen.findByText('Inventory is empty.')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Items' })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('shows opaque rolls and unknown legacy definitions honestly without enabling an unsafe equip', async () => {
    const { view } = harness({ initial: snapshot(ACTOR, [UNKNOWN]) });
    view();
    const dialog = await openItem('Removed Legacy Blade');
    expect(within(dialog).getByRole('status').textContent).toContain('definition is not in the current catalog');
    expect(within(dialog).getByText('Saved item properties')).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /Equip/ })).toBeNull();
  });

  it('uses read-only mode while disconnected or active, keeping all mutations disabled', async () => {
    const disconnected = harness();
    disconnected.view(CHARACTER, false);
    const details = await openItem('Sapforged Blade');
    expect((within(details).getByRole('button', { name: 'Equip Sapforged Blade' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Disconnected\. You can review your holdings/)).toBeDefined();
    cleanup();
    const activeSnapshot = { ...snapshot(), activityState: 'expedition' as const };
    const active = harness({ initial: activeSnapshot });
    active.view();
    const activeDialog = await openItem('Sapforged Blade');
    expect((within(activeDialog).getByRole('button', { name: 'Equip Sapforged Blade' }) as HTMLButtonElement).disabled).toBe(true);
    expect(active.requests).toHaveLength(0);
  });

  it('keeps the exact request and blocks another action until an unknown command outcome is retried', async () => {
    const { view, requests } = harness({ outcomes: ['unknown', 'ok'] });
    view();
    let dialog = await openItem('Sapforged Blade');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }));
    expect(await screen.findByText(/The result is unknown/)).toBeDefined();
    expect(requests).toHaveLength(1);
    fireEvent.click(tab('Inventory'));
    dialog = await openItem('Minor Healing Potion');
    expect((within(dialog).getByRole('button', { name: 'Move to storage' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact request' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.envelope).toEqual(requests[0]?.envelope);
  });

  it('serializes a rapid double click to one command', async () => {
    let release: (() => void) | undefined;
    const runCommandMock = vi.fn(async <T,>(request: CommandRequest<T>): Promise<T> => {
      void request;
      return new Promise<T>((resolve) => {
      release = () => resolve({ actorId: ACTOR, version: 8 } as T);
      });
    });
    const { view } = harness({ runCommand: runCommandMock as NonNullable<HarnessOptions['runCommand']> });
    view();
    const dialog = await openItem('Sapforged Blade');
    const equip = within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' });
    fireEvent.click(equip);
    fireEvent.click(equip);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    await act(async () => { release?.(); });
  });

  it('offers a state refresh after a committed command when the follow-up inventory read fails, without rebuying', async () => {
    let failRefresh = false;
    const { view, requests, api } = harness({ initial: snapshot(ACTOR, [GOLD]), inventoryRead: async (actorId, count) => {
      if (failRefresh && count > 1) throw new Error('offline');
      return snapshot(actorId, [GOLD]);
    } });
    view();
    fireEvent.click(tab('Merchant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Buy Minor Healing Potion' }));
    failRefresh = true;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh state' })).toBeDefined());
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh state' }));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(4));
    expect(requests).toHaveLength(1);
  });

  it('refreshes after a server conflict and preserves the current server snapshot', async () => {
    const fresh = snapshot(ACTOR, [GOLD, POTION]);
    const { view, requests, readActors } = harness({ outcomes: [new ApiError(409, 'stale_version')], inventoryRead: async (actorId, count) => count === 1 ? snapshot(actorId) : fresh });
    view();
    const dialog = await openItem('Sapforged Blade');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Equip Sapforged Blade' }));
    expect(await screen.findByText(/inventory changed on the server/)).toBeDefined();
    await waitFor(() => expect(readActors.length).toBeGreaterThanOrEqual(2));
    expect(requests).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Details for Minor Healing Potion' })).toBeDefined();
  });

  it('ignores an older inventory response when the selected actor changes', async () => {
    let resolveOld: ((value: InventorySnapshotDto) => void) | undefined;
    const { view, api, runCommand, readActors } = harness({ inventoryRead: async (actorId) => actorId === ACTOR
      ? new Promise<InventorySnapshotDto>((resolve) => { resolveOld = resolve; })
      : snapshot(actorId, [GOLD, { ...POTION, definition: 'item:boar_hide', asset: { kind: 'stack', item: 'item:boar_hide' } }]) });
    const mounted = view();
    await waitFor(() => expect(readActors).toContain(ACTOR));
    mounted.rerender(<InventoryScreen character={{ ...CHARACTER, actorId: OTHER_ACTOR }} canCommand api={api}
      runCommand={runCommand} refreshCharacter={async () => {}} />);
    expect(await screen.findByRole('button', { name: 'Details for Boar Hide' })).toBeDefined();
    await act(async () => { resolveOld?.(snapshot(ACTOR, [CANDIDATE])); });
    expect(screen.queryByRole('button', { name: 'Details for Sapforged Blade' })).toBeNull();
  });
});
