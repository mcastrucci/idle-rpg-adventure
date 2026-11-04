import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InventoryHoldingDto, InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';

import type { ApiClient } from '../api/http.ts';
import { ApiError } from '../api/http.ts';
import type { CharacterDto } from '../api/types.ts';
import type { CommandRequest } from '../api/commands.ts';
import { CommandRejectedError, CommandUnconfirmedError } from '../api/commands.ts';
import { itemDisplayName } from '../content/labels.ts';
import { displayLabel } from '../content/labels.ts';
import { t } from '../i18n/index.ts';
import type { Params } from '../i18n/index.ts';
import { buyInventoryCommand, claimStarterKitCommand, equipInventoryCommand, moveInventoryCommand, sellMaterialCommand, unequipInventoryCommand } from '../inventory/api.ts';
import { useInventoryState } from './inventory/useInventoryState.ts';
import { InventoryDetail } from './inventory/InventoryDetail.tsx';
import { InventoryItemGrid } from './inventory/InventoryItemGrid.tsx';
import { currencyLabel, fallbackName, kindLabel, slotLabel } from './inventory/inventoryLabels.ts';
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

const TABS: readonly { id: InventoryTab; labelKey: string }[] = [
  { id: 'inventory', labelKey: 'ui.inventory.tab_inventory' }, { id: 'storage', labelKey: 'ui.inventory.tab_storage' },
  { id: 'equipment', labelKey: 'ui.inventory.tab_equipment' }, { id: 'merchant', labelKey: 'ui.inventory.tab_merchant' },
];

