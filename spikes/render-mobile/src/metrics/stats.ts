/** Pure metrics helpers (no DOM) — unit-tested in `stats.test.ts`. */

export interface FrameSummary {
  readonly frames: number;
  readonly durationMs: number;
  /** frames / seconds. */
  readonly fpsAvg: number;
  /** Average FPS over the slowest 1 % of frames (1000 / mean of the worst 1 % frame times). */
  readonly fps1Low: number;
  readonly frameTimeP50: number;
  readonly frameTimeP95: number;
  readonly frameTimeMax: number;
  /** Frames longer than 50 ms (visible hitches). */
  readonly longFrames: number;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[i] ?? 0;
}

export function summarizeFrames(frameTimes: readonly number[]): FrameSummary {
  const n = frameTimes.length;
  if (n === 0) {
    return { frames: 0, durationMs: 0, fpsAvg: 0, fps1Low: 0, frameTimeP50: 0, frameTimeP95: 0, frameTimeMax: 0, longFrames: 0 };
  }
  const sorted = [...frameTimes].sort((a, b) => a - b);
  let total = 0;
  let longFrames = 0;
  for (const t of frameTimes) {
    total += t;
    if (t > 50) longFrames++;
  }
  const worstCount = Math.max(1, Math.ceil(n * 0.01));
  let worstTotal = 0;
  for (let i = n - worstCount; i < n; i++) worstTotal += sorted[i] ?? 0;
  const worstMean = worstTotal / worstCount;
  return {
    frames: n,
    durationMs: total,
    fpsAvg: total > 0 ? (n * 1000) / total : 0,
    fps1Low: worstMean > 0 ? 1000 / worstMean : 0,
    frameTimeP50: percentile(sorted, 50),
    frameTimeP95: percentile(sorted, 95),
    frameTimeMax: sorted[n - 1] ?? 0,
    longFrames,
  };
}

/** Fixed-window ring of recent frame times for the live HUD. */
export class FrameWindow {
  private readonly times: number[] = [];
  private total = 0;
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  push(frameMs: number): void {
    this.times.push(frameMs);
    this.total += frameMs;
    while (this.total > this.windowMs && this.times.length > 1) this.total -= this.times.shift() ?? 0;
  }

  clear(): void {
    this.times.length = 0;
    this.total = 0;
  }

  summary(): FrameSummary {
    return summarizeFrames(this.times);
  }
}

/** Uncompressed RGBA estimate of GPU texture memory (no mipmaps). */
export function textureBytes(textures: readonly { readonly width: number; readonly height: number }[]): number {
  let sum = 0;
  for (const t of textures) sum += t.width * t.height * 4;
  return sum;
}

export function mib(bytes: number | null | undefined): number | null {
  return bytes === null || bytes === undefined ? null : Math.round((bytes / 1048576) * 10) / 10;
}

