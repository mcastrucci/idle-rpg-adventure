import type { InventoryHoldingDto, InventorySnapshotDto } from '@rpg/protocol';

interface Props {
  readonly holdings: readonly InventoryHoldingDto[];
  readonly snapshot: InventorySnapshotDto | null;
  readonly onSelect: (holding: InventoryHoldingDto) => void;
}

export function InventoryItemGrid({ holdings, snapshot, onSelect }: Props) {
  const rows = coalesceStacks(holdings);
  if (rows.length === 0) return null;
  return <ul className="inventory-grid" aria-label="Items">
    {rows.map(({ holding, qty, key }) => {
      const definition = resolveDefinition(snapshot, holding);
      const name = definition?.nameKey ? displayName(definition.nameKey, definition.id) : humanize(holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.kind === 'currency' ? holding.asset.currency : holding.itemId ?? holding.asset.itemId));
      return <li key={key}><button className="inventory-card" type="button" onClick={() => onSelect({ ...holding, qty })} aria-label={`Details for ${name}`}>
        <span className="inventory-card__mark" aria-hidden="true">{definition?.kind === 'equipment' ? '◇' : definition?.kind === 'consumable' ? '✦' : holding.asset.kind === 'currency' ? '●' : '▧'}</span>
        <span className="inventory-card__name">{name}</span>
        {qty > 1 && <span className="inventory-card__qty">×{qty}</span>}
        {definition?.kind === 'equipment' && definition.slot && <span className="inventory-card__meta">{humanize(definition.slot)}</span>}
      </button></li>;
    })}
  </ul>;
}

function coalesceStacks(holdings: readonly InventoryHoldingDto[]): { holding: InventoryHoldingDto; qty: number; key: string }[] {
  const rows: { holding: InventoryHoldingDto; qty: number; key: string }[] = [];
  const stackByKey = new Map<string, number>();
  for (const holding of holdings) {
    if (holding.asset.kind !== 'stack') {
      rows.push({ holding, qty: holding.qty, key: holding.itemId ?? `${holding.asset.kind}:${holding.asset.kind === 'currency' ? holding.asset.currency : ''}:${holding.container}` });
      continue;
    }
    const key = `${holding.asset.item}:${holding.container}`;
    const existing = stackByKey.get(key);
    if (existing === undefined) { stackByKey.set(key, rows.length); rows.push({ holding, qty: holding.qty, key }); }
    else {
      const row = rows[existing];
      if (row) rows[existing] = { ...row, qty: row.qty + holding.qty };
    }
  }
  return rows;
}

function resolveDefinition(snapshot: InventorySnapshotDto | null, holding: InventoryHoldingDto) {
  if (!snapshot) return null;
  const id = holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.kind === 'unique' ? holding.definition : null);
  return id ? snapshot.catalog.items.find((item) => item.id === id) ?? null : null;
}
function humanize(value: string): string { const leaf = (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value).replace(/([a-z0-9])([A-Z])/g, '$1 $2'); return leaf.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toLocaleUpperCase()); }
function displayName(nameKey: string, id: string): string {
  const candidate = nameKey.split('.').filter((part) => part && part !== 'item' && part !== 'name').at(-1);
  return humanize(candidate || id);
}
