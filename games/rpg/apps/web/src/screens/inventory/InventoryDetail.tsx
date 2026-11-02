import { useEffect, useRef } from 'react';
import type { InventoryHoldingDto, InventorySnapshotDto } from '@rpg/protocol';
import { DEFAULT_STAT_FORMULAS, changedStats, deriveStats, statDelta } from '@rpg/rpg-stats';

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
  const name = definition ? itemName(definition.nameKey, definition.id) : humanize(holding.definition ?? assetLabel(holding));
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
    <div className="inventory-detail__head"><div><p className="inventory-detail__eyebrow">{definition?.kind ? humanize(definition.kind) : 'Unknown item'}</p><h2 id="inventory-detail-title">{name}</h2></div>
      <button type="button" className="inventory-close" aria-label={`Close ${name} details`} onClick={onClose}>Close</button></div>
    <p className="muted">{holding.qty > 1 ? `Quantity: ${holding.qty} · ` : ''}{humanize(holding.container)}{holding.slot ? ` · ${humanize(holding.slot)} slot` : ''}</p>
    {!definition && <p className="inventory-message" role="status">This item definition is not in the current catalog. Its details and comparison are unavailable.</p>}
    {definition?.levelRequired !== undefined && <p>Required level: {definition.levelRequired} {snapshot && snapshot.level < definition.levelRequired && <span className="muted">(your level: {snapshot.level})</span>}</p>}
    {definition?.kind === 'equipment' && <>
      {definition.stats && <ul className="item-stats">{Object.entries(definition.stats).map(([stat, value]) => <li key={stat}><span>{humanize(stat)}</span><strong>+{value}</strong></li>)}</ul>}
      {hasOpaqueRolls && <p className="muted" role="status">Comparison unavailable: this item has saved rolls the client cannot interpret.</p>}
      {!hasOpaqueRolls && preview && <Comparison preview={preview} unequipping={isEquipped} />}
      {!hasOpaqueRolls && !preview && <p className="muted" role="status">Comparison unavailable for this item.</p>}
    </>}
    {holding.rolls !== undefined && <details className="item-rolls"><summary>Saved item properties</summary><p className="muted">Roll data is preserved by the server and is not interpreted by this screen.</p></details>}
    {isStack && moveAllowed && <div className="inventory-detail__actions"><label className="form__label" htmlFor="inventory-move-qty">Quantity to move</label>
      <input id="inventory-move-qty" className="form__input" type="number" inputMode="numeric" min="1" max={maxMove} value={quantity}
        onChange={(event) => onQuantityChange(parseQuantity(event.target.value))} disabled={busy} />
      <button type="button" className="button" disabled={!canMutate || busy || !validQuantity(quantity, maxMove)} onClick={() => onMove(holding)}>
        {holding.container === 'storage' ? 'Move to inventory' : 'Move to storage'}
      </button></div>}
    {isUnique && moveAllowed && <button type="button" className="button button--secondary" disabled={!canMutate || busy} onClick={() => onMove(holding)}>
      {holding.container === 'storage' ? 'Move to inventory' : 'Move to storage'}
    </button>}
    {isUnique && definition?.kind === 'equipment' && !isEquipped && holding.container === 'inventory' && <button type="button" className="button" disabled={!canMutate || busy || (definition.levelRequired !== undefined && (snapshot?.level ?? 0) < definition.levelRequired)} onClick={() => onEquip(holding)}>Equip {name}</button>}
    {isUnique && isEquipped && <button type="button" className="button button--secondary" disabled={!canMutate || busy} onClick={() => onUnequip(holding)}>Unequip {name}</button>}
    {isUnique && definition?.kind === 'equipment' && !isEquipped && definition.levelRequired !== undefined && snapshot && snapshot.level < definition.levelRequired && <p className="muted" role="status">Reach level {definition.levelRequired} to equip this item.</p>}
    <p className="muted inventory-detail__note">Inventory, equipped gear, and storage remain. Consumables are spent when used; death penalties apply to expedition or live-run loot as described in the activity report.</p>
  </dialog>;
}

