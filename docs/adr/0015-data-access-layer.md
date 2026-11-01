# ADR-0015: Data access layer (Drizzle vs Kysely)

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** M2 (server foundation)

## Decision (hypothesis)
- Drizzle ORM + drizzle-kit migrations. Kysely is the alternative.
- Row locks, compare-and-set and idempotent inserts are written as explicit SQL (`sql\`\``, `.for('update')`,
  `ON CONFLICT DO NOTHING`), never hidden behind ORM magic.

## Consequences
Low stakes; switching is feasible while the schema is small.
