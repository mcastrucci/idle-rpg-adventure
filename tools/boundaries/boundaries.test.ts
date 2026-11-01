// Proves the architectural lint rules in eslint.config.js: each rule group must report a deliberate violation and
// accept a legal counterpart. Snippets are linted in memory at virtual file paths, so no fixture files are needed and
// nothing here is picked up by `pnpm lint`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: repoRoot });

interface Case {
  /** Virtual file path, relative to the repository root. */
  readonly file: string;
  readonly code: string;
}

interface ViolationCase extends Case {
  /** Rule that must report the violation. */
  readonly rule: string;
}

async function lint({ file, code }: Case): Promise<ESLint.LintResult> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${file}`);
  return result;
}

function reexport(specifier: string): string {
  return `import { value } from '${specifier}';\nexport { value };\n`;
}

const IMPORTS = 'no-restricted-imports';

function expectViolation(c: ViolationCase): () => Promise<void> {
  return async () => {
    const result = await lint(c);
    const rules = result.messages.map((m) => m.ruleId);
    expect(rules, `expected ${c.rule} in ${c.file}:\n${c.code}`).toContain(c.rule);
  };
}

function expectClean(c: Case): () => Promise<void> {
  return async () => {
    const result = await lint(c);
    expect(result.messages.map((m) => `${m.ruleId ?? 'fatal'}: ${m.message}`)).toEqual([]);
  };
}

describe('rule 1: engine/** must not import games', () => {
  const file = 'engine/world/src/fixture.ts';
  it('rejects @rpg/*', expectViolation({ file, code: reexport('@rpg/rpg-schema'), rule: IMPORTS }));
  it('rejects @rpg/* subpaths', expectViolation({ file, code: reexport('@rpg/protocol/messages'), rule: IMPORTS }));
  it('rejects @survival/*', expectViolation({ file, code: reexport('@survival/sandbox'), rule: IMPORTS }));
  it(
    'rejects relative paths into games/',
    expectViolation({ file, code: reexport('../../../games/rpg/packages/rpg-sim/src/index.ts'), rule: IMPORTS }),
  );
  it(
    'applies to engine packages not yet listed in the layering table',
    expectViolation({ file: 'engine/future-package/src/fixture.ts', code: reexport('@rpg/rpg-sim'), rule: IMPORTS }),
  );
  it('accepts allowed engine imports', expectClean({ file, code: reexport('@engine/sim-core') }));
  it('accepts relative imports inside the package', expectClean({ file, code: reexport('./index.ts') }));
});

describe('rule 2: engine layering', () => {
  const layering: readonly (readonly [pkg: string, allowed: readonly string[], forbidden: readonly string[]])[] = [
    ['sim-core', [], ['world', 'economy', 'expedition-kernel', 'live-kernel', 'content-compiler', 'server-kit', 'client-kit']],
    ['world', ['sim-core'], ['economy', 'expedition-kernel', 'live-kernel', 'content-compiler', 'server-kit', 'client-kit']],
    ['economy', ['sim-core'], ['world', 'expedition-kernel', 'live-kernel', 'content-compiler', 'server-kit', 'client-kit']],
    ['expedition-kernel', ['sim-core', 'world', 'economy'], ['live-kernel', 'content-compiler', 'server-kit', 'client-kit']],
    ['live-kernel', ['sim-core', 'world', 'economy'], ['expedition-kernel', 'content-compiler', 'server-kit', 'client-kit']],
    ['content-compiler', ['sim-core', 'world', 'economy'], ['expedition-kernel', 'live-kernel', 'server-kit', 'client-kit']],
    [
      'server-kit',
      ['sim-core', 'world', 'economy', 'expedition-kernel', 'live-kernel', 'content-compiler', 'client-kit'],
      [],
    ],
    [
      'client-kit',
      ['sim-core', 'world', 'economy', 'expedition-kernel', 'live-kernel', 'content-compiler', 'server-kit'],
      [],
    ],
  ];

  for (const [pkg, allowed, forbidden] of layering) {
    const file = `engine/${pkg}/src/fixture.ts`;
    for (const dep of forbidden) {
      it(`@engine/${pkg} rejects @engine/${dep}`, expectViolation({ file, code: reexport(`@engine/${dep}`), rule: IMPORTS }));
    }
    for (const dep of allowed) {
      it(`@engine/${pkg} accepts @engine/${dep}`, expectClean({ file, code: reexport(`@engine/${dep}`) }));
    }
  }

  it(
    'rejects subpath imports of a forbidden layer',
    expectViolation({ file: 'engine/sim-core/src/fixture.ts', code: reexport('@engine/world/graph'), rule: IMPORTS }),
  );
  it(
    'still rejects games imports from a kit',
    expectViolation({ file: 'engine/server-kit/src/fixture.ts', code: reexport('@rpg/rpg-sim'), rule: IMPORTS }),
  );
});

describe('rule 3: games/survival-sandbox must not import @rpg/*', () => {
  const file = 'games/survival-sandbox/src/fixture.ts';
  it('rejects @rpg/*', expectViolation({ file, code: reexport('@rpg/rpg-stats'), rule: IMPORTS }));
  it(
    'rejects relative paths into games/rpg',
    expectViolation({ file, code: reexport('../../rpg/packages/rpg-sim/src/index.ts'), rule: IMPORTS }),
  );
  it('accepts engine packages', expectClean({ file, code: reexport('@engine/expedition-kernel') }));
});

describe('rule 4: web apps must not import simulator packages', () => {
  const file = 'games/rpg/apps/web/src/fixture.ts';
  for (const pkg of ['@engine/sim-core', '@engine/expedition-kernel', '@rpg/rpg-sim', '@rpg/rpg-sim/combat']) {
    it(`rejects ${pkg}`, expectViolation({ file, code: reexport(pkg), rule: IMPORTS }));
  }
  it(
    'rejects relative paths into a simulator package',
    expectViolation({ file, code: reexport('../../../packages/rpg-sim/src/index.ts'), rule: IMPORTS }),
  );
  it(
    'applies to the web app of any game',
    expectViolation({ file: 'games/other-game/apps/web/src/fixture.ts', code: reexport('@engine/sim-core'), rule: IMPORTS }),
  );
  for (const pkg of ['@rpg/protocol', '@rpg/rpg-schema', '@rpg/rpg-stats', '@engine/client-kit', '@engine/world']) {
    it(`accepts ${pkg}`, expectClean({ file, code: reexport(pkg) }));
  }
  it('does not restrict the server app', expectClean({ file: 'games/rpg/apps/server/src/fixture.ts', code: reexport('@rpg/rpg-sim') }));
});

describe('rule 5: simulator packages are deterministic', () => {
  const simulatorFiles = [
    'engine/sim-core/src/fixture.ts',
    'engine/expedition-kernel/src/fixture.ts',
    'games/rpg/packages/rpg-sim/src/fixture.ts',
    'games/survival-sandbox/src/fixture.ts',
  ];
  const violations: readonly (readonly [label: string, code: string, rule: string])[] = [
    ['Math.random()', 'export const x = Math.random();\n', 'no-restricted-properties'],
    ['new Date()', 'export const x = new Date();\n', 'no-restricted-globals'],
    ['Date.now()', 'export const x = Date.now();\n', 'no-restricted-properties'],
    ['performance.now()', 'export const x = performance.now();\n', 'no-restricted-properties'],
    ['globalThis.performance', 'export const x = globalThis.performance;\n', 'no-restricted-properties'],
    ['crypto.getRandomValues()', 'export const x = crypto.getRandomValues(new Uint32Array(1));\n', 'no-restricted-globals'],
    ['Math.sin()', 'export const x = Math.sin(1);\n', 'no-restricted-properties'],
    ['Math.exp()', 'export const x = Math.exp(1);\n', 'no-restricted-properties'],
    ['Math.log()', 'export const x = Math.log(2);\n', 'no-restricted-properties'],
    ['Math.pow()', 'export const x = Math.pow(2, 3);\n', 'no-restricted-properties'],
    ['Math.sqrt()', 'export const x = Math.sqrt(4);\n', 'no-restricted-properties'],
    ["Math['random']()", "export const x = Math['random']();\n", 'no-restricted-syntax'],
    ['destructured Math', 'const { random } = Math;\nexport const x = random();\n', 'no-restricted-syntax'],
  ];

  for (const file of simulatorFiles) {
    describe(file, () => {
      for (const [label, code, rule] of violations) {
        it(`rejects ${label}`, expectViolation({ file, code, rule }));
      }
      it(
        'accepts integer Math helpers',
        expectClean({ file, code: 'export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);\n' }),
      );
    });
  }

  it(
    'does not apply outside simulator packages',
    expectClean({ file: 'engine/server-kit/src/fixture.ts', code: 'export const now = (): number => Date.now() + Math.random();\n' }),
  );
});
