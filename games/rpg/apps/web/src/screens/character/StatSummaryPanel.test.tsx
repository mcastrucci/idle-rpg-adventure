import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../../api/http.ts';
import type { FetchLike } from '../../api/http.ts';
import type { CharacterDto } from '../../api/types.ts';
import { StatSummaryPanel } from './StatSummaryPanel.tsx';

const ACTOR = '0b6f4d1e-8f43-4f1c-9a52-1d6a2f7c9e10';
const SWORD = 'c20ce3a7-cf7a-44bc-8d82-6a4370c3a02c';
const VEST = '5b1d2c3e-1111-4222-8333-444455556666';
const CHARACTER: CharacterDto = {
  actorId: ACTOR, accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 0,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 0, skillLoadout: [], automationRules: [],
  activityState: 'none', activityId: null, version: 3,
};
const SUMMARY = {
  level: 3,
  items: [
    { itemId: SWORD, definition: 'item:rusty_sword', nameKey: 'item.rusty_sword.name', slot: 'weapon' },
    { itemId: VEST, definition: 'item:padded_vest', slot: 'chest' },
  ],
  rows: [
    { key: 'STR', base: 9, equipment: 0, total: 9, contributions: [] },
    { key: 'physicalPower', base: 12, equipment: 5, total: 17, contributions: [{ itemId: SWORD, value: 5 }] },
    { key: 'armor', base: 10, equipment: 4, total: 14, contributions: [{ itemId: SWORD, value: 1 }, { itemId: VEST, value: 3 }] },
    { key: 'critBp', base: 580, equipment: 100, total: 680, contributions: [{ itemId: VEST, value: 100 }] },
    { key: 'actionIntervalTicks', base: 10, equipment: -1, total: 9, contributions: [{ itemId: VEST, value: -1 }] },
  ],
};

function snapshot(statSummary?: unknown) {
  return {
    actorId: ACTOR, holdings: [], actorVersion: 1, activityState: 'none', level: 3, attributes: CHARACTER.attributes, completedAreas: [],
    catalog: { contentHash: 'a'.repeat(64), items: [] }, ...(statSummary === undefined ? {} : { statSummary }),
  };
}
const client = (body: unknown, status = 200): ApiClient => new ApiClient((async () => Response.json(body, { status })) as FetchLike);
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);

describe('StatSummaryPanel', () => {
  afterEach(() => cleanup());

  it('shows base, gear and total for every row, exactly as the server sent them', async () => {
    render(<StatSummaryPanel character={CHARACTER} api={client(snapshot(SUMMARY))} />);
    const power = (await screen.findByText('Physical power')).closest('tr') as HTMLElement;
    expect(cells(power)).toEqual(['12', '+5', '17']);
    expect(cells(screen.getByRole('button', { name: /Crit chance/ }).closest('tr') as HTMLElement)).toEqual(['5.8%', '+1%', '6.8%']);
    expect(cells(screen.getByRole('button', { name: /Action interval/ }).closest('tr') as HTMLElement)).toEqual(['10 ticks', '−1 tick', '9 ticks']);
    expect(cells(screen.getByText('STR').closest('tr') as HTMLElement)).toEqual(['9', '—', '9']);
    expect(screen.getByText(/Gear: Rusty Sword, Padded Vest\./)).toBeDefined();
  });

  it('expands a per-item breakdown with accessible state and collapses it again', async () => {
    render(<StatSummaryPanel character={CHARACTER} api={client(snapshot(SUMMARY))} />);
    const toggle = await screen.findByRole('button', { name: /Armor: base 10, gear \+4, total 14/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'Armor from gear' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Rusty Sword+1', 'Padded Vest+3']);
    fireEvent.click(toggle);
    expect(screen.queryByRole('list', { name: 'Armor from gear' })).toBeNull();
  });

  it('has no toggle for stats without gear and a fixed-layout table that cannot overflow 360px', async () => {
    render(<StatSummaryPanel character={CHARACTER} api={client(snapshot(SUMMARY))} />);
    await screen.findByText('Physical power');
    expect(screen.queryByRole('button', { name: /^STR/ })).toBeNull();
    const table = screen.getByRole('table');
    expect(table.querySelectorAll('thead th')).toHaveLength(4);
    expect(table.querySelector('[style]')).toBeNull();
    const css = readFileSync('games/rpg/apps/web/src/screens/character/character.css', 'utf8');
    expect(css).toMatch(/\.stat-summary \{[^}]*width: 100%;[^}]*table-layout: fixed/);
    expect(css).not.toMatch(/\.stat-summary[^{]*\{[^}]*(min-width|white-space: nowrap)/);
  });

  it('reports unavailable and failed summaries without inventing numbers', async () => {
    const { unmount } = render(<StatSummaryPanel character={CHARACTER} api={client(snapshot())} />);
    expect(await screen.findByText(/unavailable/)).toBeDefined();
    unmount();
    render(<StatSummaryPanel character={CHARACTER} api={client({ error: 'boom' }, 500)} />);
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
