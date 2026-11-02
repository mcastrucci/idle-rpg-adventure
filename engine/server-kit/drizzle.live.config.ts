import { defineConfig } from 'drizzle-kit';

/** The live host owns a separate migration set (`LIVE_HOST_MIGRATIONS`), applied after the engine set. */
export default defineConfig({ dialect: 'postgresql', schema: './src/live-host/schema.ts', out: './migrations-live' });
