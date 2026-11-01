/**
 * CI guard for golden replay fixtures (ADR-0004, combat-engine §10). A fixture file is a JSON history
 * `{ "<engine version>": { "<case>": "<hash>" } }`. Once a (version, case) hash exists on the base commit it must never
 * change or disappear: a behaviour change needs a new engine version and a new entry. New versions and new cases may
 * be added.
 *
 * Usage: node tools/golden/check-append-only.ts <base-commit> <fixture.json>...
 * Skips (exit 0, with a notice) when no base commit is given, the base is not in the clone, or a file is new.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type GoldenHistory = Record<string, Record<string, string>>;

/** Human-readable violations: changed or removed (version, case) hashes. */
export function appendOnlyViolations(before: GoldenHistory, after: GoldenHistory): string[] {
  const out: string[] = [];
  for (const [version, cases] of Object.entries(before)) {
    const now = after[version];
    if (now === undefined) {
      out.push(`version ${version} was removed`);
      continue;
    }
    for (const [name, hash] of Object.entries(cases)) {
      if (!(name in now)) out.push(`${version} / ${name} was removed`);
      else if (now[name] !== hash) out.push(`${version} / ${name} changed ${hash} → ${now[name]}`);
    }
  }
  return out;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const [base, ...files] = argv;
  if (base === undefined || base === '' || /^0+$/.test(base)) {
    console.log('golden append-only check: no base commit, skipped');
    return 0;
  }
  if (git(['cat-file', '-e', `${base}^{commit}`]) === null) {
    console.log(`golden append-only check: base ${base} not in this clone, skipped`);
    return 0;
  }
  let failed = false;
  for (const file of files) {
    const old = git(['show', `${base}:${file}`]);
    if (old === null) {
      console.log(`golden append-only check: ${file} is new since ${base}, skipped`);
      continue;
    }
    const violations = appendOnlyViolations(
      JSON.parse(old) as GoldenHistory,
      JSON.parse(readFileSync(file, 'utf8')) as GoldenHistory,
    );
    for (const v of violations) console.error(`${file}: ${v}`);
    if (violations.length > 0) {
      console.error(
        `${file}: existing golden hashes are frozen. Bump ENGINE_VERSION and append a new entry instead (see the rpg-sim README).`,
      );
      failed = true;
    } else {
      console.log(`golden append-only check: ${file} OK against ${base}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
