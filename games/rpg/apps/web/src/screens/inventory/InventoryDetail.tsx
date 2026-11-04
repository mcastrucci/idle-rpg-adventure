import { useEffect, useRef } from 'react';
import type { InventoryHoldingDto, InventorySnapshotDto } from '@rpg/protocol';
import { DEFAULT_STAT_FORMULAS, changedStats, deriveStats, statDelta } from '@rpg/rpg-stats';

import { STAT_LABEL_KEYS } from '../../character/stats.ts';
import { itemDisplayName } from '../../content/labels.ts';
import { formatFixed, t } from '../../i18n/index.ts';
import { containerLabel, fallbackName, kindLabel, slotLabel } from './inventoryLabels.ts';

interface Props {
  readonly holding: InventoryHoldingDto | null;
  readonly definition: InventorySnapshotDto['catalog']['items'][number] | null;
  readonly snapshot: InventorySnapshotDto | null;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly quantity: number;
  readonly onQuantityChange: (quantity: number) => void;
  readonly onClose: () => void;
  readonly onEquip: (holding: InventoryHoldingDto) => void;
  readonly onUnequip: (holding: InventoryHoldingDto) => void;
  readonly onMove: (holding: InventoryHoldingDto) => void;
}

export function InventoryDetail({ holding, definition, snapshot, canMutate, busy, quantity, onQuantityChange, onClose, onEquip, onUnequip, onMove }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (holding && !element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!holding && element.open) element.close();
    if (!holding) { returnFocus.current?.focus(); returnFocus.current = null; }
  }, [holding]);

  if (!holding) return <dialog ref={dialog} className="inventory-detail" onClose={() => { if (holding) onClose(); }} />;
  const name = definition ? itemDisplayName(definition.nameKey, definition.id) : fallbackName(holding.definition ?? assetLabel(holding));
  const isStack = holding.asset.kind === 'stack';
  const isUnique = holding.asset.kind === 'unique';
  const isEquipped = holding.container === 'equipped';
  const moveAllowed = holding.container === 'inventory' || holding.container === 'storage';
  const maxMove = Math.max(1, Math.min(holding.qty, 10_000));
  const preview = definition?.kind === 'equipment' && holding.asset.kind === 'unique' && snapshot
    ? compareEquipment(snapshot, holding, definition, isEquipped)
    : null;
  const hasOpaqueRolls = hasNonEmptyRolls(holding.rolls);

  return <dialog ref={dialog} className="inventory-detail" aria-labelledby="inventory-detail-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={() => { if (holding) onClose(); }}>
    <div className="inventory-detail__head"><div><p className="inventory-detail__eyebrow">{definition?.kind ? kindLabel(definition.kind) : t('ui.inventory.unknown_item')}</p><h2 id="inventory-detail-title">{name}</h2></div>
      <button type="button" className="inventory-close" aria-label={t('ui.inventory.close_details', { name })} onClick={onClose}>{t('ui.common.close')}</button></div>
    <p className="muted">{[holding.qty > 1 ? t('ui.inventory.quantity_prefix', { qty: holding.qty }) : null, containerLabel(holding.container), holding.slot ? t('ui.inventory.slot_suffix', { slot: slotLabel(holding.slot) }) : null].filter(Boolean).join(' · ')}</p>
    {!definition && <p className="inventory-message" role="status">{t('ui.inventory.no_definition')}</p>}
    {definition?.levelRequired !== undefined && <p>{t('ui.inventory.required_level', { level: definition.levelRequired })} {snapshot && snapshot.level < definition.levelRequired && <span className="muted">{t('ui.inventory.your_level', { level: snapshot.level })}</span>}</p>}
    {definition?.kind === 'equipment' && <>
      {definition.stats && <ul className="item-stats">{Object.entries(definition.stats).map(([stat, value]) => <li key={stat}><span>{statLabel(stat)}</span><strong>+{value}</strong></li>)}</ul>}
      {hasOpaqueRolls && <p className="muted" role="status">{t('ui.inventory.cmp_opaque')}</p>}
      {!hasOpaqueRolls && preview && <Comparison preview={preview} unequipping={isEquipped} />}
      {!hasOpaqueRolls && !preview && <p className="muted" role="status">{t('ui.inventory.cmp_none')}</p>}
    </>}
    {holding.rolls !== undefined && <details className="item-rolls"><summary>{t('ui.inventory.rolls_title')}</summary><p className="muted">{t('ui.inventory.rolls_note')}</p></details>}
    {isStack && moveAllowed && <div className="inventory-detail__actions"><label className="form__label" htmlFor="inventory-move-qty">{t('ui.inventory.move_quantity')}</label>
      <input id="inventory-move-qty" className="form__input" type="number" inputMode="numeric" min="1" max={maxMove} value={quantity}
        onChange={(event) => onQuantityChange(parseQuantity(event.target.value))} disabled={busy} />
      <button type="button" className="button" disabled={!canMutate || busy || !validQuantity(quantity, maxMove)} onClick={() => onMove(holding)}>
        {holding.container === 'storage' ? t('ui.inventory.move_to_inventory') : t('ui.inventory.move_to_storage')}
      </button></div>}
    {isUnique && moveAllowed && <button type="button" className="button button--secondary" disabled={!canMutate || busy} onClick={() => onMove(holding)}>
      {holding.container === 'storage' ? t('ui.inventory.move_to_inventory') : t('ui.inventory.move_to_storage')}
    </button>}
    {isUnique && definition?.kind === 'equipment' && !isEquipped && holding.container === 'inventory' && <button type="button" className="button" disabled={!canMutate || busy || (definition.levelRequired !== undefined && (snapshot?.level ?? 0) < definition.levelRequired)} onClick={() => onEquip(holding)}>{t('ui.inventory.equip', { name })}</button>}
    {isUnique && isEquipped && <button type="button" className="button button--secondary" disabled={!canMutate || busy} onClick={() => onUnequip(holding)}>{t('ui.inventory.unequip', { name })}</button>}
    {isUnique && definition?.kind === 'equipment' && !isEquipped && definition.levelRequired !== undefined && snapshot && snapshot.level < definition.levelRequired && <p className="muted" role="status">{t('ui.inventory.reach_level', { level: definition.levelRequired })}</p>}
    <p className="muted inventory-detail__note">{t('ui.inventory.detail_note')}</p>
  </dialog>;
}

