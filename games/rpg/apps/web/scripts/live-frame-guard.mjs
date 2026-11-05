// Pure assertions shared by live-frame-check.mjs (opt-in browser evidence for issue #176) and its unit test. They take
// plain measurements (rects, scroll sizes), so they run without a browser.

/** A CSS-pixel rectangle as `getBoundingClientRect()` reports it. */
const RECT_KEYS = ['x', 'y', 'width', 'height'];

/** Largest per-axis difference between two rects. */
export function rectDelta(a, b) {
  return Math.max(...RECT_KEYS.map((key) => Math.abs(a[key] - b[key])));
}

/** Throws unless every named rect is the same (within `tolerance` px) in `before` and `after`. */
export function assertRectsStable(before, after, tolerance = 0.5, label = 'rects') {
  const names = Object.keys(before);
  if (names.length === 0) throw new Error(`${label}: nothing was measured`);
  for (const name of names) {
    const other = after[name];
    if (!other) throw new Error(`${label}: ${name} disappeared`);
    const delta = rectDelta(before[name], other);
    if (delta > tolerance) throw new Error(`${label}: ${name} moved by ${delta.toFixed(2)}px (${JSON.stringify(before[name])} -> ${JSON.stringify(other)})`);
  }
  for (const name of Object.keys(after)) if (!(name in before)) throw new Error(`${label}: ${name} appeared`);
}

/** The document must not scroll: its scrollable height and width fit the viewport. */
export function assertNoDocumentScroll({ scrollHeight, scrollWidth, innerHeight, innerWidth }) {
  if (scrollHeight > innerHeight) throw new Error(`document scrolls vertically: scrollHeight ${scrollHeight} > innerHeight ${innerHeight}`);
  if (scrollWidth > innerWidth) throw new Error(`document scrolls horizontally: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
}

/** Every measured control is at least `min` px in both directions (WCAG 2.5.5 / ui-mobile.md tap targets). */
export function assertTapTargets(targets, min = 44) {
  const small = targets.filter((target) => target.width < min - 0.5 || target.height < min - 0.5);
  if (small.length > 0) throw new Error(`tap targets under ${min}px: ${small.map((t) => `${t.name} ${t.width.toFixed(1)}x${t.height.toFixed(1)}`).join(', ')}`);
}

/** Every rect lies inside the frame (nothing sticks out sideways or below). */
export function assertInside(frame, rects, tolerance = 1) {
  const outside = Object.entries(rects).filter(([, r]) => r.x < frame.x - tolerance || r.x + r.width > frame.x + frame.width + tolerance
    || r.y < frame.y - tolerance || r.y + r.height > frame.y + frame.height + tolerance);
  if (outside.length > 0) throw new Error(`outside the frame: ${outside.map(([name]) => name).join(', ')}`);
}
