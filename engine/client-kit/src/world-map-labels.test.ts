import { describe, expect, it } from 'vitest';

import { placeNodeLabels } from './world-map-labels.ts';
import type { LabelNode, LabelPlacement } from './world-map-labels.ts';

const bounds = { width: 360, height: 223 };

function node(id: string, x: number, y: number, extra: Partial<LabelNode> = {}): LabelNode {
  return { id, label: id, x, y, priority: 0, preferBelow: true, ...extra };
}

function visibleBoxes(result: Map<string, LabelPlacement>) {
  return [...result.values()].flatMap((placement) => (placement.visible && placement.box ? [placement.box] : []));
}

function anyOverlap(boxes: ReturnType<typeof visibleBoxes>): boolean {
  return boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height));
}

describe('placeNodeLabels', () => {
  it('keeps the preferred side when nothing collides', () => {
    const result = placeNodeLabels([node('A', 100, 100), node('B', 250, 100, { preferBelow: false })], bounds);
    expect(result.get('A')?.side).toBe('below');
    expect(result.get('B')?.side).toBe('above');
    expect(result.get('A')?.baselineY).toBeGreaterThan(0);
    expect(result.get('B')?.baselineY).toBeLessThan(0);
  });

  it('never overlaps visible labels for crowded nodes', () => {
    const nodes = [node('Sanctuary', 150, 100), node('Test Grove', 214, 100), node('The Verdant Hollow', 182, 110, { priority: 5 })];
    const result = placeNodeLabels(nodes, bounds);
    expect(anyOverlap(visibleBoxes(result))).toBe(false);
    expect([...result.values()].some((placement) => placement.visible)).toBe(true);
  });

  it('hides lower-priority labels when no candidate fits and the winner stays visible', () => {
    const nodes = [node('Alpha', 180, 100, { priority: 1 }), node('Beta', 184, 102, { priority: 10 }), node('Gamma', 178, 99, { priority: 5 })];
    const result = placeNodeLabels(nodes, bounds);
    expect(result.get('Beta')?.visible).toBe(true);
    expect(result.get('Beta')?.truncated).toBe(false);
    expect(anyOverlap(visibleBoxes(result))).toBe(false);
    expect([...result.values()].some((placement) => !placement.visible)).toBe(true);
  });

  it('prefers higher priority regardless of input order', () => {
    const result = placeNodeLabels([node('A', 100, 100, { priority: 0 }), node('B', 100, 100, { priority: 9 })], bounds);
    expect(result.get('B')?.side).toBe('below');
    expect(result.get('A')?.side).not.toBe('below');
  });

  it('truncates to a single line before hiding', () => {
    const label = 'Alpha Beta Gamma Delta Epsilon';
    const result = placeNodeLabels([node(label, 95, 30)], { width: 180, height: 60 });
    const placement = result.get(label);
    expect(placement?.visible).toBe(true);
    expect(placement?.truncated).toBe(true);
    expect(placement?.lines).toHaveLength(1);
    expect(placement?.lines[0]?.endsWith('…')).toBe(true);
  });

  it('clamps labels inside the viewport at the edges', () => {
    const result = placeNodeLabels([node('Leftmost Place', 4, 100), node('Rightmost Place', 358, 100, { preferBelow: false })], bounds);
    for (const box of visibleBoxes(result)) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(bounds.width);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.top + box.height).toBeLessThanOrEqual(bounds.height);
    }
    expect(visibleBoxes(result)).toHaveLength(2);
  });

  it('is deterministic and restores labels once nodes separate', () => {
    const close = [node('Sanctuary', 150, 100), node('Test Grove', 153, 100), node('Hollow', 151, 103), node('Moor', 152, 98), node('Fen', 149, 102)];
    expect(placeNodeLabels(close, bounds)).toEqual(placeNodeLabels(close, bounds));
    expect([...placeNodeLabels(close, bounds).values()].some((placement) => !placement.visible)).toBe(true);
    const apart = [node('Sanctuary', 40, 60), node('Test Grove', 180, 60), node('Hollow', 300, 160)];
    expect([...placeNodeLabels(apart, bounds).values()].every((placement) => placement.visible)).toBe(true);
  });
});
