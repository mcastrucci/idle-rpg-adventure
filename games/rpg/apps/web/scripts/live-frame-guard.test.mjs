import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertInside, assertNoDocumentScroll, assertRectsStable, assertTapTargets, rectDelta } from './live-frame-guard.mjs';

const rect = (x, y, width, height) => ({ x, y, width, height });

test('rects within tolerance are stable, a moved or missing control fails', () => {
  assert.ok(Math.abs(rectDelta(rect(0, 0, 10, 10), rect(0.2, 0, 10, 10.3)) - 0.3) < 1e-9);
  assertRectsStable({ skill: rect(0, 100, 150, 48) }, { skill: rect(0, 100.4, 150, 48) });
  assert.throws(() => assertRectsStable({ skill: rect(0, 100, 150, 48) }, { skill: rect(0, 104, 150, 48) }), /moved by 4\.00px/);
  assert.throws(() => assertRectsStable({ skill: rect(0, 0, 1, 1) }, {}), /disappeared/);
  assert.throws(() => assertRectsStable({ a: rect(0, 0, 1, 1) }, { a: rect(0, 0, 1, 1), b: rect(0, 0, 1, 1) }), /b appeared/);
  assert.throws(() => assertRectsStable({}, {}), /nothing was measured/);
});

test('the document may not scroll in either direction', () => {
  assertNoDocumentScroll({ scrollHeight: 780, scrollWidth: 360, innerHeight: 780, innerWidth: 360 });
  assert.throws(() => assertNoDocumentScroll({ scrollHeight: 781, scrollWidth: 360, innerHeight: 780, innerWidth: 360 }), /vertically/);
  assert.throws(() => assertNoDocumentScroll({ scrollHeight: 780, scrollWidth: 361, innerHeight: 780, innerWidth: 360 }), /horizontally/);
});

test('tap targets under 44px are reported by name', () => {
  assertTapTargets([{ name: 'skill', width: 160, height: 49 }, { name: 'auto', width: 44, height: 44 }]);
  assert.throws(() => assertTapTargets([{ name: 'back', width: 30, height: 44 }]), /back 30\.0x44\.0/);
});

test('rects that stick out of the frame are reported', () => {
  const frame = rect(0, 0, 360, 780);
  assertInside(frame, { ok: rect(8, 8, 344, 44) });
  assert.throws(() => assertInside(frame, { wide: rect(8, 8, 360, 44) }), /wide/);
});
