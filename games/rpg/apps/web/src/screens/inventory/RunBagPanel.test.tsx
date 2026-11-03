import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { InventoryHoldingDto } from '@rpg/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunBagPanel } from './RunBagPanel.tsx';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const holdings: InventoryHoldingDto[] = [
  { asset: { kind: 'stack', item: 'item:test_grove.herb' }, container: `run_bag:${FIRST}`, qty: 3,
    definition: 'item:test_grove.herb' },
  { asset: { kind: 'unique', itemId: '33333333-3333-4333-8333-333333333333' }, container: `run_bag:${FIRST}`, qty: 1,
    itemId: '33333333-3333-4333-8333-333333333333', definition: 'item:rusty_sword' },
  { asset: { kind: 'currency', currency: 'gold' }, container: `run_bag:${FIRST}`, qty: 12 },
  { asset: { kind: 'stack', item: 'item:test_grove.herb' }, container: `run_bag:${SECOND}`, qty: 2,
    definition: 'item:test_grove.herb' },
  { asset: { kind: 'currency', currency: 'gold' }, container: `run_bag:${SECOND}`, qty: 5 },
  { asset: { kind: 'stack', item: 'item:test_grove.herb' }, container: 'inventory', qty: 99,
    definition: 'item:test_grove.herb' },
];

afterEach(() => cleanup());

describe('RunBagPanel', () => {
  it('renders stack, unique gear and gold separately for each instance', () => {
    render(<RunBagPanel holdings={holdings} onRefresh={() => {}} />);

    const first = screen.getByRole('article', { name: `Run bag ${FIRST}` });
    expect(within(first).getByText('4 items')).toBeDefined();
    expect(within(first).getByText('12 gold')).toBeDefined();
    expect(within(first).getByText('item:test_grove.herb')).toBeDefined();
    expect(within(first).getByText('item:rusty_sword')).toBeDefined();
    expect(within(first).getByText('×3')).toBeDefined();

    const second = screen.getByRole('article', { name: `Run bag ${SECOND}` });
    expect(within(second).getByText('2 items')).toBeDefined();
    expect(within(second).getByText('5 gold')).toBeDefined();
    expect(within(second).getAllByText('item:test_grove.herb')).toHaveLength(1);
    expect(screen.getAllByText('item:test_grove.herb')).toHaveLength(2);
    expect(screen.queryByText('99 items')).toBeNull();
  });

  it('shows the empty state and refreshes the inventory snapshot on request', () => {
    const onRefresh = vi.fn();
    render(<RunBagPanel holdings={[]} onRefresh={onRefresh} />);
    expect(screen.getByText('No live rewards are waiting in a run bag.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
