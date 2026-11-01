/**
 * @rpg/content-plugin — the RPG `ContentGamePlugin` for `@engine/content-compiler` (ADR-0008,
 * docs/spec/content-format.md): RPG collections from `@rpg/rpg-schema`, RPG fields on areas/locations, RPG requirement
 * predicates, cross-document references and RPG checks.
 *
 * It lives under `games/rpg/tools` (not `packages`) so runtime apps never bundle the compiler. Usage:
 *
 *     pnpm content-cli validate games/rpg/content --game ./games/rpg/tools/content-plugin/src/index.ts
 */
import { defineContentPlugin } from '@engine/content-compiler';
import { createRpgPredicateRegistry, type RpgGameContext } from '@rpg/rpg-schema';

import { RPG_CONTENT_COLLECTIONS } from './collections.ts';
import { RpgAreaExtensionSchema, RpgLocationExtensionSchema } from './extensions.ts';
import { rpgReferences } from './references.ts';
import { validateRpgContent } from './validate.ts';

export * from './collections.ts';
export * from './extensions.ts';
export * from './references.ts';
export * from './validate.ts';

export const rpgContentPlugin = defineContentPlugin<RpgGameContext>({
  id: 'rpg',
  collections: RPG_CONTENT_COLLECTIONS,
  predicates: createRpgPredicateRegistry(),
  extend: { areas: RpgAreaExtensionSchema, locations: RpgLocationExtensionSchema },
  references: rpgReferences,
  validate: validateRpgContent,
});

export default rpgContentPlugin;
