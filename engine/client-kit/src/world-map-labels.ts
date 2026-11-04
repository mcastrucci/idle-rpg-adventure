/**
 * Deterministic, game-agnostic label placement for map nodes. Everything here works in
 * screen pixels so the result tracks pan/zoom and the on-screen size of the map.
 */

export const LABEL_FONT_SIZE = 13;
export const LABEL_LINE_HEIGHT = 15;
export const LABEL_CHAR_WIDTH = 7;
export const LABEL_WRAP_CHARS = 14;
export const LABEL_MAX_WIDTH = 124;
const LABEL_PAD = 3;
const LABEL_NODE_GAP = 17;
const NODE_OBSTACLE_RADIUS = 14;
const EDGE_MARGIN = 4;
const TRUNCATED_CHARS = 9;

export interface LabelNode {
  id: string;
  label: string;
  /** Node centre in screen pixels, relative to the map canvas. */
  x: number;
  y: number;
  /** Higher wins. Equal priorities fall back to the input order. */
  priority: number;
  /** Preferred vertical side; the other side is tried next. */
  preferBelow: boolean;
}

export interface LabelBounds {
  width: number;
  height: number;
}

export interface LabelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type LabelSide = 'below' | 'above' | 'right' | 'left';

export interface LabelPlacement {
  id: string;
  visible: boolean;
  lines: readonly string[];
  truncated: boolean;
  side: LabelSide | null;
  /** Screen-space box (null when hidden). */
  box: LabelBox | null;
  /** Box centre and first-line baseline relative to the node centre, in screen pixels. */
  offsetX: number;
  baselineY: number;
}

export function wrapLabel(label: string, maxChars: number = LABEL_WRAP_CHARS): string[] {
  const words = label.trim().split(/\s+/).flatMap((word) => {
    if (word.length <= maxChars) return [word];
    const chunks: string[] = [];
    for (let index = 0; index < word.length; index += maxChars) chunks.push(word.slice(index, index + maxChars));
    return chunks;
  });
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function truncateLabel(label: string): string[] {
  const text = label.trim().replace(/\s+/g, ' ');
  return [text.length <= TRUNCATED_CHARS ? text : `${text.slice(0, TRUNCATED_CHARS - 1)}…`];
}

function measure(lines: readonly string[]): { width: number; height: number } {
  const chars = Math.max(0, ...lines.map((line) => line.length));
  return {
    width: Math.min(LABEL_MAX_WIDTH, chars * LABEL_CHAR_WIDTH) + LABEL_PAD * 2,
    height: lines.length * LABEL_LINE_HEIGHT + LABEL_PAD * 2,
  };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function inside(box: LabelBox, bounds: LabelBounds): boolean {
  return box.left >= 0 && box.top >= 0 && box.left + box.width <= bounds.width && box.top + box.height <= bounds.height;
}

function candidateBox(node: LabelNode, side: LabelSide, size: { width: number; height: number }, bounds: LabelBounds): LabelBox {
  let left: number;
  let top: number;
  if (side === 'below' || side === 'above') {
    left = node.x - size.width / 2;
    top = side === 'below' ? node.y + LABEL_NODE_GAP : node.y - LABEL_NODE_GAP - size.height;
    // Slide horizontally to stay inside the viewport.
    left = Math.max(EDGE_MARGIN, Math.min(left, bounds.width - EDGE_MARGIN - size.width));
  } else {
    left = side === 'right' ? node.x + LABEL_NODE_GAP - 4 : node.x - LABEL_NODE_GAP + 4 - size.width;
    top = node.y - size.height / 2;
  }
  return { left, top, width: size.width, height: size.height };
}

/**
 * Greedy placement in priority order: each label takes the first candidate side that stays
 * inside the bounds and clears every already-placed label and every other node marker. If none
 * fits, a shortened single-line variant is tried before the label is hidden. Nodes and their
 * accessible names are never affected; only the visual label is omitted.
 */
export function placeNodeLabels(nodes: readonly LabelNode[], bounds: LabelBounds): Map<string, LabelPlacement> {
  const order = nodes.map((node, index) => ({ node, index }))
    .sort((left, right) => right.node.priority - left.node.priority || left.index - right.index)
    .map((entry) => entry.node);
  const placed: LabelBox[] = [];
  const result = new Map<string, LabelPlacement>();

  for (const node of order) {
    const obstacles = nodes.filter((other) => other.id !== node.id).map((other): LabelBox => ({
      left: other.x - NODE_OBSTACLE_RADIUS,
      top: other.y - NODE_OBSTACLE_RADIUS,
      width: NODE_OBSTACLE_RADIUS * 2,
      height: NODE_OBSTACLE_RADIUS * 2,
    }));
    const sides: LabelSide[] = node.preferBelow ? ['below', 'above', 'right', 'left'] : ['above', 'below', 'right', 'left'];
    const variants = [
      { lines: wrapLabel(node.label), truncated: false },
      { lines: truncateLabel(node.label), truncated: true },
    ];
    let found: LabelPlacement | undefined;
    search: for (const variant of variants) {
      const size = measure(variant.lines);
      for (const side of sides) {
        const box = candidateBox(node, side, size, bounds);
        if (!inside(box, bounds)) continue;
        if (placed.some((other) => overlaps(box, other)) || obstacles.some((other) => overlaps(box, other))) continue;
        found = {
          id: node.id,
          visible: true,
          lines: variant.lines,
          truncated: variant.truncated,
          side,
          box,
          offsetX: box.left + box.width / 2 - node.x,
          baselineY: box.top + LABEL_PAD + LABEL_FONT_SIZE * 0.85 - node.y,
        };
        placed.push(box);
        break search;
      }
    }
    result.set(node.id, found ?? {
      id: node.id,
      visible: false,
      lines: [],
      truncated: false,
      side: null,
      box: null,
      offsetX: 0,
      baselineY: 0,
    });
  }
  return result;
}
