import { z } from 'zod';

const CoordinateSchema = z.strictObject({ x: z.number().finite().int().min(-1_000_000).max(1_000_000), y: z.number().finite().int().min(-1_000_000).max(1_000_000) });
const CountSchema = z.number().int().min(0).max(1_000_000);
const IdSchema = z.string().min(1).max(160);

export const WorldViewDtoSchema = z.strictObject({
  hub: z.strictObject({ id: IdSchema, label: z.string().min(1).max(160), position: CoordinateSchema.nullable() }),
  areas: z.array(z.strictObject({
    id: IdSchema,
    label: z.string().min(1).max(160),
    visibility: z.enum(['known', 'locked']),
    position: CoordinateSchema.nullable(),
    lockedReasons: z.array(z.string().min(1).max(100)).max(32),
    completion: z.strictObject({
      discovered: CountSchema,
      required: CountSchema,
      completed: z.boolean(),
      mandatoryBosses: z.strictObject({ required: CountSchema, defeated: CountSchema, complete: z.boolean(),
        bosses: z.array(z.strictObject({ label: z.string().min(1).max(160), defeated: z.boolean() })).max(64) }),
    }).nullable(),
    danger: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('known'), minLevel: z.number().int().positive().max(10_000), maxLevel: z.number().int().positive().max(10_000) }),
      z.strictObject({ status: z.literal('unknown') }),
    ]),
    idle: z.strictObject({ unlocked: z.boolean(), activities: z.array(IdSchema).max(128) }),
    actions: z.strictObject({ enterLive: z.boolean(), startIdle: z.boolean() }),
  })).max(512),
  routes: z.array(z.strictObject({ id: IdSchema, from: IdSchema, to: IdSchema })).max(1_024),
});

export type WorldViewDTO = z.output<typeof WorldViewDtoSchema>;
export type WorldAreaDTO = WorldViewDTO['areas'][number];

/** Parse and bound the server-owned, visibility-filtered world-map response. */
export function parseWorldViewDto(input: unknown): WorldViewDTO {
  return WorldViewDtoSchema.parse(input);
}
