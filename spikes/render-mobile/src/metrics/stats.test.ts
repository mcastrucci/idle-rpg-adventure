import { describe, expect, it } from 'vitest';

import { computeCover } from '../scene/math.ts';
import { FrameWindow, type Report, percentile, summarizeFrames, textureBytes, toMarkdown, toPasteText } from './stats.ts';

describe('frame statistics', () => {
  it('computes avg FPS, 1% low and percentiles', () => {
    // 99 frames at 10 ms and one 100 ms hitch.
    const times = [...Array.from({ length: 99 }, () => 10), 100];
    const s = summarizeFrames(times);
    expect(s.frames).toBe(100);
    expect(s.durationMs).toBe(1090);
    expect(s.fpsAvg).toBeCloseTo(100000 / 1090, 5);
    expect(s.fps1Low).toBe(10); // worst 1 % = the single 100 ms frame
    expect(s.frameTimeP50).toBe(10);
    expect(s.frameTimeP95).toBe(10);
    expect(s.frameTimeMax).toBe(100);
    expect(s.longFrames).toBe(1);
  });

  it('handles empty input', () => {
    expect(summarizeFrames([]).fpsAvg).toBe(0);
    expect(percentile([], 50)).toBe(0);
  });

  it('nearest-rank percentile', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });

  it('keeps only the configured time window', () => {
    const w = new FrameWindow(100);
    for (let i = 0; i < 50; i++) w.push(10);
    expect(w.summary().frames).toBe(10);
  });
});

describe('estimates and layout', () => {
  it('texture memory is w×h×4', () => {
    expect(textureBytes([{ width: 1536, height: 2048 }, { width: 2, height: 2 }])).toBe(1536 * 2048 * 4 + 16);
  });

  it('cover fills a portrait phone and centres the crop', () => {
    const c = computeCover(360, 740, 1536, 2048);
    expect(c.scale).toBeCloseTo(740 / 2048, 6);
    expect(c.offsetY).toBeCloseTo(0, 6);
    expect(c.offsetX).toBeLessThan(0);
    expect(c.offsetX * 2 + 1536 * c.scale).toBeCloseTo(360, 6);
  });
});

describe('report formatting', () => {
  const report: Report = {
    kit: 'render-mobile-spike',
    kitVersion: 1,
    capturedAt: '2026-11-02T00:00:00.000Z',
    renderer: { id: 'pixi', version: '8.22.0' },
    variant: { format: 'webp', stress: false, resolution: 2 },
    device: { userAgent: 'Test|UA', screen: '360x740', devicePixelRatio: 3 },
    load: { toFirstFrameMs: 812.34, rendererInitMs: 100, sceneLoadMs: 600, imageBytes: 2 * 1048576, jsBytes: null, bundleRawBytes: 2048, bundleGzipBytes: null },
    live: summarizeFrames([16, 17]),
    benchmarks: [
      {
        label: 'normal',
        stress: false,
        durationMs: 30000,
        frames: summarizeFrames([16, 16, 20]),
        jsHeapPeakMiB: null,
        textureMiB: 12.5,
        peakParticles: 40,
        sprites: 6,
      },
    ],
    transitions: { count: 0, lastMs: null, avgMs: null, maxMs: null, lastLoadMs: null },
    memory: { jsHeapUsedMiB: null, jsHeapPeakMiB: null, textureMiB: 12.5, framebufferMiB: 4 },
    contextLoss: {
      lostEvents: 1,
      restoredEvents: 1,
      tests: [{ pass: true, reason: 'ok', lostEventMs: 2, restoredEventMs: 1003, firstFrameAfterRestoreMs: 1020 }],
    },
    visibility: {
      hiddenCount: 0,
      visibleCount: 0,
      lastHiddenMs: null,
      resumedAfterLastReturn: null,
      firstFrameAfterReturnMs: null,
      contextLostWhileHidden: 0,
    },
    audio: {},
    errors: [],
  };

  it('renders a markdown table with n/a for missing values and escaped pipes', () => {
    const md = toMarkdown(report);
    expect(md).toContain('| Renderer | pixi 8.22.0 |');
    expect(md).toContain('| Load → first frame | 812.3 ms |');
    expect(md).toContain('Test\\|UA');
    expect(md).toContain('| JS transferred / scene images (encoded) | n/a / 2 MiB |');
    expect(md).toContain('| JS bundle raw / gzip (incl. lazy chunks) | 2 KiB / n/a |');
    expect(md).toContain('PASS (1/1 passed)');
    expect(md).toContain('| normal (30 s) | 6 |');
  });

  it('paste text embeds parseable JSON', () => {
    const text = toPasteText(report);
    const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json ?? '')).toEqual(report);
  });
});
