/**
 * Shared test harness for both renderer pages: mounts a `SceneRenderer`, measures frames with its own rAF loop
 * (identical for both libraries), and drives the on-screen metrics HUD, benchmark, context-loss test, visibility
 * tracking, audio unlock check and "copy results".
 */
import {
  type BenchmarkResult,
  type ContextLossTest,
  FrameWindow,
  type Report,
  mib,
  round1,
  summarizeFrames,
  textureBytes,
  toPasteText,
} from '../metrics/stats.ts';
import { type AssetManifest, type ImageFormat, loadManifest } from '../scene/manifest.ts';
import { type SceneId, buildScene, otherScene } from '../scene/specs.ts';
import type { Rgba, SceneRenderer, TransitionKind, TransitionTiming } from '../scene/types.ts';
import { collectDeviceInfo } from './device.ts';
import { copyText, saveReport } from './storage.ts';

const KIT_VERSION = 1;
const BENCHMARK_MS = 30_000;

interface BuildInfoEntry {
  rawBytes: number;
  gzipBytes: number;
}

interface PerfMemory {
  usedJSHeapSize: number;
}

function heapBytes(): number | null {
  const m = (performance as Performance & { memory?: PerfMemory }).memory;
  return m ? m.usedJSHeapSize : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, sleep(ms).then(() => null)]);
}

function waitForEvent(target: EventTarget, type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, on);
      resolve(false);
    }, ms);
    const on = (): void => {
      clearTimeout(timer);
      target.removeEventListener(type, on);
      resolve(true);
    };
    target.addEventListener(type, on);
  });
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function luma(c: Rgba): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function resourceBytes(match: (name: string) => boolean): number | null {
  let sum = 0;
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    if (match(e.name)) sum += e.encodedBodySize || e.transferSize || 0;
  }
  return sum > 0 ? sum : null;
}

const HUD_HTML = `
  <div class="hud-bar">
    <span class="hud-summary" data-ref="summary">…</span>
    <button type="button" class="hud-toggle" data-ref="toggle" aria-expanded="false">Panel ▾</button>
  </div>
  <div class="hud-panel" data-ref="panel" hidden>
    <dl class="hud-metrics" data-ref="metrics"></dl>
    <div class="hud-controls">
      <button type="button" data-action="bench">Benchmark 30 s</button>
      <button type="button" data-action="stress">Stress: OFF</button>
      <button type="button" data-action="fade">Escena (fade)</button>
      <button type="button" data-action="slide">Escena (slide)</button>
      <button type="button" data-action="ctxloss">Simular pérdida de contexto</button>
      <button type="button" data-action="auto">Auto-combate: ON</button>
      <button type="button" data-action="audio">Probar audio</button>
      <button type="button" data-action="copy" class="primary">Copiar resultados</button>
    </div>
    <div class="hud-variant">
      <label>Formato <select data-ref="format"><option value="webp">WebP</option><option value="png">PNG</option></select></label>
      <label>Resolución <select data-ref="res"><option value="1">1×</option><option value="2">2×</option><option value="native">nativa</option></select></label>
      <a href="./index.html">← Inicio</a>
    </div>
    <p class="hud-status" data-ref="status" role="status"></p>
    <textarea class="hud-results" data-ref="results" readonly rows="8" placeholder="Resultados (JSON + Markdown) aparecen aquí"></textarea>
  </div>`;

