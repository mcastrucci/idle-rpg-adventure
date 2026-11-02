import { defineConfig } from 'drizzle-kit';

/** Historical config retained for reference only; new migrations belong to drizzle.config.ts's engine chain. */
export default defineConfig({ dialect: 'postgresql', schema: './src/live-host/schema.ts', out: './migrations-live' });
