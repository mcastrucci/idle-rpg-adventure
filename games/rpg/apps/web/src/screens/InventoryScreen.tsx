import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryHoldingDto, InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';

import type { ApiClient } from '../api/http.ts';
import { ApiError } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { CommandRequest } from '../api/commands.ts';
import { CommandRejectedError, CommandUnconfirmedError } from '../api/commands.ts';
import { buyInventoryCommand, claimStarterKitCommand, equipInventoryCommand, moveInventoryCommand, sellMaterialCommand, unequipInventoryCommand } from '../inventory/api.ts';
import { useInventoryState } from './inventory/useInventoryState.ts';
import { InventoryDetail } from './inventory/InventoryDetail.tsx';
import { InventoryItemGrid } from './inventory/InventoryItemGrid.tsx';
import { RunBagPanel } from './inventory/RunBagPanel.tsx';
import { SellMaterialsPanel } from './inventory/SellMaterialsPanel.tsx';
import { clearInventoryCommand, pendingInventoryCommand, rememberInventoryCommand } from './inventory/pendingInventoryCommand.ts';
import './inventory/inventory.css';

export type InventoryTab = 'inventory' | 'storage' | 'equipment' | 'merchant';

interface Props {
  readonly character: CharacterDto | null;
  readonly canCommand: boolean;
  readonly api: ApiClient;
  readonly runCommand: <T,>(request: CommandRequest<T>) => Promise<T>;
  readonly refreshCharacter: () => Promise<void>;
}

const TABS: readonly { id: InventoryTab; label: string }[] = [
  { id: 'inventory', label: 'Inventory' }, { id: 'storage', label: 'Storage' },
  { id: 'equipment', label: 'Equipment' }, { id: 'merchant', label: 'Merchant' },
];

