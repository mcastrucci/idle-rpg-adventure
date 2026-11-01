/**
 * Reads every `.json` file under a content root, in a deterministic (sorted, POSIX path) order. Other files (README,
 * Tiled maps, art) are ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ContentFile {
  /** Path relative to the content root, with `/` separators. */
  readonly file: string;
  readonly text: string;
}

export function loadContentFiles(root: string): ContentFile[] {
  const files: ContentFile[] = [];
  visit(root, '');
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  function visit(dir: string, rel: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absPath, relPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push({ file: relPath, text: readFileSync(absPath, 'utf8') });
    }
  }
}
