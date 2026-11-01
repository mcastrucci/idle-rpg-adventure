/**
 * @engine/content-compiler — game-agnostic content compiler (ADR-0008, docs/spec/content-format.md): loads JSON content,
 * validates it with engine + game schemas, checks the world graph, references and frozen baselines, and produces a
 * hashed bundle. The `content-cli` command is in `cli.ts` / `bin.ts`.
 */
export const CONTENT_COMPILER_PACKAGE = '@engine/content-compiler';

export * from './errors.ts';
export * from './plugin.ts';
export * from './canonical.ts';
export * from './load.ts';
export * from './baseline.ts';
export * from './compile.ts';
export * from './json-schema.ts';
export { runCli, USAGE, type CliIo } from './cli.ts';
