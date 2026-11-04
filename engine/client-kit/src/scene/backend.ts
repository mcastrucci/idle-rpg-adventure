/**
 * What the lifecycle controller needs from a GPU renderer. Keeping it this small is what makes PixiJS replaceable
 * (ADR-0010 names Phaser as the alternative) and lets the lifecycle be tested without a GL context.
 */
import type { Size } from './geometry.ts';
import type { SceneRegion, SceneSpec } from './types.ts';

/** A scene whose images are decoded, uploaded to the GPU and owned by the backend until `release`. */
export interface PreparedScene {
  readonly id: string;
}

export interface BackendHooks {
  readonly onContextLost: () => void;
  readonly onContextRestored: () => void;
}

export interface SceneBackend {
  /** Creates the canvas. Rejects when no GPU context can be created. */
  init(size: Size, resolution: number, hooks: BackendHooks): Promise<HTMLCanvasElement>;
  /** Decodes every image of `spec` and uploads it to the GPU. The scene is not displayed yet. */
  prepare(spec: SceneSpec): Promise<PreparedScene>;
  /** Displays `scene` alone (any other displayed scene is detached, not destroyed). */
  show(scene: PreparedScene): void;
  /** Fades `next` in above `previous`, then leaves only `next` displayed. Resolves immediately when destroyed. */
  fadeTo(previous: PreparedScene, next: PreparedScene, durationMs: number): Promise<void>;
  /** Destroys the scene's display objects and textures. Safe to call once per scene, also after `destroy`. */
  release(scene: PreparedScene): void;
  setRegions(scene: PreparedScene, regions: readonly SceneRegion[]): void;
  resize(size: Size): void;
  /** False stops all rendering (hidden document); true resumes and repaints. */
  setActive(active: boolean): void;
  /** Called after the GPU context came back: repaints with re-uploaded textures. */
  recover(): void;
  /** Scenes whose textures are currently alive. */
  residentCount(): number;
  destroy(): void;
}

/** Document visibility, injectable so tests do not depend on the DOM. */
export interface VisibilitySource {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export const documentVisibility: VisibilitySource = {
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe(listener) {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};
