/**
 * Renderer-agnostic scene description and the `SceneRenderer` contract both spike implementations satisfy.
 * The production client would keep React/DOM for all UI and mount one `SceneRenderer` for the scene viewport
 * (ADR-0010); this file is the spike's version of that seam.
 */

export interface TextureRef {
  readonly key: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Encoded (download) size in bytes. */
  readonly bytes: number;
}

export interface SpriteSpec {
  readonly id: string;
  readonly textureKey: string;
  /** Feet position in background pixels. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly side: 'party' | 'foes';
  /** Flying sprites bob more. */
  readonly flying: boolean;
  /** Particle tint for hits on this sprite. */
  readonly tint: number;
}

export interface HotspotSpec {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** Tap radius in background pixels. */
  readonly radius: number;
  /** Tapping an exit hotspot moves to the other scene. */
  readonly exit: boolean;
}

export interface SceneSpec {
  readonly id: string;
  readonly background: TextureRef;
  /** Every texture the scene needs (background, sprites, particle, hotspot). */
  readonly textures: readonly TextureRef[];
  readonly sprites: readonly SpriteSpec[];
  readonly hotspots: readonly HotspotSpec[];
  readonly particleKey: string;
  readonly hotspotKey: string;
  readonly particlesPerBurst: number;
  /** Milliseconds between automatic attacks in the demo choreography. */
  readonly attackIntervalMs: number;
}

export type TransitionKind = 'fade' | 'slide';

export interface TransitionTiming {
  readonly kind: TransitionKind;
  /** Call → new scene fully visible. */
  readonly totalMs: number;
  /** Texture unload + load + display rebuild while the screen is covered. */
  readonly loadMs: number;
}

export interface TextureInfo {
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

export interface RendererStats {
  /** Frames actually rendered (counted after the engine's render, only while the context is alive). */
  readonly frames: number;
  /** Textures currently resident in the engine (GPU-side estimate uses w×h×4). */
  readonly textures: readonly TextureInfo[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly spriteCount: number;
  readonly particleCount: number;
}

export type Rgba = readonly [number, number, number, number];

export interface MountOptions {
  /** Backing-store pixels per CSS pixel (same for both renderers, for a fair fill-rate comparison). */
  readonly resolution: number;
}

export interface SceneRenderer {
  readonly id: 'pixi' | 'phaser';
  readonly libraryVersion: string;
  mount(el: HTMLElement, options: MountOptions): Promise<void>;
  loadScene(spec: SceneSpec): Promise<void>;
  transitionTo(spec: SceneSpec, kind: TransitionKind): Promise<TransitionTiming>;
  /** Hit reaction on a sprite: flash + shake + particle burst; `lethal` plays the death fade (then respawns). */
  playHit(targetId: string, options?: { lethal?: boolean }): void;
  /** Lunge from attacker towards target, then `playHit`. */
  playAttack(attackerId: string, targetId: string, options?: { lethal?: boolean }): void;
  setAutoBattle(enabled: boolean): void;
  /** Taps in CSS pixels relative to the mount element. Returns what was hit, if anything. */
  tap(cssX: number, cssY: number): { kind: 'hotspot' | 'sprite'; id: string; exit: boolean } | null;
  /** Resolves after the next rendered frame. */
  nextFrame(): Promise<void>;
  /** Reads one pixel of the default framebuffer right after a render (CSS pixel coordinates). */
  samplePixel(cssX: number, cssY: number): Promise<Rgba | null>;
  stats(): RendererStats;
  getCanvas(): HTMLCanvasElement;
  getGl(): WebGLRenderingContext | WebGL2RenderingContext | null;
  destroy(): void;
}
