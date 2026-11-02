import { z } from 'zod';

import { ItemIdSchema } from './ids.ts';

/** Provisional merchant offers. Buy price is explicit and never inferred from an item's sell value. */
export const MerchantOfferSchema = z.strictObject({
  id: z.string().regex(/^offer:[a-z0-9_.]+$/, 'must be a namespaced ID like "offer:name"'),
  item: ItemIdSchema,
  buyPrice: z.strictObject({ currency: z.literal('gold'), amount: z.int().positive().max(2_147_483_647) }),
  stock: z.literal('infinite').default('infinite'),
  requiresCompletedArea: z.string().regex(/^area:[a-z0-9_.]+$/).optional(),
});

export const MerchantSchema = z.strictObject({
  id: z.string().regex(/^merchant:[a-z0-9_.]+$/, 'must be a namespaced ID like "merchant:name"'),
  offers: z.array(MerchantOfferSchema).min(1),
}).superRefine((merchant, ctx) => {
  const ids = new Set<string>();
  merchant.offers.forEach((offer, index) => {
    if (ids.has(offer.id)) ctx.addIssue({ code: 'custom', path: ['offers', index, 'id'], message: 'offer IDs must be unique within a merchant' });
    ids.add(offer.id);
  });
});

export type Merchant = z.output<typeof MerchantSchema>;
export type MerchantOffer = Merchant['offers'][number];
