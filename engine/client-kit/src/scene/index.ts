import type { BackendHooks, PreparedScene, SceneBackend } from './backend.ts';
import { SceneController } from './controller.ts';
import type { SceneControllerOptions } from './controller.ts';
import type { Size } from './geometry.ts';
import type { SceneRegion, SceneRenderer, SceneSpec } from './types.ts';

export { SCENE_BUDGET } from './types.ts';
export type {
  SceneImage, SceneImageData, SceneLayer, SceneRegion, SceneRenderer, SceneRendererEvents, SceneRendererEventType,
  SceneRendererMode, SceneSpec, SceneTransitionResult,
} from './types.ts';
export { clampResolution, coverFit, hitRegion, MIN_TAP_RADIUS } from './geometry.ts';
export type { CoverFit } from './geometry.ts';
export { SceneController } from './controller.ts';
export type { SceneControllerOptions } from './controller.ts';
export type { BackendHooks, PreparedScene, SceneBackend, VisibilitySource } from './backend.ts';

/** True when this browser can create a WebGL context. Cheap, and it never loads the renderer library. */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Backend that loads PixiJS on first use. When WebGL is missing it rejects `init` without fetching the library, and
 * the controller then reports `fallback`.
 */
export class LazyPixiBackend implements SceneBackend {
  private inner: SceneBackend | null = null;

  private readonly webglAvailable: () => boolean;

  constructor(webglAvailable: () => boolean = isWebGLAvailable) {
    this.webglAvailable = webglAvailable;
  }

  async init(size: Size, resolution: number, hooks: BackendHooks): Promise<HTMLCanvasElement> {
    if (!this.webglAvailable()) throw new Error('WebGL is not available');
    const { PixiBackend } = await import('./pixi-backend.ts');
    const backend = new PixiBackend();
    const canvas = await backend.init(size, resolution, hooks);
    this.inner = backend;
    return canvas;
  }

  private get backend(): SceneBackend {
    if (!this.inner) throw new Error('scene backend is not initialised');
    return this.inner;
  }

  prepare(spec: SceneSpec): Promise<PreparedScene> { return this.backend.prepare(spec); }
  show(scene: PreparedScene): void { this.backend.show(scene); }
  fadeTo(previous: PreparedScene, next: PreparedScene, durationMs: number): Promise<void> { return this.backend.fadeTo(previous, next, durationMs); }
  release(scene: PreparedScene): void { this.inner?.release(scene); }
  setRegions(scene: PreparedScene, regions: readonly SceneRegion[]): void { this.inner?.setRegions(scene, regions); }
  resize(size: Size): void { this.inner?.resize(size); }
  setActive(active: boolean): void { this.inner?.setActive(active); }
  recover(): void { this.inner?.recover(); }
  residentCount(): number { return this.inner?.residentCount() ?? 0; }
  destroy(): void { this.inner?.destroy(); this.inner = null; }
}

/** PixiJS scene renderer with automatic fallback: `mount` resolves `fallback` when WebGL or the library fails. */
export function createSceneRenderer(options: SceneControllerOptions = {}): SceneRenderer {
  return new SceneController(new LazyPixiBackend(), options);
}

/** A renderer that draws nothing: the host keeps its DOM-only view. For tests, SSR and the unsupported case. */
export function createNoopSceneRenderer(): SceneRenderer {
  return {
    mode: 'fallback',
    mount: () => Promise.resolve('fallback'),
    loadScene: () => Promise.resolve(),
    transitionTo: () => Promise.resolve({ status: 'cut', prepareMs: 0, animationMs: 0 }),
    setRegions: () => undefined,
    resize: () => undefined,
    setReducedMotion: () => undefined,
    on: () => () => undefined,
    destroy: () => undefined,
  };
}