/** A message under the panel: a catalog key plus params, so it is translated when rendered (and follows the locale). */
interface Notice {
  readonly key: string;
  readonly params?: Params | undefined;
  readonly tone: 'success' | 'error';
}
const PENDING_NOTICE: Notice = { key: 'ui.inventory.pending_previous', tone: 'error' };
const errorNotice = (key: string, params?: Params): Notice => ({ key, params, tone: 'error' });

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
  const [actionError, setActionError] = useState<Notice | null>(() => pendingInventoryCommand(actorId) ? PENDING_NOTICE : null);
  const [refreshError, setRefreshError] = useState<Notice | null>(null);
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
    setActionError(pendingRequest ? PENDING_NOTICE : null);
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
  const currentTab = t(TABS.find((entry) => entry.id === tab)?.labelKey ?? 'ui.inventory.tab_inventory');
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
      setActionError({ tone: 'success', key: request.envelope.operation === 'inventory.claimStarterKit' ? 'ui.inventory.claim_saved'
        : request.envelope.operation === 'inventory.sellMaterial' ? 'ui.inventory.sale_committed' : 'ui.inventory.change_committed' });
      const [inventoryRead, characterRead] = await Promise.allSettled([reloadInventory(), refreshCharacter()]);
      if (activeActor.current !== actorId) return;
      const failedRead = inventoryRead.status === 'rejected' ? inventoryRead.reason : characterRead.status === 'rejected' ? characterRead.reason : null;
      if (failedRead) setRefreshError(errorNotice('ui.inventory.refresh_failed', { error: errorLabel(failedRead) }));
      else setActionError(null);
    } catch (error) {
      if (activeActor.current !== actorId) return;
      if (error instanceof CommandUnconfirmedError) {
        rememberInventoryCommand(actorId, request);
        setUnconfirmed(request);
        setActionError(errorNotice('ui.inventory.result_unknown'));
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
    setRefreshError(failedRead ? errorNotice('ui.inventory.refresh_failed', { error: errorLabel(failedRead) }) : null);
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
  const merchantOffers = merchant?.merchants.flatMap((entry) => entry.offers.map((offer) => ({ ...offer, merchantName: fallbackName(entry.id) }))) ?? [];
  const conquestLocked = Boolean(snapshot && merchantOffers.length && merchantOffers.every((offer) => offer.requiresCompletedArea && !snapshot.completedAreas.includes(offer.requiresCompletedArea)));

  return <section className="screen inventory-screen" aria-labelledby="inventory-title">
    <h1 id="inventory-title" className="screen__title">{t('ui.inventory.title')}</h1>
    {!character && <p className="muted">{t('ui.inventory.need_character')}</p>}
    {character && <>
      <nav className="inventory-tabs" aria-label={t('ui.inventory.sections_label')}>
        {TABS.map((entry) => <button key={entry.id} type="button" aria-current={tab === entry.id ? 'page' : undefined}
          className="inventory-tabs__item" onClick={() => { setTab(entry.id); setActionError(null); }}>
          {t(entry.labelKey)}
        </button>)}
      </nav>
      <div className="inventory-wallet" aria-label={t('ui.inventory.gold_label')}><span>{t('ui.common.gold')}</span><strong>{gold}</strong></div>
      <RunBagPanel holdings={snapshot?.holdings ?? []} onRefresh={() => { void reloadInventory().catch(() => undefined); }} />
      <div className="inventory-panel">
        {tab === 'merchant' ? <>
          <p className="muted">{t('ui.inventory.merchant_intro')}</p>
          {merchantLoading && <p className="muted" role="status">{t('ui.inventory.merchant_loading')}</p>}
          {merchantError && <div className="inventory-message" role="alert"><p>{t('ui.inventory.merchant_failed', { error: merchantError })}</p><button className="button button--secondary" type="button" onClick={() => void reloadMerchant().catch(() => undefined)}>{t('ui.common.retry')}</button></div>}
          {conquestLocked && <p className="inventory-message" role="status">{t('ui.inventory.conquest_locked')}</p>}
          {!merchantLoading && merchant && merchantOffers.length === 0 && <p className="muted">{t('ui.inventory.merchant_empty')}</p>}
          <div className="merchant-list">{merchantOffers.map((offer) => {
            const definition = snapshot?.catalog.items.find((item) => item.id === offer.item);
            const unlocked = !offer.requiresCompletedArea || Boolean(snapshot?.completedAreas.includes(offer.requiresCompletedArea));
            const maxAffordable = offer.buyPrice.amount === 0 ? 100 : Math.floor((characterGold(currentHoldings, snapshot) ?? 0) / offer.buyPrice.amount);
            const maxQty = Math.min(maxAffordable, 100);
            const ready = canMutate && unlocked && validQuantity(quantity, maxQty);
            const offerName = definition ? itemDisplayName(definition.nameKey, definition.id) : fallbackName(offer.item);
            return <article className="merchant-offer" key={`${offer.merchantName}-${offer.id}`}>
              <div><h2>{offerName}</h2><p className="muted">{offer.merchantName} · {definition?.kind ? kindLabel(definition.kind) : t('ui.inventory.kind.item')}</p></div>
              <p className="merchant-offer__price">{offer.buyPrice.amount} {currencyLabel(offer.buyPrice.currency)}</p>
              {offer.requiresCompletedArea && !unlocked && <p className="muted">{t('ui.inventory.unlock_area', { area: displayLabel(offer.requiresCompletedArea) })}</p>}
              <label className="form__label" htmlFor={`buy-qty-${offer.id}`}>{t('ui.inventory.quantity')}</label>
              <input id={`buy-qty-${offer.id}`} aria-label={t('ui.inventory.quantity_for', { name: offerName })}
                className="form__input" type="number" inputMode="numeric" min="1" max={Math.max(1, maxQty)} value={quantity}
                onChange={(event) => setQuantity(parseQuantity(event.target.value))} disabled={locked} />
              <button type="button" className="button" aria-label={t('ui.inventory.buy_label', { name: offerName })}
                disabled={!ready} onClick={() => buy(offer.id, maxQty)}>{unconfirmed?.envelope.operation === 'inventory.buy' ? t('ui.inventory.retry_purchase') : t('ui.inventory.buy_for', { total: offer.buyPrice.amount * quantity, currency: currencyLabel(offer.buyPrice.currency) })}</button>
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
            <label className="inventory-search"><span className="visually-hidden">{t('ui.inventory.search', { section: currentTab.toLocaleLowerCase() })}</span>
              <input className="form__input" type="search" placeholder={t('ui.inventory.search', { section: currentTab.toLocaleLowerCase() })} value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label className="inventory-kind"><span className="visually-hidden">{t('ui.inventory.filter_label')}</span><select className="form__input" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">{t('ui.inventory.filter_all')}</option><option value="equipment">{t('ui.inventory.filter_equipment')}</option><option value="consumable">{t('ui.inventory.filter_consumable')}</option><option value="material">{t('ui.inventory.filter_material')}</option><option value="quest">{t('ui.inventory.filter_quest')}</option><option value="currency">{t('ui.inventory.filter_currency')}</option>
            </select></label>
          </div>
          {inventoryLoading && <p className="muted" role="status">{t('ui.inventory.loading')}</p>}
          {readError && <div className="inventory-message" role="alert"><p>{t('ui.inventory.read_failed', { section: currentTab.toLocaleLowerCase(), error: readError })}</p><button className="button button--secondary" type="button" onClick={() => void reloadInventory().catch(() => undefined)}>{t('ui.common.retry')}</button></div>}
          {!inventoryLoading && !readError && filteredHoldings.length === 0 && <p className="muted">{search || kind !== 'all' ? t('ui.inventory.no_matches') : tab === 'storage' ? t('ui.inventory.empty_storage') : tab === 'equipment' ? t('ui.inventory.empty_equipment') : t('ui.inventory.empty_inventory')}</p>}
          <InventoryItemGrid holdings={filteredHoldings} snapshot={snapshot} onSelect={(holding) => setSelected(holding)} />
          {tab !== 'equipment' && snapshot && <p className="muted">{tab === 'storage' ? t('ui.inventory.note_storage') : t('ui.inventory.note_inventory')}</p>}
          {tab === 'equipment' && <EquipmentSlots snapshot={snapshot} holdings={currentHoldings} onSelect={setSelected} />}
        </>}
      </div>
      {actionError && <p className={actionError.tone === 'success' ? 'inventory-success' : 'form__error'} role="status" aria-live="polite">{t(actionError.key, actionError.params)}</p>}
      {refreshError && <div className="inventory-message" role="alert"><p>{t(refreshError.key, refreshError.params)}</p><button className="button button--secondary" type="button" onClick={() => void refreshCommittedState()}>{t('ui.inventory.refresh_state')}</button></div>}
      {unconfirmed && <button type="button" className="button" disabled={!canCommand || busy} onClick={retry}>{t('ui.inventory.retry_exact')}</button>}
      {!canCommand && <p className="muted" role="status">{t('ui.inventory.disconnected')}</p>}
      {snapshot?.activityState !== 'none' && snapshot && <p className="muted" role="status">{t('ui.inventory.sanctuary_only')}</p>}
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
    return definition ? itemDisplayName(definition.nameKey, definition.id) : fallbackName(id);
  });
  return <section className="inventory-message" aria-labelledby="starter-kit-title">
    <h2 id="starter-kit-title">{t('ui.inventory.starter_title')}</h2>
    <p>{names.join(' · ')}</p>
    {kit.claimed ? <p className="inventory-success" role="status">{t('ui.inventory.starter_claimed')}</p> : <>
      {snapshot.activityState !== 'none' && <p className="muted" role="status">{t('ui.inventory.starter_return')}</p>}
      {busy && <p className="muted" role="status">{t('ui.inventory.starter_claiming')}</p>}
      {awaiting && <p className="muted" role="status">{t('ui.inventory.starter_awaiting')}</p>}
      {!awaiting && <button type="button" className="button" disabled={disabled || busy} onClick={onClaim}>{busy ? t('ui.inventory.claiming') : t('ui.inventory.claim')}</button>}
    </>}
  </section>;
}

function EquipmentSlots({ snapshot, holdings, onSelect }: { snapshot: InventorySnapshotDto | null; holdings: readonly InventoryHoldingDto[]; onSelect: (holding: InventoryHoldingDto) => void }) {
  const slots = ['weapon', 'offhand', 'head', 'chest', 'legs', 'hands', 'feet', 'accessory'];
  return <section className="equipment-slots" aria-label={t('ui.inventory.slots_label')}>
    {slots.map((slot) => {
      const equipped = holdings.find((holding) => holding.slot === slot);
      return <button type="button" className={`equipment-slot${equipped ? '' : ' equipment-slot--empty'}`} key={slot} onClick={() => equipped && onSelect(equipped)} disabled={!equipped}>
        <span>{slotLabel(slot)}</span><strong>{equipped ? displayName(snapshot, equipped) : t('ui.common.empty')}</strong>
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
  if (holding.asset.kind === 'currency') return currencyLabel(holding.asset.currency);
  const definition = definitionFor(snapshot, holding);
  return definition ? itemDisplayName(definition.nameKey, definition.id) : fallbackName(holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.itemId ?? holding.asset.itemId));
}
function characterGold(holdings: readonly InventoryHoldingDto[], snapshot: InventorySnapshotDto | null): number | null {
  if (!snapshot) return null;
  return holdings.filter((holding) => holding.container === 'inventory' && holding.asset.kind === 'currency' && holding.asset.currency === 'gold').reduce((sum, holding) => sum + holding.qty, 0);
}
function validQuantity(value: number, maximum: number): boolean { return Number.isInteger(value) && value > 0 && value <= maximum; }
function parseQuantity(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function errorLabel(error: unknown): string { return error instanceof Error ? error.message : t('ui.common.unknown_error'); }
function commandError(error: unknown, operation: string): Notice {
  const code = error instanceof ApiError || error instanceof CommandRejectedError ? error.code : error instanceof Error ? error.message : 'unknown_error';
  if (code === 'busy') return errorNotice('ui.inventory.err_busy');
  if (code === 'insufficient_funds') return errorNotice(operation === 'inventory.sellMaterial' ? 'ui.inventory.err_material_gone' : 'ui.inventory.err_no_gold');
  if (code === 'level_required') return errorNotice('ui.inventory.err_level');
  if ((error instanceof ApiError && error.status === 409) || (error instanceof CommandRejectedError && error.status === 409)) return errorNotice('ui.inventory.err_conflict', { code });
  return errorNotice(operation === 'inventory.sellMaterial' ? 'ui.inventory.err_sale' : 'ui.inventory.err_rejected', { code });
}
