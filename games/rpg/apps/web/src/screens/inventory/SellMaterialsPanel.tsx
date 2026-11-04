import { useState } from 'react';
import type { InventorySnapshotDto, MerchantCatalogDto } from '@rpg/protocol';

import { itemDisplayName } from '../../content/labels.ts';
import { t } from '../../i18n/index.ts';

type SellOffer = NonNullable<MerchantCatalogDto['sellOffers']>[number];

interface Props {
  readonly snapshot: InventorySnapshotDto | null;
  readonly offers: readonly SellOffer[];
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly busy: boolean;
  readonly sell: (item: string, quantity: number) => void;
}

const MAX_DB_INT = 2_147_483_647;
const MAX_SALE_QUANTITY = Math.min(10_000, MAX_DB_INT, Number.MAX_SAFE_INTEGER);

/** Shows server-priced sales only for known material stacks currently in the safe inventory container. */
export function SellMaterialsPanel({ snapshot, offers, enabled, locked, busy, sell }: Props) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const offerByItem = new Map(offers.map((offer) => [offer.item, offer]));
  const rows = snapshot?.holdings.flatMap((holding) => {
    if (holding.container !== 'inventory' || holding.asset.kind !== 'stack' || !Number.isSafeInteger(holding.qty) || holding.qty < 1) return [];
    const itemId = holding.asset.item;
    const definition = snapshot.catalog.items.find((item) => item.id === itemId);
    const offer = offerByItem.get(itemId);
    if (!definition || definition.kind !== 'material' || definition.stackable !== true || !offer) return [];
    const maximum = Math.min(holding.qty, MAX_SALE_QUANTITY, Math.floor(MAX_DB_INT / offer.unitPrice.amount));
    const rawQuantity = quantities[itemId] ?? '1';
    const quantity = Number(rawQuantity);
    const name = itemDisplayName(definition.nameKey, definition.id);
    const total = quantity * offer.unitPrice.amount;
    const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum && Number.isSafeInteger(total) && total > 0 && total <= MAX_DB_INT;
    return [{ item: itemId, name, stock: holding.qty, maximum, quantity, rawQuantity, total, valid, offer }];
  }) ?? [];

  return <section className="sell-materials" aria-labelledby="sell-materials-title">
    <h2 id="sell-materials-title">{t('ui.sell.title')}</h2>
    <p className="muted">{t('ui.sell.intro')}</p>
    {rows.length === 0 ? <p className="muted">{t('ui.sell.empty')}</p> : <div className="merchant-list">
      {rows.map(({ item, name, stock, maximum, quantity, rawQuantity, total, valid, offer }) => {
        const actionLabel = valid ? t('ui.sell.action_total', { quantity, name, total }) : t('ui.sell.action', { name });
        return <article className="merchant-offer" key={item}>
          <div><h3>{name}</h3><p className="muted">{t('ui.sell.owned', { stock })}</p></div>
          <p className="merchant-offer__price">{t('ui.sell.each', { amount: offer.unitPrice.amount })}</p>
          <label className="form__label" htmlFor={`sell-qty-${safeId(item)}`}>{t('ui.sell.quantity')}</label>
          <input id={`sell-qty-${safeId(item)}`} aria-label={t('ui.sell.quantity_for', { name })} className="form__input"
            type="number" inputMode="numeric" min="1" max={maximum} step="1" value={rawQuantity} aria-invalid={!valid || undefined}
            disabled={locked} onChange={(event) => {
              setQuantities((current) => ({ ...current, [item]: event.target.value }));
            }} />
          <button type="button" className="button" aria-label={actionLabel}
            disabled={!enabled || locked || !valid} onClick={() => sell(item, quantity)}>
            {busy ? t('ui.sell.selling') : actionLabel}
          </button>
        </article>;
      })}
    </div>}
  </section>;
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '-'); }
