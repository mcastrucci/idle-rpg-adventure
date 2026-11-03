import { defineConfig } from 'drizzle-kit';

export default defineConfig({ dialect: 'postgresql', schema: ['./src/characters/schema.ts', './src/expeditions/schema.ts', './src/debug/schema.ts', './src/live/death-schema.ts'], out: './migrations' });
