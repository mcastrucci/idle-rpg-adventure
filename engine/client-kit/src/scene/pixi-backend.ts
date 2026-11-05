/**
 * PixiJS v8 implementation of `SceneBackend` (ADR-0010). Only `lazy-backend.ts` imports this file, through a dynamic
 * `import()`, so the PixiJS chunk is fetched when a scene viewport is first mounted and never on the initial load.
 *
 * Rendering is on demand: the ticker only runs while a fade is in progress, and a still scene costs no frames.
 * WebGL is forced so context-loss handling is one code path.
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';

import type { BackendHooks, PreparedScene, SceneBackend } from './backend.ts';
import { coverFit, MIN_TAP_RADIUS } from './geometry.ts';
import type { CoverFit, SceneFraming, Size } from './geometry.ts';
import type { SceneImage, SceneImageData, SceneRegion, SceneSpec } from './types.ts';

interface PixiScene extends PreparedScene {
  readonly root: Container;
  readonly regionLayer: Graphics;
  readonly textures: readonly Texture[];
  readonly size: Size;
  regions: readonly SceneRegion[];
  framing: SceneFraming | undefined;
  released: boolean;
}

const REGION_COLOR = 0xffe9a8;

export class PixiBackend implements SceneBackend {
  private app: Application | null = null;
  private viewport: Size = { width: 1, height: 1 };
  private readonly scenes = new Set<PixiScene>();
  private readonly displayed = new Set<PixiScene>();
  private active = true;
  private lost = false;
  private finishFade: (() => void) | null = null;
  private stopListening: (() => void) | null = null;

  async init(size: Size, resolution: number, hooks: BackendHooks): Promise<HTMLCanvasElement> {
    const app = new Application();
    await app.init({
      preference: 'webgl',
      width: size.width,
      height: size.height,
      resolution,
      autoDensity: true,
      antialias: false,
      autoStart: false,
      sharedTicker: false,
      background: 0x000000,
      // Taps are hit-tested by the controller on the container; Pixi's event system stays off.
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    app.stage.eventMode = 'none';
    app.canvas.style.display = 'block';
    this.app = app;
    this.viewport = size;
    const onLost = (event: Event) => {
      event.preventDefault();
      this.lost = true;
      this.syncTicker();
      hooks.onContextLost();
    };
    const onRestored = () => {
      this.lost = false;
      this.syncTicker();
      hooks.onContextRestored();
    };
    app.canvas.addEventListener('webglcontextlost', onLost);
    app.canvas.addEventListener('webglcontextrestored', onRestored);
    this.stopListening = () => {
      app.canvas.removeEventListener('webglcontextlost', onLost);
      app.canvas.removeEventListener('webglcontextrestored', onRestored);
    };
    return app.canvas;
  }

  async prepare(spec: SceneSpec): Promise<PreparedScene> {
    const app = this.requireApp();
    const images: SceneImage[] = [spec.background, ...spec.layers.map((layer) => layer.image)];
    // Decode everything first (in parallel), so a failure leaves nothing half-built.
    const loaded = await Promise.allSettled(images.map((image) => image.load()));
    const failure = loaded.find((result) => result.status === 'rejected');
    if (failure) {
      for (const result of loaded) if (result.status === 'fulfilled') disposeData(result.value);
      throw failure.reason instanceof Error ? failure.reason : new Error('scene image failed to load');
    }
    const data = loaded.map((result) => (result as PromiseFulfilledResult<SceneImageData>).value);
    const textures = data.map((item) => Texture.from(item, true));
    // Upload now, while the previous scene is still on screen: this is what keeps the transition itself cheap.
    if (!this.lost) for (const texture of textures) app.renderer.texture.initSource(texture.source);

    const root = new Container();
    const [backgroundTexture, ...layerTextures] = textures as [Texture, ...Texture[]];
    root.addChild(new Sprite(backgroundTexture));
    spec.layers.forEach((layer, index) => {
      const sprite = new Sprite(layerTextures[index]);
      sprite.position.set(layer.x, layer.y);
      sprite.alpha = layer.alpha ?? 1;
      root.addChild(sprite);
    });
    const regionLayer = new Graphics();
    root.addChild(regionLayer);
    const scene: PixiScene = {
      id: spec.id, root, regionLayer, textures, regions: spec.regions, framing: spec.framing, released: false,
      size: { width: spec.background.width, height: spec.background.height },
    };
    this.scenes.add(scene);
    return scene;
  }

  show(prepared: PreparedScene): void {
    const scene = prepared as PixiScene;
    this.endFade();
    const app = this.requireApp();
    for (const other of this.displayed) if (other !== scene) app.stage.removeChild(other.root);
    this.displayed.clear();
    scene.root.alpha = 1;
    app.stage.addChild(scene.root);
    this.displayed.add(scene);
    this.layout(scene);
    this.render();
  }

  fadeTo(previous: PreparedScene, next: PreparedScene, durationMs: number): Promise<void> {
    const app = this.requireApp();
    const incoming = next as PixiScene;
    this.endFade();
    incoming.root.alpha = 0;
    app.stage.addChild(incoming.root);
    this.displayed.add(incoming);
    this.layout(incoming);
    this.render();
    return new Promise<void>((resolve) => {
      let elapsed = 0;
      const step = (ticker: { deltaMS: number }) => {
        elapsed += ticker.deltaMS;
        const k = Math.min(1, elapsed / durationMs);
        incoming.root.alpha = k * k * (3 - 2 * k);
        if (k >= 1) this.endFade();
      };
      this.finishFade = () => {
        app.ticker.remove(step);
        this.finishFade = null;
        this.syncTicker();
        app.stage.removeChild((previous as PixiScene).root);
        this.displayed.delete(previous as PixiScene);
        incoming.root.alpha = 1;
        this.render();
        resolve();
      };
      app.ticker.add(step);
      this.syncTicker();
    });
  }

  release(prepared: PreparedScene): void {
    const scene = prepared as PixiScene;
    if (scene.released) return;
    scene.released = true;
    this.scenes.delete(scene);
    this.displayed.delete(scene);
    scene.root.parent?.removeChild(scene.root);
    scene.root.destroy({ children: true });
    for (const texture of scene.textures) {
      const resource = texture.source.resource as unknown;
      texture.destroy(true);
      disposeData(resource);
    }
  }

  setRegions(prepared: PreparedScene, regions: readonly SceneRegion[]): void {
    const scene = prepared as PixiScene;
    scene.regions = regions;
    this.drawRegions(scene, this.fit(scene));
    this.render();
  }

  resize(size: Size): void {
    this.viewport = size;
    if (!this.app) return;
    this.app.renderer.resize(size.width, size.height);
    for (const scene of this.displayed) this.layout(scene);
    this.render();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.syncTicker();
    if (active) this.render();
  }

  recover(): void {
    this.render();
  }

  residentCount(): number {
    return this.scenes.size;
  }

  destroy(): void {
    this.endFade();
    this.stopListening?.();
    this.stopListening = null;
    for (const scene of [...this.scenes]) this.release(scene);
    this.displayed.clear();
    const app = this.app;
    this.app = null;
    app?.destroy(true, { children: true });
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private requireApp(): Application {
    if (!this.app) throw new Error('scene backend is not initialised');
    return this.app;
  }

  private endFade(): void {
    this.finishFade?.();
  }

  private syncTicker(): void {
    const app = this.app;
    if (!app) return;
    if (this.finishFade && this.active && !this.lost) app.ticker.start();
    else app.ticker.stop();
  }

  private render(): void {
    if (!this.app || !this.active || this.lost) return;
    this.app.render();
  }

  private fit(scene: PixiScene): CoverFit {
    return coverFit(scene.size, this.viewport, scene.framing);
  }

  private layout(scene: PixiScene): void {
    const fit = this.fit(scene);
    scene.root.scale.set(fit.scale);
    scene.root.position.set(fit.offsetX, fit.offsetY);
    this.drawRegions(scene, fit);
  }

  /** Rings sized in screen pixels: at least the minimum touch target, with a constant stroke width. */
  private drawRegions(scene: PixiScene, fit: CoverFit): void {
    const g = scene.regionLayer.clear();
    for (const region of scene.regions) {
      const radius = Math.max(region.radius, MIN_TAP_RADIUS / fit.scale);
      const alpha = region.enabled ? 1 : 0.35;
      g.circle(region.x, region.y, radius).fill({ color: REGION_COLOR, alpha: 0.16 * alpha })
        .stroke({ width: 3 / fit.scale, color: REGION_COLOR, alpha: 0.9 * alpha });
    }
  }
}

function disposeData(data: unknown): void {
  if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
}
