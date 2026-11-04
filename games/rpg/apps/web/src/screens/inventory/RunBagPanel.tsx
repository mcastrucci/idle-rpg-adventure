import type { InventoryHoldingDto } from '@rpg/protocol';

import { t } from '../../i18n/index.ts';
import { currencyLabel, fallbackName } from './inventoryLabels.ts';

function holdingName(holding: InventoryHoldingDto): string {
  if (holding.asset.kind === 'currency') return currencyLabel(holding.asset.currency);
  return fallbackName(holding.definition ?? (holding.asset.kind === 'stack' ? holding.asset.item : holding.asset.itemId));
}

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
      <div><h2 id="run-bag-title">{t('ui.run_bag.title')}</h2><p>{t('ui.run_bag.intro')}</p></div>
      <button className="button button--secondary" type="button" onClick={onRefresh}>{t('ui.common.refresh')}</button>
    </div>
    {entries.length === 0 ? <p className="muted">{t('ui.run_bag.empty')}</p> : entries.map(([container, items]) => {
      const instanceId = container.slice('run_bag:'.length);
      const gold = items.filter((holding) => holding.asset.kind === 'currency' && holding.asset.currency === 'gold')
        .reduce((sum, holding) => sum + holding.qty, 0);
      const contents = items.filter((holding) => holding.asset.kind !== 'currency');
      const count = contents.reduce((sum, holding) => sum + holding.qty, 0);
      return <article className="run-bag__instance" key={container} aria-label={t('ui.run_bag.bag_label', { id: instanceId })}>
        <p className="run-bag__summary"><strong>{t('ui.run_bag.items', { count })}</strong><span>{t('ui.run_bag.gold', { gold })}</span></p>
        {contents.length === 0 ? <p className="muted">{t('ui.run_bag.no_items')}</p> : <ul className="run-bag__items">
          {contents.map((holding) => <li key={holding.asset.kind === 'unique' ? holding.asset.itemId :
            holding.asset.kind === 'stack' ? `${holding.container}:${holding.asset.item}` : `${holding.container}:${holding.asset.currency}`}>
            <span>{holdingName(holding)}</span>
            <strong>×{holding.qty}</strong>
          </li>)}
        </ul>}
      </article>;
    })}
  </section>;
}
