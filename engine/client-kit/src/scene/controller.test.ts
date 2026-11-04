// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import type { BackendHooks, PreparedScene, SceneBackend, VisibilitySource } from './backend.ts';
import { SceneController } from './controller.ts';
import type { Size } from './geometry.ts';
import { LazyPixiBackend, createSceneRenderer } from './index.ts';
import type { SceneRegion, SceneSpec } from './types.ts';

/** Records every backend call so lifecycle rules can be asserted without a GL context. */
class FakeBackend implements SceneBackend {
  readonly calls: string[] = [];
  readonly alive = new Set<string>();
  peak = 0;
  hooks: BackendHooks | null = null;
  canvas = document.createElement('canvas');
  failInit = false;
  prepareGate: Promise<void> | null = null;
  fadeGate: Promise<void> | null = null;
  fadeStarted: (() => void) | null = null;
  private counter = 0;

  init(size: Size, resolution: number, hooks: BackendHooks): Promise<HTMLCanvasElement> {
    this.calls.push(`init:${size.width}x${size.height}@${resolution}`);
    if (this.failInit) return Promise.reject(new Error('no gl'));
    this.hooks = hooks;
    return Promise.resolve(this.canvas);
  }

  async prepare(spec: SceneSpec): Promise<PreparedScene> {
    await this.prepareGate;
    const scene = { id: `${spec.id}#${this.counter++}` };
    this.alive.add(scene.id);
    this.peak = Math.max(this.peak, this.alive.size);
    this.calls.push(`prepare:${spec.id}`);
    return scene;
  }

  show(scene: PreparedScene): void { this.calls.push(`show:${scene.id}`); }

  async fadeTo(previous: PreparedScene, next: PreparedScene, durationMs: number): Promise<void> {
    this.calls.push(`fade:${previous.id}>${next.id}:${durationMs}`);
    this.fadeStarted?.();
    await this.fadeGate;
  }

  release(scene: PreparedScene): void {
    this.alive.delete(scene.id);
    this.calls.push(`release:${scene.id}`);
  }

  setRegions(scene: PreparedScene, regions: readonly SceneRegion[]): void { this.calls.push(`regions:${scene.id}:${regions.length}`); }
  resize(size: Size): void { this.calls.push(`resize:${size.width}x${size.height}`); }
  setActive(active: boolean): void { this.calls.push(`active:${active}`); }
  recover(): void { this.calls.push('recover'); }
  residentCount(): number { return this.alive.size; }
  destroy(): void { this.calls.push('destroy'); }
}

class FakeVisibility implements VisibilitySource {
  hidden = false;
  private listeners = new Set<() => void>();
  isHidden(): boolean { return this.hidden; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(hidden: boolean): void { this.hidden = hidden; for (const l of this.listeners) l(); }
}

const image = (key: string) => ({ key, width: 400, height: 200, load: () => Promise.reject(new Error('unused in fake')) });
const scene = (id: string, regions: SceneRegion[] = []): SceneSpec => ({ id, background: image(`${id}.bg`), layers: [], regions });

function setup(options: { dpr?: number; size?: Size } = {}) {
  const backend = new FakeBackend();
  const visibility = new FakeVisibility();
  const container = document.createElement('div');
  const size = options.size ?? { width: 200, height: 100 };
  container.getBoundingClientRect = () => ({ ...size, x: 10, y: 20, left: 10, top: 20, right: 10 + size.width, bottom: 20 + size.height, toJSON: () => ({}) });
  document.body.appendChild(container);
  let clock = 0;
  const controller = new SceneController(backend, { visibility, devicePixelRatio: () => options.dpr ?? 1, now: () => (clock += 5) });
  return { backend, visibility, container, controller };
}

describe('SceneController lifecycle', () => {
  it('mounts a canvas, caps the resolution at 2 and loads a scene', async () => {
    const { backend, container, controller } = setup({ dpr: 3 });
    expect(await controller.mount(container)).toBe('canvas');
    expect(container.contains(backend.canvas)).toBe(true);
    expect(backend.calls[0]).toBe('init:200x100@2');
    await controller.loadScene(scene('a'));
    expect(backend.calls).toContain('show:a#0');
    expect(backend.alive.size).toBe(1);
  });

  it('prepares the next scene before anything changes, fades, then releases the old textures', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    backend.calls.length = 0;
    const result = await controller.transitionTo(scene('b'));
    expect(result.status).toBe('completed');
    expect(backend.calls).toEqual(['prepare:b', 'fade:a#0>b#1:450', 'release:a#0']);
    expect([...backend.alive]).toEqual(['b#1']);
    expect(backend.peak).toBeLessThanOrEqual(2);
    expect(result.animationMs).toBeGreaterThan(0);
    expect(result.animationMs).toBeLessThanOrEqual(1000);
  });

  it('keeps the transition within the 1 s budget even if a longer duration is requested', async () => {
    const backend = new FakeBackend();
    const container = document.createElement('div');
    const controller = new SceneController(backend, { transitionMs: 5000 });
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    await controller.transitionTo(scene('b'));
    expect(backend.calls.some((call) => call.endsWith(':1000'))).toBe(true);
  });

  it('transitioning to the resident scene only updates its regions', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    backend.calls.length = 0;
    const result = await controller.transitionTo(scene('a', [{ id: 'exit', x: 1, y: 1, radius: 5, enabled: true }]));
    expect(result.status).toBe('unchanged');
    expect(backend.calls).toEqual(['regions:a#0:1']);
  });

