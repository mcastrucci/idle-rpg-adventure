/** PixiJS v8 adapter (WebGL backend forced, so the comparison and context-loss test are like-for-like). */
import { Application, Assets, Container, Sprite, Texture, UPDATE_PRIORITY, VERSION } from 'pixi.js';

import type { SceneSpec, TextureInfo, TextureRef } from '../scene/types.ts';
import { ModelRenderer } from './base.ts';

interface EntitySprites {
  body: Sprite;
  flash: Sprite;
}

export class PixiSceneRenderer extends ModelRenderer {
  readonly id = 'pixi' as const;
  readonly libraryVersion = VERSION;

  private app: Application | null = null;
  private readonly world = new Container();
  private readonly particleLayer = new Container();
  private readonly overlay = new Sprite(Texture.WHITE);
  private background: Sprite | null = null;
  private entitySprites: EntitySprites[] = [];
  private hotspotSprites: Sprite[] = [];
  private particleSprites: Sprite[] = [];
  private readonly textures = new Map<string, Texture>();

  protected async createEngine(el: HTMLElement, cssWidth: number, cssHeight: number): Promise<void> {
    const app = new Application();
    await app.init({
      preference: 'webgl',
      width: cssWidth,
      height: cssHeight,
      resolution: this.resolution,
      autoDensity: true,
      antialias: false,
      background: 0x000000,
      // Input is handled by the harness on the DOM element for both renderers.
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    this.app = app;
    app.canvas.style.display = 'block';
    el.appendChild(app.canvas);
    app.stage.eventMode = 'none';
    this.overlay.tint = 0x000000;
    this.overlay.alpha = 0;
    app.stage.addChild(this.world, this.overlay);
    app.ticker.add((ticker) => this.tick(ticker.deltaMS), undefined, UPDATE_PRIORITY.HIGH);
    // The Application renders at UPDATE_PRIORITY.LOW; UTILITY runs after it.
    app.ticker.add(() => this.afterRender(), undefined, UPDATE_PRIORITY.UTILITY);
  }

  protected resizeEngine(cssWidth: number, cssHeight: number): void {
    this.app?.renderer.resize(cssWidth, cssHeight);
  }

  protected async loadTextures(refs: readonly TextureRef[]): Promise<void> {
    await Promise.all(
      refs.map(async (r) => {
        const tex = await Assets.load<Texture>({ alias: r.key, src: r.url });
        this.textures.set(r.key, tex);
      }),
    );
  }

  protected async unloadTextures(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (k) => {
        this.textures.delete(k);
        await Assets.unload(k);
      }),
    );
  }

  protected residentTextures(): TextureInfo[] {
    return [...this.textures].map(([key, t]) => ({ key, width: t.source.pixelWidth, height: t.source.pixelHeight }));
  }

  private tex(key: string): Texture {
    const t = this.textures.get(key);
    if (!t) throw new Error(`texture ${key} not loaded`);
    return t;
  }

  protected buildDisplay(spec: SceneSpec): void {
    this.background = new Sprite(this.tex(spec.background.key));
    this.world.addChild(this.background);
    for (const h of this.model.hotspots) {
      const s = new Sprite(this.tex(spec.hotspotKey));
      s.anchor.set(0.5);
      s.position.set(h.spec.x, h.spec.y);
      s.tint = h.tint;
      this.hotspotSprites.push(s);
      this.world.addChild(s);
    }
    for (const e of this.model.entities) {
      const t = this.tex(e.spec.textureKey);
      const body = new Sprite(t);
      const flash = new Sprite(t);
      body.anchor.set(0.5, 0.92);
      flash.anchor.set(0.5, 0.92);
      flash.blendMode = 'add';
      this.entitySprites.push({ body, flash });
      this.world.addChild(body, flash);
    }
    this.world.addChild(this.particleLayer);
  }

  protected clearDisplay(): void {
    for (const child of this.world.removeChildren()) {
      if (child !== this.particleLayer) child.destroy();
    }
    for (const p of this.particleLayer.removeChildren()) p.destroy();
    this.particleSprites = [];
    this.entitySprites = [];
    this.hotspotSprites = [];
    this.background = null;
  }

  protected syncDisplay(): void {
    const app = this.app;
    const m = this.model;
    if (!app || !this.current) return;
    this.world.position.set(m.worldX, m.worldY);
    this.world.scale.set(m.worldScale);
    this.overlay.width = m.viewWidth;
    this.overlay.height = m.viewHeight;
    this.overlay.alpha = m.overlayAlpha;
    this.overlay.visible = m.overlayAlpha > 0.001;
    for (let i = 0; i < m.entities.length; i++) {
      const e = m.entities[i];
      const s = this.entitySprites[i];
      if (!e || !s) continue;
      s.body.visible = e.visible;
      s.body.position.set(e.x, e.y);
      s.body.scale.set(e.scale);
      s.body.alpha = e.alpha;
      s.flash.visible = e.visible && e.flash > 0;
      s.flash.position.set(e.x, e.y);
      s.flash.scale.set(e.scale);
      s.flash.alpha = e.flash * 0.85;
    }
    for (let i = 0; i < m.hotspots.length; i++) {
      const h = m.hotspots[i];
      const s = this.hotspotSprites[i];
      if (!h || !s) continue;
      s.scale.set(h.scale);
      s.alpha = h.alpha;
    }
    const particleTex = this.tex(this.current.particleKey);
    while (this.particleSprites.length < m.particleCount) {
      const s = new Sprite(particleTex);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.particleSprites.push(s);
      this.particleLayer.addChild(s);
    }
    for (let i = 0; i < this.particleSprites.length; i++) {
      const s = this.particleSprites[i];
      if (!s) continue;
      const p = i < m.particleCount ? m.particles[i] : undefined;
      if (!p) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.position.set(p.x, p.y);
      s.scale.set(p.scale);
      s.alpha = p.alpha;
      s.tint = p.tint;
    }
  }

  getCanvas(): HTMLCanvasElement {
    if (!this.app) throw new Error('not mounted');
    return this.app.canvas;
  }

  getGl(): WebGLRenderingContext | WebGL2RenderingContext | null {
    const r = this.app?.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext } | undefined;
    return r?.gl ?? null;
  }

  protected destroyEngine(): void {
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}
