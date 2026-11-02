/**
 * Shared `SceneRenderer` plumbing. Engine adapters (PixiJS, Phaser) only implement texture loading, display-object
 * creation and a per-frame copy of the shared `SceneModel` into their display objects.
 */
import { SceneModel } from '../scene/model.ts';
import type {
  MountOptions,
  RendererStats,
  Rgba,
  SceneRenderer,
  SceneSpec,
  TextureInfo,
  TextureRef,
  TransitionKind,
  TransitionTiming,
} from '../scene/types.ts';

const TRANSITION_OUT_MS = 320;
const TRANSITION_IN_MS = 320;

export abstract class ModelRenderer implements SceneRenderer {
  abstract readonly id: 'pixi' | 'phaser';
  abstract readonly libraryVersion: string;

  protected readonly model = new SceneModel();
  protected resolution = 1;
  protected current: SceneSpec | null = null;
  private frames = 0;
  private frameWaiters: (() => void)[] = [];
  private sampleRequests: { x: number; y: number; resolve: (v: Rgba | null) => void }[] = [];
  private resizeObserver: ResizeObserver | null = null;

  // ---- engine hooks -------------------------------------------------------------------------------------------
  protected abstract createEngine(el: HTMLElement, cssWidth: number, cssHeight: number): Promise<void>;
  protected abstract resizeEngine(cssWidth: number, cssHeight: number): void;
  protected abstract loadTextures(refs: readonly TextureRef[]): Promise<void>;
  protected abstract unloadTextures(keys: readonly string[]): Promise<void>;
  protected abstract residentTextures(): TextureInfo[];
  protected abstract buildDisplay(spec: SceneSpec): void;
  protected abstract clearDisplay(): void;
  /** Copy `this.model` into display objects. Called once per frame before the engine renders. */
  protected abstract syncDisplay(): void;
  protected abstract destroyEngine(): void;
  abstract getCanvas(): HTMLCanvasElement;
  abstract getGl(): WebGLRenderingContext | WebGL2RenderingContext | null;

  // ---- SceneRenderer ------------------------------------------------------------------------------------------
  async mount(el: HTMLElement, options: MountOptions): Promise<void> {
    this.resolution = options.resolution;
    const rect = el.getBoundingClientRect();
    this.model.resize(rect.width, rect.height);
    await this.createEngine(el, rect.width, rect.height);
    this.resizeObserver = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      this.model.resize(r.width, r.height);
      this.resizeEngine(r.width, r.height);
    });
    this.resizeObserver.observe(el);
  }

  async loadScene(spec: SceneSpec): Promise<void> {
    await this.swap(spec);
  }

  async transitionTo(spec: SceneSpec, kind: TransitionKind): Promise<TransitionTiming> {
    const m = this.model;
    const t0 = performance.now();
    if (kind === 'fade') await m.animate(TRANSITION_OUT_MS, (k) => (m.overlayAlpha = k));
    else await m.animate(TRANSITION_OUT_MS, (k) => (m.slideX = -k * m.viewWidth));
    const t1 = performance.now();
    await this.swap(spec);
    const loadMs = performance.now() - t1;
    if (kind === 'fade') await m.animate(TRANSITION_IN_MS, (k) => (m.overlayAlpha = 1 - k));
    else await m.animate(TRANSITION_IN_MS, (k) => (m.slideX = (1 - k) * m.viewWidth));
    await this.nextFrame();
    return { kind, totalMs: performance.now() - t0, loadMs };
  }

  playHit(targetId: string, options?: { lethal?: boolean }): void {
    this.model.hit(targetId, options?.lethal ?? false);
  }

  playAttack(attackerId: string, targetId: string, options?: { lethal?: boolean }): void {
    this.model.attack(attackerId, targetId, options?.lethal ?? false);
  }

  setAutoBattle(enabled: boolean): void {
    this.model.autoBattle = enabled;
  }

  tap(cssX: number, cssY: number): ReturnType<SceneRenderer['tap']> {
    return this.model.tap(cssX, cssY);
  }

  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  samplePixel(cssX: number, cssY: number): Promise<Rgba | null> {
    return new Promise((resolve) => {
      const req = { x: cssX, y: cssY, resolve };
      this.sampleRequests.push(req);
      setTimeout(() => {
        const i = this.sampleRequests.indexOf(req);
        if (i >= 0) {
          this.sampleRequests.splice(i, 1);
          resolve(null);
        }
      }, 3000);
    });
  }

  stats(): RendererStats {
    const canvas = this.getCanvas();
    return {
      frames: this.frames,
      textures: this.residentTextures(),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      spriteCount: this.model.entities.length,
      particleCount: this.model.particleCount,
    };
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.destroyEngine();
  }

  // ---- helpers for adapters -----------------------------------------------------------------------------------
  /** Advance the shared model and copy it into display objects. */
  protected tick(dtMs: number): void {
    this.model.update(dtMs);
    this.syncDisplay();
  }

  /** Must be called by the adapter right after the engine finished rendering a frame. */
  protected afterRender(): void {
    const gl = this.getGl();
    if (!gl || gl.isContextLost()) return;
    this.frames++;
    if (this.sampleRequests.length > 0) {
      const canvas = this.getCanvas();
      const cssW = canvas.getBoundingClientRect().width || canvas.width;
      const ratio = canvas.width / cssW;
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const req of this.sampleRequests.splice(0)) {
        const px = new Uint8Array(4);
        const x = Math.min(canvas.width - 1, Math.max(0, Math.round(req.x * ratio)));
        const y = Math.min(canvas.height - 1, Math.max(0, canvas.height - 1 - Math.round(req.y * ratio)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        req.resolve([px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    }
    if (this.frameWaiters.length > 0) for (const w of this.frameWaiters.splice(0)) w();
  }

  private async swap(spec: SceneSpec): Promise<void> {
    const keep = new Set(spec.textures.map((t) => t.key));
    const old = this.current;
    this.clearDisplay();
    this.current = null;
    // One resident scene: release what the next scene does not use *before* loading it (peak-memory friendly).
    if (old) await this.unloadTextures(old.textures.filter((t) => !keep.has(t.key)).map((t) => t.key));
    const loaded = new Set(this.residentTextures().map((t) => t.key));
    await this.loadTextures(spec.textures.filter((t) => !loaded.has(t.key)));
    this.model.setScene(spec);
    this.buildDisplay(spec);
    this.current = spec;
  }
}
