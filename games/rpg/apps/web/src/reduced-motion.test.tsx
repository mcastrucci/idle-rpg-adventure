import { cleanup, render, screen } from '@testing-library/react';
import type { LiveViewDto } from '@rpg/protocol';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveCombat } from './live/combat/LiveCombat.tsx';

const srcDir = __dirname;
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'node_modules' ? [] : cssFiles(path)) : path.endsWith('.css') ? [path] : [];
  });
}
/** Splits CSS into text outside reduced-motion media blocks, the reduce blocks, and the no-preference blocks. */
function split(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let outside = ''; let reduce = ''; let i = 0;
  const re = /@media\s*\(prefers-reduced-motion:\s*(reduce|no-preference)\)\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    outside += text.slice(i, m.index);
    let depth = 1; let j = re.lastIndex;
    while (depth > 0 && j < text.length) { depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0; j += 1; }
    if (m[1] === 'reduce') reduce += text.slice(re.lastIndex, j - 1);
    i = j; re.lastIndex = j;
  }
  return { outside: outside + text.slice(i), reduce };
}

describe('prefers-reduced-motion (CSS)', () => {
  it('every animated/transitioned selector is gated by no-preference or overridden under reduce', () => {
    const files = cssFiles(srcDir);
    expect(files.length).toBeGreaterThan(3);
    let motionRules = 0;
    for (const file of files) {
      const { outside, reduce } = split(readFileSync(file, 'utf8'));
      for (const rule of outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(^|[;\s])(animation|transition)\s*:/.test(rule[2] ?? '')) continue;
        motionRules += 1;
        for (const selector of (rule[1] ?? '').split(',').map((s) => s.trim())) {
          const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          expect(new RegExp(`${escaped}[^{}]*\\{[^}]*(transition|animation)\\s*:\\s*none`).test(reduce),
            `${file}: ${selector} lacks a reduced-motion override`).toBe(true);
        }
      }
    }
    expect(motionRules).toBeGreaterThan(0);
  });

  it('never enables smooth scrolling outside no-preference', () => {
    for (const file of cssFiles(srcDir)) {
      expect(split(readFileSync(file, 'utf8')).outside, file).not.toMatch(/scroll-behavior\s*:\s*smooth/);
    }
  });

  it('the global stylesheet forces instant scrolling under reduce', () => {
    expect(split(readFileSync(join(srcDir, 'styles.css'), 'utf8')).reduce).toMatch(/scroll-behavior:\s*auto/);
  });
});

describe('prefers-reduced-motion (LiveCombat)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('uses no smooth JS motion and still announces the telegraph in text', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const scrollIntoView = vi.fn(); const scrollTo = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView; Element.prototype.scrollTo = scrollTo;
    const actorId = 'hero-1';
    const view = { phase: 'combat', heroes: [{ actorId, hp: 60, maxHp: 100, present: true, consumables: [], skills: [], automation: { enabled: false } }],
      combat: { tick: 12, groupId: 'g', actors: [
        { id: actorId, side: 'hero', hp: 60, maxHp: 100, alive: true, effects: [], auto: false, queued: null, windup: null },
        { id: 'enemy:boar', labelKey: 'enemy.boar.name', side: 'enemy', hp: 80, maxHp: 100, alive: true, effects: [], auto: false, queued: null,
          windup: { skill: 'skill:heavy_strike', skillLabelKey: 'skill.heavy_strike.name', targetIds: [actorId], startedTick: 10, resolveAtTick: 15 } },
      ] } } as unknown as LiveViewDto;
    const online = { status: 'open', attempt: 0, retryInMs: null, lastCloseCode: null, error: null } as const;
    render(<LiveCombat view={view} actorId={actorId} events={[]} pendingCommandIds={[]} connection={online} onSubmit={() => 'id'} />);
    const telegraph = document.querySelector('.live-combat__telegraph');
    expect(telegraph?.getAttribute('role')).toBe('status');
    expect(telegraph?.textContent).toMatch(/winding up/);
    expect(screen.getByText('Resolves in 3 ticks')).toBeTruthy();
    for (const call of [...scrollIntoView.mock.calls, ...scrollTo.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('smooth');
    }
  });
});
