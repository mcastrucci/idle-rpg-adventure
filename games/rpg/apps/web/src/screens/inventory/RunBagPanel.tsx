import type { InventoryHoldingDto } from '@rpg/protocol';

/** Durable view of unsecured live rewards from the same ledger snapshot as the inventory. */
export function RunBagPanel({ holdings, onRefresh }: {
  readonly holdings: readonly InventoryHoldingDto[];
  readonly onRefresh: () => void;
}) {
  const bags = new Map<string, InventoryHoldingDto[]>();
  for (const holding of holdings) {
    if (!holding.container.startsWith('run_bag:')) continue;
    const current = bags.get(holding.container) ?? [];
    current.push(holding);
    bags.set(holding.container, current);
  }
  const entries = [...bags.entries()].sort(([a], [b]) => a.localeCompare(b));
  return <section className="run-bag" aria-labelledby="run-bag-title">
    <div className="run-bag__heading">
      <div><h2 id="run-bag-title">Unsecured live rewards</h2><p>Rewards move to inventory only when you return to Sanctuary.</p></div>
      <button className="button button--secondary" type="button" onClick={onRefresh}>Refresh</button>
    </div>
    {entries.length === 0 ? <p className="muted">No live rewards are waiting in a run bag.</p> : entries.map(([container, items]) => {
      const instanceId = container.slice('run_bag:'.length);
      const gold = items.filter((holding) => holding.asset.kind === 'currency' && holding.asset.currency === 'gold')
        .reduce((sum, holding) => sum + holding.qty, 0);
      const contents = items.filter((holding) => holding.asset.kind !== 'currency');
      const count = contents.reduce((sum, holding) => sum + holding.qty, 0);
      return <article className="run-bag__instance" key={container} aria-label={`Run bag ${instanceId}`}>
        <p className="run-bag__summary"><strong>{count} items</strong><span>{gold} gold</span></p>
        {contents.length === 0 ? <p className="muted">No items.</p> : <ul className="run-bag__items">
          {contents.map((holding) => <li key={holding.asset.kind === 'unique' ? holding.asset.itemId :
            holding.asset.kind === 'stack' ? `${holding.container}:${holding.asset.item}` : `${holding.container}:${holding.asset.currency}`}>
            <span>{holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item :
              holding.asset.kind === 'unique' ? holding.asset.itemId : holding.asset.currency)}</span>
            <strong>×{holding.qty}</strong>
          </li>)}
        </ul>}
      </article>;
    })}
  </section>;
}