export async function runHarness(createRenderer: () => SceneRenderer): Promise<void> {
  const params = new URLSearchParams(location.search);
  const format: ImageFormat = params.get('format') === 'png' ? 'png' : 'webp';
  const resParam = params.get('res');
  const resolution =
    resParam === 'native' ? window.devicePixelRatio : resParam ? Number(resParam) || 1 : Math.min(window.devicePixelRatio, 2);
  let stress = params.get('stress') === '1';

  const stage = document.getElementById('stage');
  const hud = document.getElementById('hud');
  if (!stage || !hud) throw new Error('page is missing #stage or #hud');
  const stageEl: HTMLElement = stage;
  hud.innerHTML = HUD_HTML;
  const ref = <T extends HTMLElement>(name: string): T => {
    const el = hud.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) throw new Error(`HUD ref ${name}`);
    return el;
  };
  const btn = (action: string): HTMLButtonElement => {
    const el = hud.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!el) throw new Error(`HUD action ${action}`);
    return el;
  };
  const summaryEl = ref<HTMLSpanElement>('summary');
  const panel = ref<HTMLDivElement>('panel');
  const metricsEl = ref<HTMLDListElement>('metrics');
  const statusEl = ref<HTMLParagraphElement>('status');
  const resultsEl = ref<HTMLTextAreaElement>('results');
  const formatSel = ref<HTMLSelectElement>('format');
  const resSel = ref<HTMLSelectElement>('res');
  formatSel.value = format;
  resSel.value = resParam ?? (resolution === 1 ? '1' : '2');

  const errors: string[] = [];
  const status = (msg: string): void => {
    statusEl.textContent = msg;
  };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

  const toggleBtn = ref<HTMLButtonElement>('toggle');
  const setPanelOpen = (open: boolean): void => {
    panel.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.textContent = open ? 'Panel ▴' : 'Panel ▾';
  };
  toggleBtn.addEventListener('click', () => setPanelOpen(panel.hidden !== false));
  const reloadWith = (key: string, value: string): void => {
    const p = new URLSearchParams(location.search);
    p.set(key, value);
    location.search = p.toString();
  };
  formatSel.addEventListener('change', () => reloadWith('format', formatSel.value));
  resSel.addEventListener('change', () => reloadWith('res', resSel.value));

  // ---- audio (unlock rules) -------------------------------------------------------------------------------------
  const audio: Record<string, string | boolean | null> = { stateAtLoad: null, stateAfterTap: null, beepPlayed: null };
  let audioCtx: AudioContext | null = null;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audioCtx = Ctx ? new Ctx() : null;
    audio['stateAtLoad'] = audioCtx ? audioCtx.state : 'unsupported';
  } catch (e) {
    audio['stateAtLoad'] = `error: ${String(e)}`;
  }

  // ---- boot -----------------------------------------------------------------------------------------------------
  const device = collectDeviceInfo();
  let manifest: AssetManifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    status(String(e));
    throw e;
  }
  const buildInfo = await fetch('./build-info.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, BuildInfoEntry>>) : null))
    .catch(() => null);

  const renderer = createRenderer();
  document.title = `${renderer.id} — render spike`;
  const tMount0 = performance.now();
  await renderer.mount(stage, { resolution });
  const rendererInitMs = performance.now() - tMount0;
  let sceneId: SceneId = 'forest';
  const initialSpec = buildScene(sceneId, manifest, format, stress);
  // Encoded bytes of the first scene's images, from the manifest (Resource Timing misses worker fetches).
  const imageBytes = initialSpec.textures.reduce((sum, t) => sum + t.bytes, 0);
  const tLoad0 = performance.now();
  await renderer.loadScene(initialSpec);
  const sceneLoadMs = performance.now() - tLoad0;
  await renderer.nextFrame();
  // performance.now() is relative to navigation start, so this includes HTML/JS download and parse.
  const toFirstFrameMs = performance.now();
  const canvas = renderer.getCanvas();

  // ---- frame measurement (same rAF loop for both renderers) ----------------------------------------------------
  const live = new FrameWindow(5000);
  let lastFrame = performance.now();
  let skipNextFrame = true;
  let bench: { start: number; times: number[]; heapPeak: number | null; particlesPeak: number; stress: boolean } | null = null;
  const benchmarks: BenchmarkResult[] = [];
  let heapPeak: number | null = heapBytes();
  const loop = (now: number): void => {
    const dt = now - lastFrame;
    lastFrame = now;
    if (!skipNextFrame && dt > 0) {
      live.push(dt);
      bench?.times.push(dt);
    }
    skipNextFrame = false;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // ---- context loss counters ------------------------------------------------------------------------------------
  let lostEvents = 0;
  let restoredEvents = 0;
  let contextLostWhileHidden = 0;
  canvas.addEventListener('webglcontextlost', () => {
    lostEvents++;
    if (document.hidden) contextLostWhileHidden++;
  });
  canvas.addEventListener('webglcontextrestored', () => restoredEvents++);
  const contextTests: ContextLossTest[] = [];

  // ---- transitions ------------------------------------------------------------------------------------------------
  const transitions: TransitionTiming[] = [];
  let busy = false;
  const runExclusive = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) {
      status(`Ocupado (${label} en espera)…`);
      return;
    }
    busy = true;
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${String(e)}`);
      status(`Error en ${label}: ${String(e)}`);
    } finally {
      busy = false;
    }
  };
  const transition = (kind: TransitionKind, target: SceneId = otherScene(sceneId)): Promise<void> =>
    runExclusive('transición', async () => {
      const timing = await renderer.transitionTo(buildScene(target, manifest, format, stress), kind);
      sceneId = target;
      transitions.push(timing);
      status(`Transición ${kind}: ${round1(timing.totalMs)} ms (carga ${round1(timing.loadMs)} ms)`);
    });

  // ---- input ------------------------------------------------------------------------------------------------------
  stage.addEventListener('pointerdown', (e) => {
    const rect = stage.getBoundingClientRect();
    const hit = renderer.tap(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.kind === 'hotspot') {
      status(`Hotspot: ${hit.id}${hit.exit ? ' → cambio de escena' : ''}`);
      if (hit.exit) void transition('fade');
    } else status(`Golpe en ${hit.id}`);
  });

  // ---- visibility -------------------------------------------------------------------------------------------------
  let hiddenCount = 0;
  let visibleCount = 0;
  let hiddenAt = 0;
  let lastHiddenMs: number | null = null;
  let resumedAfterLastReturn: boolean | null = null;
  let firstFrameAfterReturnMs: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenCount++;
      hiddenAt = performance.now();
      skipNextFrame = true;
      if (bench) {
        bench = null;
        status('Benchmark cancelado: la app pasó a segundo plano. Repetirlo.');
      }
      return;
    }
    visibleCount++;
    const back = performance.now();
    lastHiddenMs = back - hiddenAt;
    skipNextFrame = true;
    const framesAtReturn = renderer.stats().frames;
    resumedAfterLastReturn = null;
    firstFrameAfterReturnMs = null;
    void withTimeout(renderer.nextFrame(), 5000).then((r) => {
      firstFrameAfterReturnMs = r === null ? null : performance.now() - back;
    });
    setTimeout(() => {
      resumedAfterLastReturn = renderer.stats().frames > framesAtReturn + 10;
      status(
        `Volvió de segundo plano tras ${round1((lastHiddenMs ?? 0) / 1000)} s — render ${resumedAfterLastReturn ? 'reanudado' : 'NO reanudado'}`,
      );
    }, 1500);
  });

  // ---- report -----------------------------------------------------------------------------------------------------
  const pageBundle = buildInfo?.[renderer.id] ?? null;
  const buildReport = (): Report => {
    const st = renderer.stats();
    const durations = transitions.map((t) => t.totalMs);
    return {
      kit: 'render-mobile-spike',
      kitVersion: KIT_VERSION,
      capturedAt: new Date().toISOString(),
      renderer: { id: renderer.id, version: renderer.libraryVersion },
      variant: { format, stress, resolution: round1(resolution) },
      device: { ...device, viewport: `${window.innerWidth}x${window.innerHeight}` },
      load: {
        toFirstFrameMs: round1(toFirstFrameMs),
        rendererInitMs: round1(rendererInitMs),
        sceneLoadMs: round1(sceneLoadMs),
        imageBytes,
        jsBytes: resourceBytes((n) => /\.m?js(\?|$)/.test(n)),
        bundleRawBytes: pageBundle?.rawBytes ?? null,
        bundleGzipBytes: pageBundle?.gzipBytes ?? null,
      },
      live: live.summary(),
      benchmarks: [...benchmarks],
      transitions: {
        count: transitions.length,
        lastMs: durations.length ? round1(durations[durations.length - 1] ?? 0) : null,
        avgMs: durations.length ? round1(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        maxMs: durations.length ? round1(Math.max(...durations)) : null,
        lastLoadMs: transitions.length ? round1(transitions[transitions.length - 1]?.loadMs ?? 0) : null,
      },
      memory: {
        jsHeapUsedMiB: mib(heapBytes()),
        jsHeapPeakMiB: mib(heapPeak),
        textureMiB: mib(textureBytes(st.textures)) ?? 0,
        framebufferMiB: mib(st.canvasWidth * st.canvasHeight * 4 * 2) ?? 0,
      },
      contextLoss: { lostEvents, restoredEvents, tests: [...contextTests] },
      visibility: {
        hiddenCount,
        visibleCount,
        lastHiddenMs: lastHiddenMs === null ? null : round1(lastHiddenMs),
        resumedAfterLastReturn,
        firstFrameAfterReturnMs: firstFrameAfterReturnMs === null ? null : round1(firstFrameAfterReturnMs),
        contextLostWhileHidden,
      },
      audio: { ...audio },
      errors: [...errors],
    };
  };
  const publish = (): string => {
    const report = buildReport();
    saveReport(report);
    const text = toPasteText(report);
    resultsEl.value = text;
    return text;
  };

  // ---- HUD refresh ------------------------------------------------------------------------------------------------
  const fmt = (v: number | null, unit = ''): string => (v === null ? 'n/a' : `${round1(v)}${unit}`);
  const refresh = (): void => {
    const heap = heapBytes();
    if (heap !== null) heapPeak = Math.max(heapPeak ?? 0, heap);
    const st = renderer.stats();
    if (bench) {
      if (heap !== null) bench.heapPeak = Math.max(bench.heapPeak ?? 0, heap);
      bench.particlesPeak = Math.max(bench.particlesPeak, st.particleCount);
    }
    const s = live.summary();
    const benchLeft = bench ? ` · BENCH ${Math.ceil((BENCHMARK_MS - (performance.now() - bench.start)) / 1000)} s` : '';
    summaryEl.textContent = `${renderer.id} ${format}${stress ? ' STRESS' : ''} · FPS ${fmt(s.fpsAvg)} (1% ${fmt(s.fps1Low)}) · p95 ${fmt(s.frameTimeP95, ' ms')}${benchLeft}`;
    if (panel.hidden) return;
    const lastT = transitions[transitions.length - 1];
    const lastCtx = contextTests[contextTests.length - 1];
    const rows: [string, string][] = [
      ['Renderer', `${renderer.id} ${renderer.libraryVersion}`],
      ['FPS avg / 1% low (5 s)', `${fmt(s.fpsAvg)} / ${fmt(s.fps1Low)}`],
      ['Frame p50 / p95 / max', `${fmt(s.frameTimeP50)} / ${fmt(s.frameTimeP95)} / ${fmt(s.frameTimeMax)} ms`],
      ['Load → 1st frame', `${fmt(toFirstFrameMs, ' ms')} (init ${fmt(rendererInitMs)} · escena ${fmt(sceneLoadMs)})`],
      ['Última transición', lastT ? `${fmt(lastT.totalMs, ' ms')} (${lastT.kind}, carga ${fmt(lastT.loadMs)})` : '—'],
      ['JS heap (peak)', heap === null ? 'n/a' : `${fmt(mib(heap), ' MiB')} (${fmt(mib(heapPeak), ' MiB')})`],
      ['Texturas (est. GPU)', `${fmt(mib(textureBytes(st.textures)), ' MiB')} · ${st.textures.length} tex`],
      ['Canvas', `${st.canvasWidth}×${st.canvasHeight} @${round1(resolution)}`],
      ['Sprites / partículas', `${st.spriteCount} / ${st.particleCount}`],
      ['Contexto perdido / restaurado', `${lostEvents} / ${restoredEvents}`],
      ['Test recuperación', lastCtx ? `${lastCtx.pass ? 'PASS' : 'FAIL'} — ${lastCtx.reason}` : 'no ejecutado'],
      ['Fondo / frente', `${hiddenCount} / ${visibleCount} · reanudó: ${resumedAfterLastReturn === null ? '—' : resumedAfterLastReturn ? 'sí' : 'NO'}`],
      ['Benchmarks', benchmarks.map((b) => `${b.label}: ${fmt(b.frames.fpsAvg)} fps`).join(' · ') || '—'],
      ['Audio', `${audio['stateAtLoad']} → ${audio['stateAfterTap'] ?? '—'}`],
    ];
    metricsEl.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  };
  setInterval(refresh, 500);
  refresh();

  // ---- actions ----------------------------------------------------------------------------------------------------
  btn('fade').addEventListener('click', () => void transition('fade'));
  btn('slide').addEventListener('click', () => void transition('slide'));
  btn('auto').addEventListener('click', (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const on = b.textContent?.endsWith('OFF') ?? false;
    renderer.setAutoBattle(on);
    b.textContent = `Auto-combate: ${on ? 'ON' : 'OFF'}`;
  });
  const stressBtn = btn('stress');
  stressBtn.textContent = `Stress: ${stress ? 'ON' : 'OFF'}`;
  stressBtn.addEventListener('click', () => {
    void runExclusive('stress', async () => {
      stress = !stress;
      stressBtn.textContent = `Stress: ${stress ? 'ON' : 'OFF'}`;
      const p = new URLSearchParams(location.search);
      p.set('stress', stress ? '1' : '0');
      history.replaceState(null, '', `?${p.toString()}`);
      await renderer.loadScene(buildScene(sceneId, manifest, format, stress));
      live.clear();
      status(`Stress ${stress ? 'activado (×2 sprites y partículas)' : 'desactivado'}`);
    });
  });

  const benchBtn = btn('bench');
  benchBtn.addEventListener('click', () => {
    if (bench) return;
    const current = { start: performance.now(), times: [] as number[], heapPeak: heapBytes(), particlesPeak: 0, stress };
    bench = current;
    benchBtn.disabled = true;
    // Collapse the DOM panel so its layout cost does not pollute the numbers; reopened with the results.
    setPanelOpen(false);
    status('Benchmark en curso (30 s): no tocar la pantalla ni cambiar de app…');
    setTimeout(() => {
      benchBtn.disabled = false;
      if (bench !== current) return; // cancelled
      bench = null;
      const st = renderer.stats();
      benchmarks.push({
        label: current.stress ? 'stress' : 'normal',
        stress: current.stress,
        durationMs: round1(performance.now() - current.start),
        frames: summarizeFrames(current.times),
        jsHeapPeakMiB: mib(current.heapPeak),
        textureMiB: mib(textureBytes(st.textures)),
        peakParticles: current.particlesPeak,
        sprites: st.spriteCount,
      });
      publish();
      setPanelOpen(true);
      const last = benchmarks[benchmarks.length - 1];
      status(`Benchmark listo: ${fmt(last?.frames.fpsAvg ?? null)} fps avg, 1% low ${fmt(last?.frames.fps1Low ?? null)}`);
    }, BENCHMARK_MS);
  });

  btn('ctxloss').addEventListener('click', () => {
    void runExclusive('pérdida de contexto', async () => {
      const result = await contextLossTest();
      contextTests.push(result);
      status(`Recuperación de contexto: ${result.pass ? 'PASS' : 'FAIL'} — ${result.reason}`);
      publish();
    });
  });

  btn('audio').addEventListener('click', () => {
    void (async () => {
      try {
        if (!audioCtx) throw new Error('Web Audio no disponible');
        await audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.15;
        osc.frequency.value = 660;
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
        audio['stateAfterTap'] = audioCtx.state;
        audio['beepPlayed'] = audioCtx.state === 'running';
        status(`Audio: ${audioCtx.state} (¿se escuchó el pitido? En iPhone, revisar el interruptor de silencio)`);
      } catch (e) {
        audio['stateAfterTap'] = `error: ${String(e)}`;
        audio['beepPlayed'] = false;
        status(String(e));
      }
    })();
  });

  btn('copy').addEventListener('click', () => {
    void (async () => {
      const text = publish();
      const ok = await copyText(text, resultsEl);
      status(ok ? 'Resultados copiados al portapapeles.' : 'No se pudo copiar: seleccionar el texto de abajo manualmente.');
    })();
  });

  // ---- context-loss test ------------------------------------------------------------------------------------------
  async function contextLossTest(): Promise<ContextLossTest> {
    const fail = (reason: string, extra: Partial<ContextLossTest> = {}): ContextLossTest => ({
      pass: false,
      reason,
      lostEventMs: null,
      restoredEventMs: null,
      firstFrameAfterRestoreMs: null,
      ...extra,
    });
    const gl = renderer.getGl();
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!gl || !ext) return fail('WEBGL_lose_context unavailable');
    const rect = stageEl.getBoundingClientRect();
    // Background-only sample points (sprites, hotspots and particles live lower in the scene).
    const points: [number, number][] = [
      [rect.width * 0.5, rect.height * 0.3],
      [rect.width * 0.35, rect.height * 0.22],
      [rect.width * 0.65, rect.height * 0.36],
    ];
    const sampleAll = async (): Promise<(Rgba | null)[]> => Promise.all(points.map(([x, y]) => renderer.samplePixel(x, y)));
    const before = await sampleAll();
    const framesBefore = renderer.stats().frames;
    const t0 = performance.now();
    const lost = waitForEvent(canvas, 'webglcontextlost', 3000);
    ext.loseContext();
    if (!(await lost)) return fail('no webglcontextlost event');
    const lostEventMs = round1(performance.now() - t0);
    await sleep(1000);
    const restored = waitForEvent(canvas, 'webglcontextrestored', 5000);
    ext.restoreContext();
    if (!(await restored)) return fail('no webglcontextrestored event', { lostEventMs });
    const restoredEventMs = round1(performance.now() - t0);
    const frame = await withTimeout(renderer.nextFrame(), 5000);
    if (frame === null) return fail('no frame rendered after restore', { lostEventMs, restoredEventMs });
    const firstFrameAfterRestoreMs = round1(performance.now() - t0);
    await sleep(500);
    const after = await sampleAll();
    const framesAfter = renderer.stats().frames;
    const extra = { lostEventMs, restoredEventMs, firstFrameAfterRestoreMs };
    if (framesAfter <= framesBefore + 5) return fail('rendering did not resume', extra);
    let compared = 0;
    for (let i = 0; i < points.length; i++) {
      const b = before[i];
      const a = after[i];
      if (!b || !a) continue;
      if (luma(b) < 12) continue; // too dark to prove anything
      compared++;
      if (colorDistance(a, b) > 60) {
        return fail(`pixel ${i} changed: before ${b.join(',')} after ${a.join(',')} (textures not restored?)`, extra);
      }
    }
    if (compared === 0) return { pass: true, reason: 'frames resumed; pixel check inconclusive (dark samples)', ...extra };
    return { pass: true, reason: `frames resumed, ${compared} background pixels match`, ...extra };
  }

  status(`Listo. Primer frame a los ${round1(toFirstFrameMs)} ms. Tocar hotspots/sprites para interactuar.`);
  (window as unknown as { __spike: unknown }).__spike = { renderer, buildReport, publish };
}