function Comparison({ preview, unequipping }: { preview: { delta: ReturnType<typeof statDelta>; unavailable: string | null }; unequipping: boolean }) {
  if (preview.unavailable) return <p className="muted" role="status">Comparison unavailable: {preview.unavailable}</p>;
  const changed = changedStats(preview.delta);
  return <section className="item-comparison" aria-label="Comparison with equipped gear">
    <h3>{unequipping ? 'Compared with current gear' : 'Compared with equipped gear'}</h3>
    {changed.length === 0 ? <p className="muted">No stat changes.</p> : <ul>{changed.map((key) => {
      const delta = preview.delta[key];
      return <li key={key}><span>{statLabel(key)}</span><strong>{delta > 0 ? '+' : ''}{key === 'critBp' ? `${(delta / 100).toFixed(2)}%` : delta}</strong></li>;
    })}</ul>}
    <p className="muted">Uses the current client stat formulas.</p>
  </section>;
}

function compareEquipment(snapshot: InventorySnapshotDto, candidate: InventoryHoldingDto, definition: InventorySnapshotDto['catalog']['items'][number], isEquipped: boolean): { delta: ReturnType<typeof statDelta>; unavailable: string | null } | null {
  if (!definition.slot) return null;
  const equipped = snapshot.holdings.filter((item) => item.container === 'equipped' && item.asset.kind === 'unique');
  if (hasNonEmptyRolls(candidate.rolls) || equipped.some((item) => hasNonEmptyRolls(item.rolls))) {
    return { delta: emptyDelta(), unavailable: 'an equipped item or candidate has nonempty saved rolls.' };
  }
  const catalog = snapshot.catalog.items;
  const gearFor = (items: readonly InventoryHoldingDto[]) => items.map((item) => {
    const resolved = catalog.find((entry) => entry.id === item.definition);
    return resolved ? { stats: resolved.stats ?? {} } : null;
  });
  const beforeGear = gearFor(equipped);
  const afterGear = gearFor(equipped.filter((item) => item.slot !== definition.slot));
  if (beforeGear.some((gear) => gear === null) || afterGear.some((gear) => gear === null)) return { delta: emptyDelta(), unavailable: 'an equipped item definition is unknown.' };
  try {
    const before = deriveStats({ level: snapshot.level, attributes: snapshot.attributes, equipment: beforeGear.filter((gear) => gear !== null) }, DEFAULT_STAT_FORMULAS);
    const afterEquipment = isEquipped
      ? afterGear.filter((gear) => gear !== null)
      : [...afterGear.filter((gear) => gear !== null), { stats: definition.stats ?? {} }];
    const after = deriveStats({ level: snapshot.level, attributes: snapshot.attributes, equipment: afterEquipment }, DEFAULT_STAT_FORMULAS);
    return { delta: statDelta(before, after), unavailable: null };
  } catch { return { delta: emptyDelta(), unavailable: 'the catalog stats are not valid for the current formulas.' }; }
}

function emptyDelta(): ReturnType<typeof statDelta> { return { STR: 0, AGI: 0, INT: 0, VIT: 0, SPI: 0, maxHp: 0, power: 0, physicalPower: 0, magicPower: 0, armor: 0, resist: 0, critBp: 0, haste: 0, actionIntervalTicks: 0, healPower: 0 }; }
function hasNonEmptyRolls(value: unknown): boolean {
  return value !== undefined && !(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}
function assetLabel(holding: InventoryHoldingDto): string { return holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.kind === 'currency' ? holding.asset.currency : holding.itemId ?? holding.asset.itemId; }
function itemName(nameKey: string | undefined, id: string): string {
  const candidate = nameKey?.split('.').filter((part) => part && part !== 'item' && part !== 'name').at(-1);
  return humanize(candidate || id);
}
function humanize(value: string): string { const leaf = (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value).replace(/([a-z0-9])([A-Z])/g, '$1 $2'); return leaf.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toLocaleUpperCase()); }
function statLabel(value: string): string { return value === 'critBp' ? 'Critical chance' : value === 'actionIntervalTicks' ? 'Action interval' : humanize(value); }
function parseQuantity(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function validQuantity(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