export function kib(bytes: number | null | undefined): number | null {
  return bytes === null || bytes === undefined ? null : Math.round(bytes / 1024);
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ---- report ----------------------------------------------------------------------------------------------------

export interface BenchmarkResult {
  readonly label: string;
  readonly stress: boolean;
  readonly durationMs: number;
  readonly frames: FrameSummary;
  readonly jsHeapPeakMiB: number | null;
  readonly textureMiB: number | null;
  readonly peakParticles: number;
  readonly sprites: number;
}

export interface ContextLossTest {
  readonly pass: boolean;
  readonly reason: string;
  readonly lostEventMs: number | null;
  readonly restoredEventMs: number | null;
  readonly firstFrameAfterRestoreMs: number | null;
}

export interface Report {
  readonly kit: 'render-mobile-spike';
  readonly kitVersion: number;
  readonly capturedAt: string;
  readonly renderer: { readonly id: string; readonly version: string };
  readonly variant: { readonly format: string; readonly stress: boolean; readonly resolution: number };
  readonly device: Readonly<Record<string, string | number | boolean | null>>;
  readonly load: {
    readonly toFirstFrameMs: number | null;
    readonly rendererInitMs: number | null;
    readonly sceneLoadMs: number | null;
    readonly imageBytes: number | null;
    /** JS bytes transferred for this page (Resource Timing; n/a when the browser does not report it). */
    readonly jsBytes: number | null;
    /** JS bundle for this page from the build (`build-info.json`): raw and gzip bytes. */
    readonly bundleRawBytes: number | null;
    readonly bundleGzipBytes: number | null;
  };
  readonly live: FrameSummary;
  readonly benchmarks: readonly BenchmarkResult[];
  readonly transitions: {
    readonly count: number;
    readonly lastMs: number | null;
    readonly avgMs: number | null;
    readonly maxMs: number | null;
    readonly lastLoadMs: number | null;
  };
  readonly memory: {
    readonly jsHeapUsedMiB: number | null;
    readonly jsHeapPeakMiB: number | null;
    readonly textureMiB: number;
    readonly framebufferMiB: number;
  };
  readonly contextLoss: {
    readonly lostEvents: number;
    readonly restoredEvents: number;
    readonly tests: readonly ContextLossTest[];
  };
  readonly visibility: {
    readonly hiddenCount: number;
    readonly visibleCount: number;
    readonly lastHiddenMs: number | null;
    readonly resumedAfterLastReturn: boolean | null;
    readonly firstFrameAfterReturnMs: number | null;
    readonly contextLostWhileHidden: number;
  };
  readonly audio: Readonly<Record<string, string | boolean | null>>;
  readonly errors: readonly string[];
}

function fmt(v: number | string | boolean | null | undefined, unit = ''): string {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') return `${round1(v)}${unit}`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return v.replace(/\|/g, '\\|');
}

function passFail(tests: readonly ContextLossTest[]): string {
  if (tests.length === 0) return 'not run';
  const last = tests[tests.length - 1];
  const passed = tests.filter((t) => t.pass).length;
  return `${last?.pass ? 'PASS' : 'FAIL'} (${passed}/${tests.length} passed${last && !last.pass ? `: ${last.reason}` : ''})`;
}

/** Markdown for pasting into the GitHub issue. */
export function toMarkdown(r: Report): string {
  const d = r.device;
  const rows: [string, string][] = [
    ['Renderer', `${r.renderer.id} ${r.renderer.version}`],
    ['Variant', `${r.variant.format}, resolution ${r.variant.resolution}${r.variant.stress ? ', stress' : ''}`],
    ['Device / UA', fmt(d['userAgent'] as string | null)],
    ['Screen (CSS) × DPR', `${fmt(d['screen'] as string | null)} × ${fmt(d['devicePixelRatio'] as number | null)}`],
    ['GPU', `${fmt(d['webglVersion'] as string | null)} — ${fmt(d['gpuRenderer'] as string | null)}`],
    ['Max texture size', fmt(d['maxTextureSize'] as number | null)],
    ['Shell', fmt(d['shell'] as string | null)],
    ['Load → first frame', fmt(r.load.toFirstFrameMs, ' ms')],
    ['Renderer init / scene load', `${fmt(r.load.rendererInitMs, ' ms')} / ${fmt(r.load.sceneLoadMs, ' ms')}`],
    ['JS transferred / scene images (encoded)', `${fmt(mib(r.load.jsBytes), ' MiB')} / ${fmt(mib(r.load.imageBytes), ' MiB')}`],
    ['JS bundle raw / gzip (incl. lazy chunks)', `${fmt(kib(r.load.bundleRawBytes), ' KiB')} / ${fmt(kib(r.load.bundleGzipBytes), ' KiB')}`],
    ['Live FPS avg / 1% low', `${fmt(r.live.fpsAvg)} / ${fmt(r.live.fps1Low)}`],
    ['Live frame p50 / p95', `${fmt(r.live.frameTimeP50, ' ms')} / ${fmt(r.live.frameTimeP95, ' ms')}`],
    ['Transitions (n, avg, max, last load)', `${r.transitions.count}, ${fmt(r.transitions.avgMs, ' ms')}, ${fmt(r.transitions.maxMs, ' ms')}, ${fmt(r.transitions.lastLoadMs, ' ms')}`],
    ['JS heap used / peak', `${fmt(r.memory.jsHeapUsedMiB, ' MiB')} / ${fmt(r.memory.jsHeapPeakMiB, ' MiB')}`],
    ['Texture memory (est.)', fmt(r.memory.textureMiB, ' MiB')],
    ['Framebuffer (est.)', fmt(r.memory.framebufferMiB, ' MiB')],
    ['Context lost / restored events', `${r.contextLoss.lostEvents} / ${r.contextLoss.restoredEvents}`],
    ['Context-loss recovery', passFail(r.contextLoss.tests)],
    ['Background / foreground', `${r.visibility.hiddenCount} / ${r.visibility.visibleCount}`],
    ['Rendering resumed after return', fmt(r.visibility.resumedAfterLastReturn)],
    ['First frame after return', fmt(r.visibility.firstFrameAfterReturnMs, ' ms')],
    ['Context lost while hidden', fmt(r.visibility.contextLostWhileHidden)],
    ['Audio', Object.entries(r.audio).map(([k, v]) => `${k}=${fmt(v)}`).join(', ') || 'not tested'],
  ];
  const lines = [
    `### Spike 2 results — ${r.renderer.id} (${r.variant.format}${r.variant.stress ? ', stress' : ''}) — ${r.capturedAt}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ];
  if (r.benchmarks.length > 0) {
    lines.push(
      '',
      '| Benchmark | Sprites | FPS avg | 1% low | p50 ms | p95 ms | max ms | >50 ms | heap peak MiB | tex MiB | peak particles |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...r.benchmarks.map(
        (b) =>
          `| ${b.label} (${round1(b.durationMs / 1000)} s) | ${b.sprites} | ${fmt(b.frames.fpsAvg)} | ${fmt(b.frames.fps1Low)} | ` +
          `${fmt(b.frames.frameTimeP50)} | ${fmt(b.frames.frameTimeP95)} | ${fmt(b.frames.frameTimeMax)} | ${b.frames.longFrames} | ` +
          `${fmt(b.jsHeapPeakMiB)} | ${fmt(b.textureMiB)} | ${b.peakParticles} |`,
      ),
    );
  }
  if (r.errors.length > 0) lines.push('', `Errors: ${r.errors.map((e) => fmt(e)).join('; ')}`);
  return lines.join('\n');
}

/** Markdown table + collapsible JSON, ready to paste into a GitHub comment. */
export function toPasteText(r: Report): string {
  return `${toMarkdown(r)}\n\n<details><summary>JSON</summary>\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n\n</details>\n`;
}