export function InventoryScreen({ character, canCommand, api, runCommand, refreshCharacter }: Props) {
  const actorId = character?.actorId ?? null;
  const [tab, setTab] = useState<InventoryTab>('inventory');
  const [snapshot, setSnapshot] = useState<InventorySnapshotDto | null>(null);
  const [merchant, setMerchant] = useState<MerchantCatalogDto | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [merchantError, setMerchantError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<InventoryHoldingDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(() => pendingInventoryCommand(actorId) ? 'A previous change is still awaiting confirmation. Retry the exact request before making another change.' : null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<CommandRequest<unknown> | null>(() => pendingInventoryCommand(actorId));
  const [quantity, setQuantity] = useState(1);
  const actionLock = useRef(false);
  const activeActor = useRef(actorId);
  activeActor.current = actorId;
  const { inventoryLoading, merchantLoading, reloadInventory, reloadMerchant } = useInventoryState({
    actorId, tab, api, setSnapshot, setMerchant, setReadError, setMerchantError,
  });

  useEffect(() => {
    const pendingRequest = pendingInventoryCommand(actorId);
    setSelected(null); setSearch(''); setKind('all'); setUnconfirmed(pendingRequest);
    setActionError(pendingRequest ? 'A previous change is still awaiting confirmation. Retry the exact request before making another change.' : null);
    setRefreshError(null);
  }, [actorId]);
  useEffect(() => { if (selected) setQuantity(1); }, [selected]);

  const currentHoldings = snapshot?.holdings.filter((holding) => holding.container === tabContainer(tab)) ?? [];
  const filteredHoldings = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return currentHoldings.filter((holding) => {
      const item = definitionFor(snapshot, holding);
      const matchesKind = kind === 'all' || item?.kind === kind || (kind === 'currency' && holding.asset.kind === 'currency');
      const matchesText = !query || `${displayName(snapshot, holding)} ${item?.kind ?? ''} ${holding.container}`.toLocaleLowerCase().includes(query);
      return matchesKind && matchesText;
    });
  }, [currentHoldings, kind, search, snapshot]);

  const locked = busy || unconfirmed !== null;
  const canMutate = Boolean(actorId && snapshot?.actorId === actorId && canCommand && snapshot.activityState === 'none' && !locked);
  const currentTab = TABS.find((entry) => entry.id === tab)?.label ?? 'Inventory';
  const gold = snapshot?.holdings.filter((holding) => holding.container === 'inventory' && holding.asset.kind === 'currency' && holding.asset.currency === 'gold').reduce((sum, holding) => sum + holding.qty, 0) ?? 0;

  const execute = useCallback(async (request: CommandRequest<unknown>) => {
    if (actionLock.current || !actorId || !canCommand) return;
    const existing = pendingInventoryCommand(actorId);
    if (existing && existing.envelope.command_id !== request.envelope.command_id) return;
    const retryingPending = existing?.envelope.command_id === request.envelope.command_id;
    if (!retryingPending && (!snapshot || snapshot.actorId !== actorId || snapshot.activityState !== 'none')) return;
    rememberInventoryCommand(actorId, request);
    actionLock.current = true;
    setActiveOperation(request.envelope.operation);
    setBusy(true); setActionError(null); setRefreshError(null);
    try {
      await runCommand(request);
      clearInventoryCommand(actorId, request);
      if (activeActor.current !== actorId) return;
      setUnconfirmed(null);
      setSelected(null);
      setActionError(request.envelope.operation === 'inventory.claimStarterKit' ? 'Claim saved; loading the updated inventory…' : request.envelope.operation === 'inventory.sellMaterial' ? 'Sale committed.' : 'Change committed.');
      const [inventoryRead, characterRead] = await Promise.allSettled([reloadInventory(), refreshCharacter()]);
      if (activeActor.current !== actorId) return;
      const failedRead = inventoryRead.status === 'rejected' ? inventoryRead.reason : characterRead.status === 'rejected' ? characterRead.reason : null;
      if (failedRead) setRefreshError(`The change was saved, but the latest state could not be loaded (${errorLabel(failedRead)}). Refresh to see it.`);
      else setActionError(null);
    } catch (error) {
      if (activeActor.current !== actorId) return;
      if (error instanceof CommandUnconfirmedError) {
        rememberInventoryCommand(actorId, request);
        setUnconfirmed(request);
        setActionError('The result is unknown. Retry this exact request to safely confirm it; other changes are paused.');
        return;
      }
      clearInventoryCommand(actorId, request);
      setUnconfirmed(null);
      setActionError(commandError(error, request.envelope.operation));
      if ((error instanceof ApiError && error.status === 409) || (error instanceof CommandRejectedError && error.status === 409) ||
          (request.envelope.operation === 'inventory.sellMaterial' && (error instanceof ApiError || error instanceof CommandRejectedError) && error.code === 'insufficient_funds')) {
        void reloadInventory().catch(() => undefined);
      }
    } finally {
      actionLock.current = false;
      setActiveOperation(null);
      setBusy(false);
    }
  }, [actorId, canCommand, refreshCharacter, reloadInventory, runCommand, snapshot]);

  const retry = () => { if (unconfirmed) void execute(unconfirmed); };

  async function refreshCommittedState() {
    const expectedActor = actorId;
    const [inventoryRead, characterRead] = await Promise.allSettled([reloadInventory(), refreshCharacter()]);
    if (activeActor.current !== expectedActor) return;
    const failedRead = inventoryRead.status === 'rejected' ? inventoryRead.reason : characterRead.status === 'rejected' ? characterRead.reason : null;
    setRefreshError(failedRead ? `The change was saved, but the latest state could not be loaded (${errorLabel(failedRead)}). Refresh to see it.` : null);
  }

  function move(holding: InventoryHoldingDto) {
    if (!actorId || !holding) return;
    const from = holding.container === 'storage' ? 'storage' : holding.container === 'inventory' ? 'inventory' : null;
    if (!from) return;
    const target = from === 'storage' ? 'inventory' : 'storage';
    if (holding.asset.kind === 'unique') {
      const itemId = holding.itemId ?? holding.asset.itemId;
      void execute(unconfirmed ?? moveInventoryCommand(actorId, { itemId, from, to: target }));
    } else if (holding.asset.kind === 'stack') {
      if (!validQuantity(quantity, Math.min(holding.qty, 10_000))) return;
      void execute(unconfirmed ?? moveInventoryCommand(actorId, { item: holding.asset.item, quantity, from, to: target }));
    }
  }

  function equip(holding: InventoryHoldingDto) {
    if (!actorId || holding.asset.kind !== 'unique') return;
    const definition = definitionFor(snapshot, holding);
    if (!definition?.slot) return;
    void execute(unconfirmed ?? equipInventoryCommand(actorId, holding.itemId ?? holding.asset.itemId, definition.slot));
  }

  function unequip(holding: InventoryHoldingDto) {
    if (!actorId || holding.asset.kind !== 'unique') return;
    void execute(unconfirmed ?? unequipInventoryCommand(actorId, holding.itemId ?? holding.asset.itemId));
  }

  function buy(offerId: string, maxAffordable: number) {
    if (!actorId || !validQuantity(quantity, maxAffordable)) return;
    void execute(unconfirmed ?? buyInventoryCommand(actorId, offerId, quantity));
  }

  function sell(item: string, saleQuantity: number) {
    if (!actorId || !validQuantity(saleQuantity, Math.min(10_000, 2_147_483_647, Number.MAX_SAFE_INTEGER))) return;
    void execute(unconfirmed ?? sellMaterialCommand(actorId, item, saleQuantity));
  }

  function claimStarterKit() {
    if (!actorId) return;
    void execute(unconfirmed ?? claimStarterKitCommand(actorId));
  }

  const selectedDefinition = definitionFor(snapshot, selected);
  const merchantOffers = merchant?.merchants.flatMap((entry) => entry.offers.map((offer) => ({ ...offer, merchantName: humanize(entry.id) }))) ?? [];
  const conquestLocked = Boolean(snapshot && merchantOffers.length && merchantOffers.every((offer) => offer.requiresCompletedArea && !snapshot.completedAreas.includes(offer.requiresCompletedArea)));

  return <section className="screen inventory-screen" aria-labelledby="inventory-title">
    <h1 id="inventory-title" className="screen__title">Inventory</h1>
    {!character && <p className="muted">Create a character before managing inventory.</p>}
    {character && <>
      <nav className="inventory-tabs" aria-label="Inventory sections">
        {TABS.map((entry) => <button key={entry.id} type="button" aria-current={tab === entry.id ? 'page' : undefined}
          className="inventory-tabs__item" onClick={() => { setTab(entry.id); setActionError(null); }}>
          {entry.label}
        </button>)}
      </nav>
      <div className="inventory-wallet" aria-label="Current gold"><span>Gold</span><strong>{gold}</strong></div>
      <RunBagPanel holdings={snapshot?.holdings ?? []} onRefresh={() => { void reloadInventory().catch(() => undefined); }} />
      <div className="inventory-panel">
        {tab === 'merchant' ? <>
          <p className="muted">Prices shown are server catalog prices. Purchases require a free character in Sanctuary.</p>
          {merchantLoading && <p className="muted" role="status">Loading merchant stock…</p>}
          {merchantError && <div className="inventory-message" role="alert"><p>Could not load merchants ({merchantError}).</p><button className="button button--secondary" type="button" onClick={() => void reloadMerchant().catch(() => undefined)}>Retry</button></div>}
          {conquestLocked && <p className="inventory-message" role="status">Clear Region 1 to unlock these merchant offers.</p>}
          {!merchantLoading && merchant && merchantOffers.length === 0 && <p className="muted">No merchant offers are available.</p>}
          <div className="merchant-list">{merchantOffers.map((offer) => {
            const definition = snapshot?.catalog.items.find((item) => item.id === offer.item);
            const unlocked = !offer.requiresCompletedArea || Boolean(snapshot?.completedAreas.includes(offer.requiresCompletedArea));
            const maxAffordable = offer.buyPrice.amount === 0 ? 100 : Math.floor((characterGold(currentHoldings, snapshot) ?? 0) / offer.buyPrice.amount);
            const maxQty = Math.min(maxAffordable, 100);
            const ready = canMutate && unlocked && validQuantity(quantity, maxQty);
            return <article className="merchant-offer" key={`${offer.merchantName}-${offer.id}`}>
              <div><h2>{definition ? itemName(definition.nameKey, definition.id) : humanize(offer.item)}</h2><p className="muted">{offer.merchantName} · {definition?.kind ?? 'Item'}</p></div>
              <p className="merchant-offer__price">{offer.buyPrice.amount} {humanize(offer.buyPrice.currency)}</p>
              {offer.requiresCompletedArea && !unlocked && <p className="muted">Unlock: {humanize(offer.requiresCompletedArea)}</p>}
              <label className="form__label" htmlFor={`buy-qty-${offer.id}`}>Quantity</label>
              <input id={`buy-qty-${offer.id}`} aria-label={`Quantity for ${definition ? itemName(definition.nameKey, definition.id) : humanize(offer.item)}`}
                className="form__input" type="number" inputMode="numeric" min="1" max={Math.max(1, maxQty)} value={quantity}
                onChange={(event) => setQuantity(parseQuantity(event.target.value))} disabled={locked} />
              <button type="button" className="button" aria-label={`Buy ${definition ? itemName(definition.nameKey, definition.id) : humanize(offer.item)}`}
                disabled={!ready} onClick={() => buy(offer.id, maxQty)}>{unconfirmed?.envelope.operation === 'inventory.buy' ? 'Retry purchase' : `Buy for ${offer.buyPrice.amount * quantity} ${humanize(offer.buyPrice.currency)}`}</button>
            </article>;
          })}</div>
          {merchant?.sellOffers !== undefined && <SellMaterialsPanel snapshot={snapshot} offers={merchant.sellOffers}
            enabled={canMutate} locked={locked} busy={busy && activeOperation === 'inventory.sellMaterial'} sell={sell} />}
        </> : <>
          {tab === 'inventory' && snapshot?.starterKit && <StarterKitCard
            kit={snapshot.starterKit}
            snapshot={snapshot}
            busy={busy && activeOperation === 'inventory.claimStarterKit'}
            awaiting={unconfirmed?.envelope.operation === 'inventory.claimStarterKit'}
            disabled={!canMutate || snapshot.starterKit.claimed || snapshot.activityState !== 'none'}
            onClaim={claimStarterKit}
          />}
          <div className="inventory-tools">
            <label className="inventory-search"><span className="visually-hidden">Search {currentTab.toLocaleLowerCase()}</span>
              <input className="form__input" type="search" placeholder={`Search ${currentTab.toLocaleLowerCase()}`} value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label className="inventory-kind"><span className="visually-hidden">Filter by item kind</span><select className="form__input" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">All kinds</option><option value="equipment">Equipment</option><option value="consumable">Consumables</option><option value="material">Materials</option><option value="quest">Quest</option><option value="currency">Currency</option>
            </select></label>
          </div>
          {inventoryLoading && <p className="muted" role="status">Loading inventory…</p>}
          {readError && <div className="inventory-message" role="alert"><p>Could not load {currentTab.toLocaleLowerCase()} ({readError}).</p><button className="button button--secondary" type="button" onClick={() => void reloadInventory().catch(() => undefined)}>Retry</button></div>}
          {!inventoryLoading && !readError && filteredHoldings.length === 0 && <p className="muted">{search || kind !== 'all' ? 'No items match these filters.' : tab === 'storage' ? 'Storage is empty.' : tab === 'equipment' ? 'Nothing is equipped.' : 'Inventory is empty.'}</p>}
          <InventoryItemGrid holdings={filteredHoldings} snapshot={snapshot} onSelect={(holding) => setSelected(holding)} />
          {tab !== 'equipment' && snapshot && <p className="muted">{humanize(tabContainer(tab))} holds are kept safe in Sanctuary. Expeditions use carried consumables; death in an idle expedition loses half of the expedition loot. Live run loot remains provisional until return.</p>}
          {tab === 'equipment' && <EquipmentSlots snapshot={snapshot} holdings={currentHoldings} onSelect={setSelected} />}
        </>}
      </div>
      {actionError && <p className={actionError === 'Change committed.' || actionError === 'Sale committed.' ? 'inventory-success' : 'form__error'} role="status" aria-live="polite">{actionError}</p>}
      {refreshError && <div className="inventory-message" role="alert"><p>{refreshError}</p><button className="button button--secondary" type="button" onClick={() => void refreshCommittedState()}>Refresh state</button></div>}
      {unconfirmed && <button type="button" className="button" disabled={!canCommand || busy} onClick={retry}>Retry exact request</button>}
      {!canCommand && <p className="muted" role="status">Disconnected. You can review your holdings; changes wait until the connection is restored.</p>}
      {snapshot?.activityState !== 'none' && snapshot && <p className="muted" role="status">Inventory changes are available in the Sanctuary while your character is idle.</p>}
      <InventoryDetail holding={selected} definition={selectedDefinition} snapshot={snapshot} canMutate={canMutate} busy={busy}
        quantity={quantity} onQuantityChange={setQuantity} onClose={() => setSelected(null)} onEquip={equip} onUnequip={unequip} onMove={move} />
    </>}
  </section>;
}

