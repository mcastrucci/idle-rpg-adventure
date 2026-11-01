/**
 * Structured content errors. The compiler never throws on bad content: every problem becomes a {@link ContentError}
 * pointing at the file and the JSON path inside it.
 */
import type { ValidationCode } from '@engine/world';

/** Codes produced by the compiler itself (world graph codes come from `@engine/world`). */
export type CompilerErrorCode =
  | 'file.unreadable'
  | 'file.unknownCollection'
  | 'json.invalid'
  | 'id.missing'
  | 'id.wrongNamespace'
  | 'ref.unknown'
  | 'ref.invalid'
  | 'baseline.areaRemoved'
  | 'baseline.frozenChanged'
  | 'baseline.poolLocationRemoved'
  | 'baseline.poolLocationUntagged'
  | 'previous.invalid'
  | 'plugin.invalid';

/** Engine codes, plus any code a game plugin reports from its own `validate` hook. */
export type ContentErrorCode = CompilerErrorCode | ValidationCode | (string & {});

export type JsonPath = readonly (string | number)[];

export interface ContentError {
  readonly code: ContentErrorCode;
  /** File relative to the content root (POSIX separators); absent for errors not tied to one file. */
  readonly file?: string;
  /** JSON path inside the file (or inside the world when `file` is absent). */
  readonly path: JsonPath;
  readonly message: string;
}

/** `$.exits[0].to` style rendering of a JSON path. */
export function formatJsonPath(path: JsonPath): string {
  return (
    '$' +
    path
      .map((segment) =>
        typeof segment === 'number' ? `[${segment}]` : /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
      )
      .join('')
  );
}

/** Groups errors by file (errors without a file last) and renders them as human-readable lines. */
export function formatErrors(errors: readonly ContentError[]): string {
  const groups = new Map<string, ContentError[]>();
  for (const error of errors) {
    const key = error.file ?? '';
    const group = groups.get(key);
    if (group) group.push(error);
    else groups.set(key, [error]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  for (const key of keys) {
    lines.push(key === '' ? '(content)' : key);
    for (const error of groups.get(key) ?? []) {
      lines.push(`  ${error.code}  ${formatJsonPath(error.path)}  ${error.message}`);
    }
  }
  lines.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
  return lines.join('\n') + '\n';
}