function Comparison({ preview, unequipping }: { preview: { delta: ReturnType<typeof statDelta>; unavailable: string | null }; unequipping: boolean }) {
  if (preview.unavailable) return <p className="muted" role="status">{t('ui.inventory.cmp_unavailable', { reason: t(preview.unavailable) })}</p>;
  const changed = changedStats(preview.delta);
  return <section className="item-comparison" aria-label={t('ui.inventory.cmp_label')}>
    <h3>{unequipping ? t('ui.inventory.cmp_current') : t('ui.inventory.cmp_equipped')}</h3>
    {changed.length === 0 ? <p className="muted">{t('ui.inventory.cmp_no_changes')}</p> : <ul>{changed.map((key) => {
      const delta = preview.delta[key];
      return <li key={key}><span>{statLabel(key)}</span><strong>{delta > 0 ? '+' : ''}{key === 'critBp' ? `${formatFixed(delta / 100, 2)}%` : delta}</strong></li>;
    })}</ul>}
    <p className="muted">{t('ui.inventory.cmp_formulas')}</p>
  </section>;
}

function compareEquipment(snapshot: InventorySnapshotDto, candidate: InventoryHoldingDto, definition: InventorySnapshotDto['catalog']['items'][number], isEquipped: boolean): { delta: ReturnType<typeof statDelta>; unavailable: string | null } | null {
  if (!definition.slot) return null;
  const equipped = snapshot.holdings.filter((item) => item.container === 'equipped' && item.asset.kind === 'unique');
  if (hasNonEmptyRolls(candidate.rolls) || equipped.some((item) => hasNonEmptyRolls(item.rolls))) {
    return { delta: emptyDelta(), unavailable: 'ui.inventory.cmp_reason_rolls' };
  }
  const catalog = snapshot.catalog.items;
  const gearFor = (items: readonly InventoryHoldingDto[]) => items.map((item) => {
    const resolved = catalog.find((entry) => entry.id === item.definition);
    return resolved ? { stats: resolved.stats ?? {} } : null;
  });
  const beforeGear = gearFor(equipped);
  const afterGear = gearFor(equipped.filter((item) => item.slot !== definition.slot));
  if (beforeGear.some((gear) => gear === null) || afterGear.some((gear) => gear === null)) return { delta: emptyDelta(), unavailable: 'ui.inventory.cmp_reason_unknown' };
  try {
    const before = deriveStats({ level: snapshot.level, attributes: snapshot.attributes, equipment: beforeGear.filter((gear) => gear !== null) }, DEFAULT_STAT_FORMULAS);
    const afterEquipment = isEquipped
      ? afterGear.filter((gear) => gear !== null)
      : [...afterGear.filter((gear) => gear !== null), { stats: definition.stats ?? {} }];
    const after = deriveStats({ level: snapshot.level, attributes: snapshot.attributes, equipment: afterEquipment }, DEFAULT_STAT_FORMULAS);
    return { delta: statDelta(before, after), unavailable: null };
  } catch { return { delta: emptyDelta(), unavailable: 'ui.inventory.cmp_reason_stats' }; }
}

function emptyDelta(): ReturnType<typeof statDelta> { return { STR: 0, AGI: 0, INT: 0, VIT: 0, SPI: 0, maxHp: 0, power: 0, physicalPower: 0, magicPower: 0, armor: 0, resist: 0, critBp: 0, haste: 0, actionIntervalTicks: 0, healPower: 0 }; }
function hasNonEmptyRolls(value: unknown): boolean {
  return value !== undefined && !(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}
function assetLabel(holding: InventoryHoldingDto): string { return holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.kind === 'currency' ? holding.asset.currency : holding.itemId ?? holding.asset.itemId; }
function statLabel(value: string): string {
  if (value === 'critBp') return t('ui.inventory.stat_crit');
  const key = (STAT_LABEL_KEYS as Readonly<Record<string, string>>)[value];
  return key === undefined ? fallbackName(value) : t(key);
}
function parseQuantity(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function validQuantity(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
