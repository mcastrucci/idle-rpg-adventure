// @ts-check
// ESLint flat config. Besides the usual TypeScript rules it enforces the architectural boundaries of the monorepo:
//   1. engine/** never imports games (ADR-0017).
//   2. Engine layering: sim-core <- world/economy <- kernels/content-compiler <- kits (docs/engine/overview.md §2).
//   3. games/survival-sandbox/** never imports @rpg/* (ADR-0017: it proves the engine boundary).
//   4. Web apps never import simulator packages (ADR-0003).
//   5. Simulator packages are deterministic: no Math.random, Date, performance, transcendental Math.* (ADR-0004).
// Every rule is proven by tools/boundaries/boundaries.test.ts (`pnpm lint:boundaries:test`).
//
// Note: in flat config a later object *replaces* the options of a rule set by an earlier one. To avoid silently
// dropping restrictions, each directory receives exactly one `no-restricted-imports` entry that already merges every
// restriction applying to it (see `engineImportRestrictions`).

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** @typedef {{ name: string, message: string }} RestrictedPath */
/** @typedef {{ group?: string[], regex?: string, message: string }} RestrictedPattern */
/** @typedef {{ paths?: RestrictedPath[], patterns?: RestrictedPattern[] }} ImportRestrictions */

/** Engine package directories and the other engine packages each may import. */
const ENGINE_PACKAGES = /** @type {const} */ ([
  'sim-core',
  'world',
  'economy',
  'expedition-kernel',
  'live-kernel',
  'content-compiler',
  'server-kit',
  'client-kit',
]);

/** @type {Record<(typeof ENGINE_PACKAGES)[number], readonly string[]>} */
const ENGINE_ALLOWED_DEPS = {
  'sim-core': [],
  world: ['sim-core'],
  economy: ['sim-core'],
  'expedition-kernel': ['sim-core', 'world', 'economy'],
  'live-kernel': ['sim-core', 'world', 'economy'],
  'content-compiler': ['sim-core', 'world', 'economy'],
  'server-kit': ENGINE_PACKAGES,
  'client-kit': ENGINE_PACKAGES,
};

/** Simulator packages: server-only (ADR-0003) and deterministic (ADR-0004). */
const SIMULATOR_FILES = [
  'engine/sim-core/**',
  'engine/expedition-kernel/**',
  'games/*/packages/*-sim/**',
  'games/survival-sandbox/**',
];

/** @type {RestrictedPattern} */
const ENGINE_NO_GAMES = {
  group: ['@rpg/*', '@rpg/**', '@survival/*', '@survival/**'],
  message: 'engine/* must not import game packages (ADR-0017).',
};

/** @type {RestrictedPattern} */
const ENGINE_NO_RELATIVE_GAMES = {
  regex: '(^|/)games(/|$)',
  message: 'engine/* must not import from games/ through relative paths (ADR-0017).',
};

/**
 * Full import restrictions for one engine package (rules 1 and 2).
 * @param {(typeof ENGINE_PACKAGES)[number]} pkg
 * @returns {ImportRestrictions}
 */
function engineImportRestrictions(pkg) {
  const allowed = ENGINE_ALLOWED_DEPS[pkg];
  const forbidden = ENGINE_PACKAGES.filter((other) => other !== pkg && !allowed.includes(other));
  /** @type {RestrictedPattern[]} */
  const patterns = [ENGINE_NO_GAMES, ENGINE_NO_RELATIVE_GAMES];
  if (forbidden.length > 0) {
    patterns.push({
      group: forbidden.flatMap((other) => [`@engine/${other}`, `@engine/${other}/**`]),
      message:
        (allowed.length > 0
          ? `Engine layering: @engine/${pkg} may only import ${allowed.map((a) => `@engine/${a}`).join(', ')}`
          : `Engine layering: @engine/${pkg} must not import other @engine/* packages`) +
        ' (docs/engine/overview.md §2).',
    });
  }
  return { patterns };
}

