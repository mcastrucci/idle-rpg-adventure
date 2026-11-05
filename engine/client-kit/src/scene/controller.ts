/**
 * Renderer-agnostic lifecycle of the scene viewport: texture residency, preload-before-transition, resize, reduced
 * motion, visibility pause, context loss and tap hit-testing. The GPU work is behind `SceneBackend`.
 */
import { documentVisibility } from './backend.ts';
import type { PreparedScene, SceneBackend, VisibilitySource } from './backend.ts';
import { clampResolution, coverFit, hitRegion } from './geometry.ts';
import type { Size } from './geometry.ts';
import { SCENE_BUDGET } from './types.ts';
import type {
  SceneRegion, SceneRenderer, SceneRendererEvents, SceneRendererEventType, SceneRendererMode, SceneSpec, SceneTransitionResult,
} from './types.ts';

export interface SceneControllerOptions {
  readonly visibility?: VisibilitySource;
  /** Device pixel ratio provider; capped at `SCENE_BUDGET.maxResolution`. */
  readonly devicePixelRatio?: () => number;
  readonly now?: () => number;
  readonly transitionMs?: number;
}

interface Resident { readonly spec: SceneSpec; readonly scene: PreparedScene }

export class SceneController implements SceneRenderer {
  mode: SceneRendererMode = 'fallback';

  private readonly visibility: VisibilitySource;
  private readonly dpr: () => number;
  private readonly now: () => number;
  private readonly transitionMs: number;
  private readonly listeners = new Map<SceneRendererEventType, Set<(event: never) => void>>();
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private size: Size = { width: 1, height: 1 };
  private resident: Resident | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private token = 0;
  private reducedMotion = false;
  private contextLost = false;
  private destroyed = false;
  private cleanup: (() => void)[] = [];

  private readonly backend: SceneBackend;

  constructor(backend: SceneBackend, options: SceneControllerOptions = {}) {
    this.backend = backend;
    this.visibility = options.visibility ?? documentVisibility;
    this.dpr = options.devicePixelRatio ?? (() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio));
    this.now = options.now ?? (() => performance.now());
    this.transitionMs = Math.min(options.transitionMs ?? SCENE_BUDGET.transitionMs, 1000);
  }

  async mount(container: HTMLElement): Promise<SceneRendererMode> {
    if (this.destroyed || this.container) return this.mode;
    this.size = measure(container);
    let canvas: HTMLCanvasElement;
    try {
      canvas = await this.backend.init(this.size, clampResolution(this.dpr(), SCENE_BUDGET.maxResolution), {
        onContextLost: () => { this.contextLost = true; this.emit('contextLost', {}); },
        onContextRestored: () => {
          this.contextLost = false;
          this.backend.recover();
          this.emit('contextRestored', {});
        },
      });
    } catch {
      this.backend.destroy();
      return this.mode;
    }
    if (this.destroyed) { this.backend.destroy(); return this.mode; }
    this.container = container;
    this.canvas = canvas;
    this.mode = 'canvas';
    container.appendChild(canvas);

    const onClick = (event: MouseEvent) => this.onTap(event);
    container.addEventListener('click', onClick);
    this.cleanup.push(() => container.removeEventListener('click', onClick));
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect) this.resize(rect.width, rect.height);
      });
      observer.observe(container);
      this.cleanup.push(() => observer.disconnect());
    }
    this.cleanup.push(this.visibility.subscribe(() => this.backend.setActive(!this.visibility.isHidden())));
    this.backend.setActive(!this.visibility.isHidden());
    return this.mode;
  }

  loadScene(spec: SceneSpec): Promise<void> {
    if (this.mode !== 'canvas' || this.destroyed) return Promise.resolve();
    const token = ++this.token;
    return this.enqueue(async () => {
      if (token !== this.token) return;
      await this.swap(spec, token, false);
    });
  }

  transitionTo(spec: SceneSpec): Promise<SceneTransitionResult> {
    if (this.mode !== 'canvas' || this.destroyed) return Promise.resolve({ status: 'cut', prepareMs: 0, animationMs: 0 });
    const token = ++this.token;
    return this.enqueue(async () => {
      if (token !== this.token) return { status: 'skipped', prepareMs: 0, animationMs: 0 } as const;
      if (this.resident?.spec.id === spec.id) {
        this.setRegions(spec.regions);
        return { status: 'unchanged', prepareMs: 0, animationMs: 0 } as const;
      }
      return this.swap(spec, token, true);
    });
  }

  setRegions(regions: readonly SceneRegion[]): void {
    const resident = this.resident;
    if (!resident || this.destroyed) return;
    this.resident = { spec: { ...resident.spec, regions }, scene: resident.scene };
    this.backend.setRegions(resident.scene, regions);
  }

  resize(width: number, height: number): void {
    if (this.mode !== 'canvas' || this.destroyed) return;
    this.size = { width: Math.max(1, width), height: Math.max(1, height) };
    this.backend.resize(this.size);
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  on<K extends SceneRendererEventType>(type: K, listener: (event: SceneRendererEvents[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return () => { set.delete(listener as (event: never) => void); };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.token++;
    for (const stop of this.cleanup.splice(0)) stop();
    const resident = this.resident;
    this.resident = null;
    if (resident) this.backend.release(resident.scene);
    this.backend.destroy();
    this.canvas?.remove();
    this.canvas = null;
    this.container = null;
    this.listeners.clear();
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Prepare first (decode + GPU upload while the old scene is still on screen), only then change what is visible, and
   * release the previous textures last. At most two scenes are ever resident.
   */
  private async swap(spec: SceneSpec, token: number, animate: boolean): Promise<SceneTransitionResult> {
    const started = this.now();
    const next = await this.backend.prepare(spec);
    const prepareMs = this.now() - started;
    if (this.destroyed || token !== this.token) {
      this.backend.release(next);
      return { status: 'skipped', prepareMs, animationMs: 0 };
    }
    const previous = this.resident;
    let status: SceneTransitionResult['status'] = 'cut';
    const fadeStarted = this.now();
    if (previous && animate && !this.reducedMotion && !this.visibility.isHidden() && !this.contextLost) {
      await this.backend.fadeTo(previous.scene, next, this.transitionMs);
      status = 'completed';
    } else {
      this.backend.show(next);
    }
    const animationMs = status === 'completed' ? this.now() - fadeStarted : 0;
    if (this.destroyed) { this.backend.release(next); return { status: 'skipped', prepareMs, animationMs }; }
    this.resident = { spec, scene: next };
    if (previous) this.backend.release(previous.scene);
    return { status, prepareMs, animationMs };
  }

  private onTap(event: MouseEvent): void {
    const resident = this.resident;
    const container = this.container;
    if (!resident || !container) return;
    const rect = container.getBoundingClientRect();
    const fit = coverFit({ width: resident.spec.background.width, height: resident.spec.background.height }, this.size, resident.spec.framing);
    const region = hitRegion(resident.spec.regions, fit, event.clientX - rect.left, event.clientY - rect.top);
    if (region) this.emit('regionTap', { regionId: region.id });
  }

  private emit<K extends SceneRendererEventType>(type: K, event: SceneRendererEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (event: SceneRendererEvents[K]) => void)(event);
  }
}

function measure(container: HTMLElement): Size {
  const rect = container.getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}
