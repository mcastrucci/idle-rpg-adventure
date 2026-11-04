// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard against new hard-coded user-visible text in components. It parses every non-test `.tsx` file under `src/` and
 * flags, inside JSX:
 *   - JSX text nodes containing letters;
 *   - text-bearing attributes (`aria-label`, `title`, `placeholder`, `alt`, …) whose value is a literal with letters;
 *   - string/template literals that would be rendered as a child (`{cond ? 'Text' : 'Other'}`, `{a && 'Text'}`).
 * Symbols, digits and punctuation (`·`, `×`, `→`, `—`, `…`) are not letters, so they need no allowlist. Anything else
 * that genuinely must stay literal goes in ALLOWED below with a reason.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

const TEXT_ATTRIBUTES = new Set([
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription', 'title', 'placeholder', 'alt', 'label',
]);

/** `file:literal` pairs allowed to contain letters. */
const ALLOWED = new Set<string>([
  // Native language names must not be translated, and the codes are the visible short form.
  'app/LocaleSwitcher.tsx:ES',
  'app/LocaleSwitcher.tsx:EN',
]);

const LETTER = /\p{L}/u;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** Literal text a JSX child expression can render directly (conditional branches, `&&`/`||`/`??`, templates). */
function producedLiterals(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap((span) => [span.literal.text, ...producedLiterals(span.expression)])];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return producedLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...producedLiterals(node.whenTrue), ...producedLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return producedLiterals(node.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...producedLiterals(node.left), ...producedLiterals(node.right)];
  }
  return [];
}

export function findHardcodedText(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    if (!LETTER.test(text) || ALLOWED.has(`${file}:${text.trim()}`)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(`${file}:${line + 1} ${JSON.stringify(text.trim())}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression) for (const text of producedLiterals(init.expression)) report(init, text);
    }
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of producedLiterals(node.expression)) report(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('hard-coded UI text guard', () => {
  it('finds no untranslated text in JSX under src/', () => {
    const problems = tsxFiles(SRC).flatMap((path) => findHardcodedText(relative(SRC, path), readFileSync(path, 'utf8')));
    expect(problems).toEqual([]);
  });

  it('detects the patterns it exists to catch', () => {
    const sample = [
      'export const A = () => <p title="Hello" aria-label={"Close"}>Plain text {cond ? "Yes" : t("k")} {x && `More ${n}`}</p>;',
      'export const B = () => <p className="muted" key={"id"}>{count} · {t("ui.x")} → ×</p>;',
    ].join('\n');
    const found = findHardcodedText('sample.tsx', sample);
    expect(found.map((line) => line.split(' ').slice(1).join(' '))).toEqual(['"Hello"', '"Close"', '"Plain text"', '"Yes"', '"More"']);
  });
});