/** Packages a web app must never import (rule 4). */
const SIMULATOR_PACKAGE_NAMES = ['@engine/sim-core', '@engine/expedition-kernel', '@rpg/rpg-sim'];
const WEB_MESSAGE = 'Web apps must not import simulator packages; the simulation is server-only (ADR-0003).';

/** @type {ImportRestrictions} */
const WEB_IMPORT_RESTRICTIONS = {
  patterns: [
    {
      group: SIMULATOR_PACKAGE_NAMES.flatMap((name) => [name, `${name}/**`]),
      message: WEB_MESSAGE,
    },
    { regex: '(^|/)(engine/(sim-core|expedition-kernel)|packages/[^/]+-sim)(/|$)', message: WEB_MESSAGE },
  ],
};

/** @type {ImportRestrictions} */
const SANDBOX_IMPORT_RESTRICTIONS = {
  patterns: [
    {
      group: ['@rpg/*', '@rpg/**'],
      message: 'games/survival-sandbox must not import @rpg/*; if it needs something, the engine boundary is wrong (ADR-0017).',
    },
    {
      regex: '(^|/)rpg(/|$)',
      message: 'games/survival-sandbox must not import games/rpg through relative paths (ADR-0017).',
    },
  ],
};

const DETERMINISM_MESSAGE = 'is not deterministic; simulator packages use injected RNG streams and integer math (ADR-0004).';

/** Transcendental / float-only Math functions banned in simulators (sqrt included for consistency with "no floats"). */
const BANNED_MATH = [
  'random',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10',
  'pow', 'sqrt', 'cbrt', 'hypot', 'fround',
];

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Rule 1 for any engine package not listed above (future packages), then rules 1+2 per known engine package.
  {
    files: ['engine/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [ENGINE_NO_GAMES, ENGINE_NO_RELATIVE_GAMES] }] },
  },
  ...ENGINE_PACKAGES.map(
    (pkg) =>
      /** @type {import('eslint').Linter.Config} */ ({
        files: [`engine/${pkg}/**`],
        rules: { 'no-restricted-imports': ['error', engineImportRestrictions(pkg)] },
      }),
  ),

  // Rule 3.
  {
    files: ['games/survival-sandbox/**'],
    rules: { 'no-restricted-imports': ['error', SANDBOX_IMPORT_RESTRICTIONS] },
  },

  // Rule 4.
  {
    files: ['games/*/apps/web/**'],
    rules: { 'no-restricted-imports': ['error', WEB_IMPORT_RESTRICTIONS] },
  },

  // Rule 5.
  {
    files: SIMULATOR_FILES,
    rules: {
      'no-restricted-properties': [
        'error',
        ...BANNED_MATH.map((property) => ({ object: 'Math', property, message: `Math.${property} ${DETERMINISM_MESSAGE}` })),
        { object: 'Date', property: 'now', message: `Date.now ${DETERMINISM_MESSAGE}` },
        { object: 'performance', property: 'now', message: `performance.now ${DETERMINISM_MESSAGE}` },
        { object: 'globalThis', property: 'Date', message: `Date ${DETERMINISM_MESSAGE}` },
        { object: 'globalThis', property: 'performance', message: `performance ${DETERMINISM_MESSAGE}` },
        { object: 'globalThis', property: 'crypto', message: `crypto ${DETERMINISM_MESSAGE}` },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: `Date ${DETERMINISM_MESSAGE}` },
        { name: 'performance', message: `performance ${DETERMINISM_MESSAGE}` },
        { name: 'crypto', message: `crypto ${DETERMINISM_MESSAGE}` },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][computed=true]",
          message: `Computed Math[...] access ${DETERMINISM_MESSAGE}`,
        },
        {
          selector: "VariableDeclarator[init.name='Math'] > ObjectPattern",
          message: `Destructuring Math ${DETERMINISM_MESSAGE}`,
        },
      ],
    },
  },
);