function StarterKitCard({ kit, snapshot, busy, awaiting, disabled, onClaim }: {
  readonly kit: NonNullable<InventorySnapshotDto['starterKit']>;
  readonly snapshot: InventorySnapshotDto;
  readonly busy: boolean;
  readonly awaiting: boolean;
  readonly disabled: boolean;
  readonly onClaim: () => void;
}) {
  const names = kit.items.map((id) => {
    const definition = snapshot.catalog.items.find((entry) => entry.id === id);
    return definition ? itemName(definition.nameKey, definition.id) : humanize(id);
  });
  return <section className="inventory-message" aria-labelledby="starter-kit-title">
    <h2 id="starter-kit-title">Starter equipment kit</h2>
    <p>{names.join(' · ')}</p>
    {kit.claimed ? <p className="inventory-success" role="status">Starter kit claimed. Equip items from your inventory when you are ready.</p> : <>
      {snapshot.activityState !== 'none' && <p className="muted" role="status">Return to Sanctuary and become idle to claim your kit.</p>}
      {busy && <p className="muted" role="status">Claiming starter kit…</p>}
      {awaiting && <p className="muted" role="status">Starter kit claim awaiting confirmation. Retry the exact request to confirm it.</p>}
      {!awaiting && <button type="button" className="button" disabled={disabled || busy} onClick={onClaim}>{busy ? 'Claiming…' : 'Claim starter kit'}</button>}
    </>}
  </section>;
}

