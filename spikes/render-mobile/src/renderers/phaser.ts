/**
 * Phaser 4 adapter. Phaser's own tweens/particles/input are deliberately not used: both renderers draw the same
 * shared model, so the numbers compare rendering cost. The canvas backing store is sized to CSS size × resolution
 * (Scale.NONE + zoom 1/resolution) to match PixiJS's `resolution`.
 */
import * as Phaser from 'phaser';

import type { SceneSpec, TextureInfo, TextureRef } from '../scene/types.ts';
import { ModelRenderer } from './base.ts';

interface EntityImages {
  body: Phaser.GameObjects.Image;
  flash: Phaser.GameObjects.Image;
}

export class PhaserSceneRenderer extends ModelRenderer {
  readonly id = 'phaser' as const;
  readonly libraryVersion = Phaser.VERSION;

  private game: Phaser.Game | null = null;
  private scene: Phaser.Scene | null = null;
  private world: Phaser.GameObjects.Container | null = null;
  private particleLayer: Phaser.GameObjects.Container | null = null;
  private overlay: Phaser.GameObjects.Rectangle | null = null;
  private entityImages: EntityImages[] = [];
  private hotspotImages: Phaser.GameObjects.Image[] = [];
  private particleImages: Phaser.GameObjects.Image[] = [];
  private readonly loadedKeys = new Set<string>();

  protected async createEngine(el: HTMLElement, cssWidth: number, cssHeight: number): Promise<void> {
    const onTick = (dt: number): void => this.tick(dt);
    let ready: (scene: Phaser.Scene) => void = () => undefined;
    const sceneReady = new Promise<Phaser.Scene>((resolve) => (ready = resolve));

    class SpikeScene extends Phaser.Scene {
      constructor() {
        super({ key: 'spike' });
      }
      create(): void {
        ready(this);
      }
      override update(_time: number, delta: number): void {
        onTick(delta);
      }
    }

    const res = this.resolution;
    this.game = new Phaser.Game({
      type: Phaser.WEBGL,
      parent: el,
      width: Math.round(cssWidth * res),
      height: Math.round(cssHeight * res),
      backgroundColor: '#000000',
      banner: false,
      scale: { mode: Phaser.Scale.NONE, zoom: 1 / res },
      render: { antialias: true, antialiasGL: false },
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      audio: { noAudio: true },
      scene: SpikeScene,
    });
    this.game.events.on(Phaser.Core.Events.POST_RENDER, () => this.afterRender());
    this.scene = await sceneReady;
    this.game.canvas.style.display = 'block';
    this.world = this.scene.add.container(0, 0);
    this.overlay = this.scene.add.rectangle(0, 0, 1, 1, 0x000000, 1).setOrigin(0, 0).setVisible(false);
  }

  protected resizeEngine(cssWidth: number, cssHeight: number): void {
    if (!this.game) return;
    const res = this.resolution;
    this.game.scale.resize(Math.round(cssWidth * res), Math.round(cssHeight * res));
    this.game.scale.setZoom(1 / res);
  }

  protected async loadTextures(refs: readonly TextureRef[]): Promise<void> {
    const scene = this.scene;
    if (!scene || refs.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const loader = scene.load;
      const onError = (file: Phaser.Loader.File): void => reject(new Error(`failed to load ${file.key}`));
      loader.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
      loader.once(Phaser.Loader.Events.COMPLETE, () => {
        loader.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onError);
        resolve();
      });
      for (const r of refs) loader.image(r.key, r.url);
      loader.start();
    });
    for (const r of refs) this.loadedKeys.add(r.key);
  }

  protected async unloadTextures(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      this.loadedKeys.delete(k);
      this.scene?.textures.remove(k);
    }
  }

  protected residentTextures(): TextureInfo[] {
    const scene = this.scene;
    if (!scene) return [];
    return [...this.loadedKeys].map((key) => {
      const src = scene.textures.get(key).source[0];
      return { key, width: src?.width ?? 0, height: src?.height ?? 0 };
    });
  }

  protected buildDisplay(spec: SceneSpec): void {
    const scene = this.scene;
    const world = this.world;
    if (!scene || !world) return;
    world.add(scene.add.image(0, 0, spec.background.key).setOrigin(0, 0));
    for (const h of this.model.hotspots) {
      const img = scene.add.image(h.spec.x, h.spec.y, spec.hotspotKey).setTint(h.tint);
      this.hotspotImages.push(img);
      world.add(img);
    }
    for (const e of this.model.entities) {
      const body = scene.add.image(0, 0, e.spec.textureKey).setOrigin(0.5, 0.92);
      const flash = scene.add.image(0, 0, e.spec.textureKey).setOrigin(0.5, 0.92).setBlendMode(Phaser.BlendModes.ADD);
      this.entityImages.push({ body, flash });
      world.add([body, flash]);
    }
    this.particleLayer = scene.add.container(0, 0);
    world.add(this.particleLayer);
    // Keep the overlay above the world.
    if (this.overlay) scene.children.bringToTop(this.overlay);
  }

  protected clearDisplay(): void {
    this.world?.removeAll(true);
    this.particleLayer = null;
    this.entityImages = [];
    this.hotspotImages = [];
    this.particleImages = [];
  }

  protected syncDisplay(): void {
    const scene = this.scene;
    const world = this.world;
    const spec = this.current;
    if (!scene || !world || !spec || !this.particleLayer) return;
    const m = this.model;
    const res = this.resolution;
    world.setPosition(m.worldX * res, m.worldY * res);
    world.setScale(m.worldScale * res);
    if (this.overlay) {
      this.overlay.setSize(m.viewWidth * res, m.viewHeight * res);
      this.overlay.setAlpha(m.overlayAlpha);
      this.overlay.setVisible(m.overlayAlpha > 0.001);
    }
    for (let i = 0; i < m.entities.length; i++) {
      const e = m.entities[i];
      const s = this.entityImages[i];
      if (!e || !s) continue;
      s.body.setVisible(e.visible).setPosition(e.x, e.y).setScale(e.scale).setAlpha(e.alpha);
      s.flash
        .setVisible(e.visible && e.flash > 0)
        .setPosition(e.x, e.y)
        .setScale(e.scale)
        .setAlpha(e.flash * 0.85);
    }
    for (let i = 0; i < m.hotspots.length; i++) {
      const h = m.hotspots[i];
      const img = this.hotspotImages[i];
      if (h && img) img.setScale(h.scale).setAlpha(h.alpha);
    }
    while (this.particleImages.length < m.particleCount) {
      const img = scene.add.image(0, 0, spec.particleKey).setBlendMode(Phaser.BlendModes.ADD);
      this.particleImages.push(img);
      this.particleLayer.add(img);
    }
    for (let i = 0; i < this.particleImages.length; i++) {
      const img = this.particleImages[i];
      if (!img) continue;
      const p = i < m.particleCount ? m.particles[i] : undefined;
      if (!p) {
        img.setVisible(false);
        continue;
      }
      img.setVisible(true).setPosition(p.x, p.y).setScale(p.scale).setAlpha(p.alpha).setTint(p.tint);
    }
  }

  getCanvas(): HTMLCanvasElement {
    if (!this.game) throw new Error('not mounted');
    return this.game.canvas;
  }

  getGl(): WebGLRenderingContext | WebGL2RenderingContext | null {
    const r = this.game?.renderer as Phaser.Renderer.WebGL.WebGLRenderer | undefined;
    return r && 'gl' in r ? r.gl : null;
  }

  protected destroyEngine(): void {
    this.game?.destroy(true);
    this.game = null;
  }
}