  it('cuts instantly under reduced motion', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    controller.setReducedMotion(true);
    backend.calls.length = 0;
    const result = await controller.transitionTo(scene('b'));
    expect(result.status).toBe('cut');
    expect(result.animationMs).toBe(0);
    expect(backend.calls).toEqual(['prepare:b', 'show:b#1', 'release:a#0']);
  });

  it('cuts while the document is hidden', async () => {
    const { backend, visibility, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    visibility.set(true);
    expect((await controller.transitionTo(scene('b'))).status).toBe('cut');
    expect(backend.calls.some((call) => call.startsWith('fade'))).toBe(false);
  });

  it('skips transitions superseded while still queued and never leaks textures', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    let open!: () => void;
    backend.prepareGate = new Promise((resolve) => { open = resolve; });
    const first = controller.transitionTo(scene('b'));
    const second = controller.transitionTo(scene('c'));
    const third = controller.transitionTo(scene('d'));
    open();
    expect((await first).status).toBe('skipped');
    expect((await second).status).toBe('skipped');
    expect((await third).status).toBe('completed');
    expect([...backend.alive].map((id) => id.split('#')[0])).toEqual(['d']);
    expect(backend.peak).toBeLessThanOrEqual(2);
  });

  it('resizes the backend and pauses/resumes rendering with document visibility', async () => {
    const { backend, visibility, container, controller } = setup();
    await controller.mount(container);
    controller.resize(360, 240);
    visibility.set(true);
    visibility.set(false);
    expect(backend.calls).toEqual(expect.arrayContaining(['active:true', 'resize:360x240', 'active:false']));
    expect(backend.calls.slice(-2)).toEqual(['active:false', 'active:true']);
  });

  it('starts paused when mounted while hidden', async () => {
    const { backend, visibility, container, controller } = setup();
    visibility.hidden = true;
    await controller.mount(container);
    expect(backend.calls).toContain('active:false');
  });

  it('reports context loss and recovers when the context is restored', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    const events: string[] = [];
    controller.on('contextLost', () => events.push('lost'));
    controller.on('contextRestored', () => events.push('restored'));
    backend.hooks?.onContextLost();
    // A transition while lost is an instant cut: nothing can be drawn.
    expect((await controller.transitionTo(scene('b'))).status).toBe('cut');
    backend.hooks?.onContextRestored();
    expect(events).toEqual(['lost', 'restored']);
    expect(backend.calls).toContain('recover');
    expect((await controller.transitionTo(scene('c'))).status).toBe('completed');
  });

  it('destroy releases the resident scene, the backend and the canvas, and unblocks pending work', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    controller.destroy();
    expect(backend.alive.size).toBe(0);
    expect(backend.calls.slice(-2)).toEqual(['release:a#0', 'destroy']);
    expect(container.contains(backend.canvas)).toBe(false);
    expect((await controller.transitionTo(scene('b'))).status).toBe('cut');
    expect(backend.alive.size).toBe(0);
  });

  it('destroying during a preload releases the half-prepared scene', async () => {
    const { backend, container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a'));
    let open!: () => void;
    backend.prepareGate = new Promise((resolve) => { open = resolve; });
    const pending = controller.transitionTo(scene('b'));
    controller.destroy();
    open();
    expect((await pending).status).toBe('skipped');
    expect(backend.alive.size).toBe(0);
  });
});

describe('SceneController taps', () => {
  it('emits regionTap for an enabled region under the tap, mapped through the cover fit', async () => {
    const { container, controller } = setup({ size: { width: 200, height: 100 } });
    await controller.mount(container);
    // 400x200 scene in a 200x100 viewport: scale 0.5, no offset.
    await controller.loadScene(scene('a', [
      { id: 'exit:north', x: 200, y: 100, radius: 40, enabled: true },
      { id: 'off', x: 40, y: 40, radius: 40, enabled: false },
    ]));
    const taps: string[] = [];
    controller.on('regionTap', (event) => taps.push(event.regionId));
    const click = (x: number, y: number) => container.dispatchEvent(new MouseEvent('click', { clientX: 10 + x, clientY: 20 + y, bubbles: true }));
    click(100, 50);
    click(20, 20);
    click(190, 95);
    expect(taps).toEqual(['exit:north']);
  });

  it('stops emitting after the listener is removed', async () => {
    const { container, controller } = setup();
    await controller.mount(container);
    await controller.loadScene(scene('a', [{ id: 'r', x: 200, y: 100, radius: 40, enabled: true }]));
    const listener = vi.fn();
    const off = controller.on('regionTap', listener);
    off();
    container.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 70, bubbles: true }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('fallback when WebGL is unavailable', () => {
  it('resolves fallback, mounts no canvas and treats scene calls as no-ops', async () => {
    const backend = new FakeBackend();
    backend.failInit = true;
    const container = document.createElement('div');
    const controller = new SceneController(backend);
    expect(await controller.mount(container)).toBe('fallback');
    expect(controller.mode).toBe('fallback');
    expect(container.childElementCount).toBe(0);
    await controller.loadScene(scene('a'));
    expect((await controller.transitionTo(scene('b'))).status).toBe('cut');
    expect(backend.calls.filter((call) => call.startsWith('prepare'))).toEqual([]);
    expect(() => controller.destroy()).not.toThrow();
  });

  it('does not load the renderer library when there is no WebGL context', async () => {
    const container = document.createElement('div');
    const renderer = createSceneRenderer();
    // happy-dom has no WebGL: the lazy backend rejects before importing PixiJS.
    expect(await renderer.mount(container)).toBe('fallback');
    expect(new LazyPixiBackend(() => false).residentCount()).toBe(0);
    await expect(new LazyPixiBackend(() => false).init({ width: 1, height: 1 }, 1, { onContextLost() {}, onContextRestored() {} })).rejects.toThrow('WebGL');
  });
});