function EquipmentSlots({ snapshot, holdings, onSelect }: { snapshot: InventorySnapshotDto | null; holdings: readonly InventoryHoldingDto[]; onSelect: (holding: InventoryHoldingDto) => void }) {
  const slots = ['weapon', 'offhand', 'head', 'chest', 'legs', 'hands', 'feet', 'accessory'];
  return <section className="equipment-slots" aria-label="Equipment slots">
    {slots.map((slot) => {
      const equipped = holdings.find((holding) => holding.slot === slot);
      return <button type="button" className={`equipment-slot${equipped ? '' : ' equipment-slot--empty'}`} key={slot} onClick={() => equipped && onSelect(equipped)} disabled={!equipped}>
        <span>{humanize(slot)}</span><strong>{equipped ? displayName(snapshot, equipped) : 'Empty'}</strong>
      </button>;
    })}
  </section>;
}

function tabContainer(tab: InventoryTab): string { return tab === 'storage' ? 'storage' : tab === 'equipment' ? 'equipped' : 'inventory'; }
function definitionFor(snapshot: InventorySnapshotDto | null, holding: InventoryHoldingDto | null): InventorySnapshotDto['catalog']['items'][number] | null {
  if (!snapshot || !holding) return null;
  const id = holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.kind === 'unique' ? holding.definition : null);
  return id ? snapshot.catalog.items.find((definition) => definition.id === id) ?? null : null;
}
function displayName(snapshot: InventorySnapshotDto | null, holding: InventoryHoldingDto): string {
  if (holding.asset.kind === 'currency') return humanize(holding.asset.currency);
  const definition = definitionFor(snapshot, holding);
  return definition ? itemName(definition.nameKey, definition.id) : humanize(holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.itemId ?? holding.asset.itemId));
}
function itemName(nameKey: string | undefined, id: string): string {
  if (!nameKey) return humanize(id);
  const parts = nameKey.split('.').filter((part) => part && part !== 'item' && part !== 'name');
  const candidate = parts.at(-1);
  return humanize(candidate || id);
}
function humanize(value: string): string { const leaf = (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value).replace(/([a-z0-9])([A-Z])/g, '$1 $2'); return leaf.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toLocaleUpperCase()); }
function characterGold(holdings: readonly InventoryHoldingDto[], snapshot: InventorySnapshotDto | null): number | null {
  if (!snapshot) return null;
  return holdings.filter((holding) => holding.container === 'inventory' && holding.asset.kind === 'currency' && holding.asset.currency === 'gold').reduce((sum, holding) => sum + holding.qty, 0);
}
function validQuantity(value: number, maximum: number): boolean { return Number.isInteger(value) && value > 0 && value <= maximum; }
function parseQuantity(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function errorLabel(error: unknown): string { return error instanceof Error ? error.message : 'unknown error'; }
function commandError(error: unknown, operation: string): string {
  const code = error instanceof ApiError || error instanceof CommandRejectedError ? error.code : error instanceof Error ? error.message : 'unknown_error';
  if (code === 'busy') return 'Inventory changes are only available while your character is idle in the Sanctuary.';
  if (code === 'insufficient_funds') return operation === 'inventory.sellMaterial'
    ? 'The requested material quantity is no longer available. Refresh inventory and review it before trying again.'
    : 'There is not enough gold for this purchase.';
  if (code === 'level_required') return 'Your character does not meet this item’s level requirement.';
  if ((error instanceof ApiError && error.status === 409) || (error instanceof CommandRejectedError && error.status === 409)) return `The inventory changed on the server (${code}). State is being refreshed; review it and try again.`;
  return operation === 'inventory.sellMaterial' ? `The server rejected this material sale (${code}).` : `The server rejected this change (${code}).`;
}
