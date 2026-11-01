/**
 * `content-cli`: validate, build, graph and schema commands over a content root. See the package README for usage.
 * {@link runCli} is I/O-injected so tests can run it in-process; `bin.ts` wires it to the real process.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { areaToMermaid, worldToMermaid } from '@engine/world';

import { canonicalJson } from './canonical.ts';
import { compileContentDirectory, type CompileOptions } from './compile.ts';
import { formatErrors, type ContentError } from './errors.ts';
import { exportJsonSchemas } from './json-schema.ts';
import type { ContentGamePlugin } from './plugin.ts';

export interface CliIo {
  readonly cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE = `Usage: content-cli <command> [options]

Commands:
  validate <root> --game <module>                         Validate a content root.
  build <root> --game <module> --out <file> [--previous <bundle.json>]
                                                          Validate and write the bundle (with contentHash).
                                                          --previous checks frozen completion baselines.
  graph <root> --game <module> [--area <id>]              Mermaid world map (or one area graph) to stdout.
  schema --game <module> [--out <dir>]                    JSON Schema per collection (stdout or <dir>/<name>.schema.json).

<module> is a path (or package specifier) of an ES module exporting a ContentGamePlugin as default export or as
"plugin".
`;

class UsageError extends Error {}

/** Runs the CLI and returns the process exit code (0 ok, 1 content errors, 2 usage/plugin errors). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        game: { type: 'string' },
        out: { type: 'string' },
        previous: { type: 'string' },
        area: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, root, ...extra] = positionals;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  try {
    if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
    const plugin = await loadPlugin(values.game, io.cwd);
    const resolve = (p: string): string => path.resolve(io.cwd, p);

    if (command === 'schema') {
      if (root !== undefined) throw new UsageError('schema takes no content root');
      const schemas = exportJsonSchemas(plugin);
      if (values.out === undefined) {
        io.stdout(JSON.stringify(Object.fromEntries(schemas.map((s) => [s.collection, s.schema])), null, 2) + '\n');
      } else {
        const dir = resolve(values.out);
        mkdirSync(dir, { recursive: true });
        for (const s of schemas) writeFileSync(path.join(dir, `${s.collection}.schema.json`), JSON.stringify(s.schema, null, 2) + '\n');
        io.stderr(`Wrote ${schemas.length} schemas to ${values.out}\n`);
      }
      return 0;
    }

    if (command !== 'validate' && command !== 'build' && command !== 'graph') throw new UsageError(`Unknown command "${command}"`);
    if (root === undefined) throw new UsageError(`${command} needs a content root`);
    const rootDir = resolve(root);
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) throw new UsageError(`Content root "${root}" is not a directory`);

    const options: { -readonly [K in keyof CompileOptions]: CompileOptions[K] } = {};
    if (values.previous !== undefined) {
      if (command !== 'build') throw new UsageError('--previous is only valid with build');
      const previous = readPrevious(resolve(values.previous), values.previous);
      if ('error' in previous) return fail(io, [previous.error]);
      options.previous = previous.json;
      options.previousLabel = values.previous;
    }
    const result = compileContentDirectory(rootDir, plugin, options);

    if (command === 'graph') {
      const world = result.ok ? result.bundle.world : result.world;
      if (world) {
        if (values.area === undefined) {
          io.stdout(worldToMermaid(world));
        } else {
          const area = world.areas.find((a) => a.id === values.area);
          if (!area) throw new UsageError(`Unknown area "${values.area}"`);
          io.stdout(areaToMermaid(area, world.locations));
        }
      }
      return result.ok ? 0 : fail(io, result.errors);
    }

    if (!result.ok) return fail(io, result.errors);
    if (command === 'build') {
      if (values.out === undefined) throw new UsageError('build needs --out <file>');
      const out = resolve(values.out);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, canonicalJson(result.bundle, 2) + '\n');
      io.stdout(`Wrote ${values.out} (contentHash ${result.bundle.contentHash})\n`);
    } else {
      io.stdout(`Content OK (contentHash ${result.bundle.contentHash})\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

function fail(io: CliIo, errors: readonly ContentError[]): number {
  io.stderr(formatErrors(errors));
  return 1;
}

function readPrevious(file: string, label: string): { json: unknown } | { error: ContentError } {
  try {
    return { json: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch (error) {
    return { error: { code: 'previous.invalid', file: label, path: [], message: error instanceof Error ? error.message : String(error) } };
  }
}

async function loadPlugin(spec: string | undefined, cwd: string): Promise<ContentGamePlugin> {
  if (spec === undefined) throw new UsageError('--game <module> is required');
  const isPath = spec.startsWith('.') || spec.startsWith('/') || /\.[cm]?[jt]s$/.test(spec);
  const url = isPath ? pathToFileURL(path.resolve(cwd, spec)).href : spec;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(`Cannot load game module "${spec}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = mod['default'] ?? mod['plugin'];
  if (!isPlugin(candidate)) throw new UsageError(`"${spec}" does not export a ContentGamePlugin (default export or "plugin")`);
  return candidate;
}

function isPlugin(value: unknown): value is ContentGamePlugin {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<Record<keyof ContentGamePlugin, unknown>>;
  return typeof v.id === 'string' && typeof v.collections === 'object' && v.collections !== null && typeof v.predicates === 'object';
}
