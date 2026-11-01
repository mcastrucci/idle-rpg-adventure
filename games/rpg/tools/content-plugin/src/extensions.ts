/**
 * RPG extensions of the engine world entities (areas, locations), as `extend` schemas for the content compiler.
 *
 * The compiler parses each world entity with the engine schema *and* the extension. To keep RPG content strict (typos
 * in field names fail) without reporting engine field problems twice, each extension:
 *
 * 1. parses the RPG fields (`rpgAreaFields` / `rpgLocationFields`) on a loose object, which also applies their
 *    defaults (e.g. `resources: []`) to the compiled entity;
 * 2. only if they parse, runs the full strict RPG schema (`RpgAreaSchema` / `RpgLocationSchema`) and forwards only its issues that
 *    the engine schema does not already report: unknown keys, RPG fields and whole-entity refinements (e.g. explorable
 *    areas need `difficulty`).
 */
import { AreaSchema, LocationSchema } from '@engine/world';
import { rpgEntityExtensions } from '@rpg/rpg-schema';
import { z } from 'zod';

function rpgExtension(fields: z.ZodRawShape, strict: z.ZodType, engineShape: z.ZodRawShape): z.ZodType {
  const rpgKeys = new Set(Object.keys(fields));
  const engineOnlyKeys = new Set(Object.keys(engineShape).filter((key) => !rpgKeys.has(key)));
  // A pipe: the strict pass only runs once the RPG fields parsed, so their issues are not reported twice.
  return z.looseObject(fields).pipe(
    z.looseObject({}).superRefine((value, ctx) => {
      const result = strict.safeParse(value);
      if (result.success) return;
      for (const issue of result.error.issues) {
        const head = issue.path[0];
        if (issue.code !== 'unrecognized_keys' && typeof head === 'string' && engineOnlyKeys.has(head)) continue;
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }),
  );
}

export const RpgAreaExtensionSchema = rpgExtension(rpgEntityExtensions.area.fields, rpgEntityExtensions.area.schema, AreaSchema.shape);
export const RpgLocationExtensionSchema = rpgExtension(
  rpgEntityExtensions.location.fields,
  rpgEntityExtensions.location.schema,
  LocationSchema.shape,
);
