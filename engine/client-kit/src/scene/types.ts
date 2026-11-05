/**
 * Generic scene viewport contract (ADR-0010). A `SceneRenderer` paints an illustrated background, optional layers and
 * tappable regions into a DOM container. It knows nothing about any game: scenes are described by images and
 * regions only, and a tap on a region is reported by ID so the host can issue the same command its DOM control does.
 */

import type { SceneFraming } from './geometry.ts';

/** Pixel sources the renderer accepts. The renderer owns (and releases) whatever `load` returns. */
export type SceneImageData = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;

/** An image that is produced on demand, so decoding happens in the preload step and not during the transition. */
export interface SceneImage {
  /** Stable key, used for diagnostics only. */
  readonly key: string;
  /** Pixel size of the decoded image; layout is computed from it before the image is loaded. */
  readonly width: number;
  readonly height: number;
  readonly load: () => Promise<SceneImageData>;
}

/** An extra image drawn above the background, positioned in scene (background) pixels. */
export interface SceneLayer {
  readonly id: string;
  readonly image: SceneImage;
  readonly x: number;
  readonly y: number;
  readonly alpha?: number;
}

/** A circular interactive region in scene pixels. A tap reports `id`; it never carries a result. */
export interface SceneRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Disabled regions are drawn dimmed and do not emit taps. */
  readonly enabled: boolean;
}

export interface SceneSpec {
  /** Scenes with the same ID are the same scene: transitioning to it only updates its regions. */
  readonly id: string;
  /** Drawn cover-fit (fills the viewport, centred); its pixel size defines the scene coordinate space. */
  readonly background: SceneImage;
  /** Optional focal point and quiet bands for the crop. Omitted means centred. */
  readonly framing?: SceneFraming;
  readonly layers: readonly SceneLayer[];
  readonly regions: readonly SceneRegion[];
}

export interface SceneRendererEvents {
  regionTap: { readonly regionId: string };
  contextLost: Record<string, never>;
  contextRestored: Record<string, never>;
}

export type SceneRendererEventType = keyof SceneRendererEvents;

/** `canvas`: a GPU canvas is mounted. `fallback`: nothing is drawn; the host keeps its DOM-only view. */
export type SceneRendererMode = 'canvas' | 'fallback';

export interface SceneTransitionResult {
  /**
   * `completed`: faded. `cut`: swapped instantly (reduced motion, hidden, context lost). `skipped`: superseded by a
   * newer call. `unchanged`: already showing that scene.
   */
  readonly status: 'completed' | 'cut' | 'skipped' | 'unchanged';
  /** Decode + upload of the next scene, before any visible change. */
  readonly prepareMs: number;
  /** Visible fade only. */
  readonly animationMs: number;
}

export interface SceneRenderer {
  readonly mode: SceneRendererMode;
  /** Creates the canvas inside `container`. Resolves `fallback` (never rejects) when WebGL is unavailable. */
  mount(container: HTMLElement): Promise<SceneRendererMode>;
  /** Shows a scene without animation, replacing whatever is resident. */
  loadScene(spec: SceneSpec): Promise<void>;
  /** Decodes and uploads the next scene before it is shown, then fades to it and releases the previous textures. */
  transitionTo(spec: SceneSpec): Promise<SceneTransitionResult>;
  /** Replaces the regions of the resident scene without reloading it. */
  setRegions(regions: readonly SceneRegion[]): void;
  /** Forces a size in CSS pixels. A mounted container is also observed, so calling this is rarely needed. */
  resize(width: number, height: number): void;
  /** When true every transition is an instant cut and nothing animates. */
  setReducedMotion(reduced: boolean): void;
  on<K extends SceneRendererEventType>(type: K, listener: (event: SceneRendererEvents[K]) => void): () => void;
  destroy(): void;
}

/** Rendering budget (docs/spec/ui-mobile.md section 3). */
export const SCENE_BUDGET = {
  /** DPR cap. */
  maxResolution: 2,
  /** Fade length; the whole visible transition must stay within 1 s. */
  transitionMs: 450,
  /** Resident scenes: the current one, plus the preloaded next one while a transition runs. */
  maxResidentScenes: 2,
} as const;
