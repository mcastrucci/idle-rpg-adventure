/**
 * Generic sample game plugin used by the CLI smoke test (not a real game): one `widgets` collection whose entities are
 * placed at locations, a game field on locations, and one game predicate.
 */
import { PredicateRegistry } from '@engine/world';
import { z } from 'zod';

import { defineContentPlugin, referencesAt } from '../src/index.ts';

export interface SampleGameState {
  readonly counters: Readonly<Record<string, number>>;
}

export const WidgetSchema = z.strictObject({
  id: z.string(),
  name: z.string().min(1),
  location: z.string(),
  requires: z.array(z.string()).default([]),
});

const plugin = defineContentPlugin<SampleGameState>({
  id: 'sample',
  collections: {
    widgets: { dir: 'widgets', schema: WidgetSchema, idPrefix: 'widget' },
  },
  predicates: new PredicateRegistry<SampleGameState>().register('counterAtLeast', {
    args: z.strictObject({ counter: z.string().min(1), value: z.int().positive() }),
    evaluate: ({ counter, value }, ctx) => (ctx.game.counters[counter] ?? 0) >= value,
  }),
  extend: {
    locations: z.looseObject({ ambience: z.enum(['quiet', 'busy']).optional() }),
  },
  references: (content) => [
    ...referencesAt(content, 'widgets', 'location', 'locations'),
    ...referencesAt(content, 'widgets', 'requires.*', 'widgets'),
  ],
  validate: (content) =>
    (content.collections['widgets'] ?? [])
      .filter((widget) => widget['requires'] !== undefined && (widget['requires'] as string[]).includes(widget.id))
      .map((widget) => ({
        code: 'sample.widgetSelfRequired',
        collection: 'widgets',
        id: widget.id,
        path: ['requires'],
        message: `Widget "${widget.id}" requires itself`,
      })),
});

export default plugin;
