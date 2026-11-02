/**
 * Renderer-agnostic scene state. Both renderers drive the *same* model (same tweens, choreography, particle physics
 * and seeded RNG) and only copy its output into their display objects each frame, so the comparison measures the
 * rendering libraries, not two different animation implementations.
 */
import { clamp01, computeCover, easeInOutQuad, easeOutCubic, mulberry32 } from './math.ts';
import type { HotspotSpec, SceneSpec, SpriteSpec } from './types.ts';

/** Source sprite size in pixels (generated art); used for hit boxes and burst origins. */
export const SPRITE_SOURCE_SIZE = 192;
const MAX_PARTICLES = 4000;
const LUNGE_MS = 360;
const HIT_DELAY_MS = 130;
const SHAKE_MS = 320;
const FLASH_MS = 200;
const DEATH_MS = 650;
const RESPAWN_DELAY_MS = 1100;
const SPAWN_FADE_MS = 350;
/** Hotspot ring (96 px source) drawn at ~1.7× so it stays readable at 360 px width. */
const HOTSPOT_SCALE = 1.7;

export interface EntityView {
  readonly spec: SpriteSpec;
  x: number;
  y: number;
  scale: number;
  alpha: number;
  /** 0..1 strength of the additive white hit flash. */
  flash: number;
  visible: boolean;
}

export interface ParticleView {
  x: number;
  y: number;
  scale: number;
  alpha: number;
  tint: number;
}

export interface HotspotView {
  readonly spec: HotspotSpec;
  scale: number;
  alpha: number;
  tint: number;
}

interface EntityState extends EntityView {
  phase: number;
  lunge: { start: number; dx: number; dy: number } | null;
  shakeStart: number;
  flashStart: number;
  deathStart: number;
  respawnAt: number;
  spawnStart: number;
  dead: boolean;
}

interface ParticleState extends ParticleView {
  vx: number;
  vy: number;
  age: number;
  life: number;
  baseScale: number;
}

interface HotspotState extends HotspotView {
  tapStart: number;
}

interface Tween {
  start: number;
  duration: number;
  apply: (k: number) => void;
  resolve: () => void;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class SceneModel {
  spec: SceneSpec | null = null;
  readonly entities: EntityState[] = [];
  readonly hotspots: HotspotState[] = [];
  /** Pool; only the first `particleCount` entries are live. */
  readonly particles: ParticleState[] = [];
  particleCount = 0;
  /** CSS-pixel view size. */
  viewWidth = 1;
  viewHeight = 1;
  /** World (background-pixel space) → CSS-pixel transform. */
  worldX = 0;
  worldY = 0;
  worldScale = 1;
  slideX = 0;
  overlayAlpha = 0;
  autoBattle = true;
  time = 0;

  private rng = mulberry32(1);
  private readonly pending: { at: number; run: () => void }[] = [];
  private readonly tweens: Tween[] = [];
  private nextAttackAt = 0;
  private attackCount = 0;

  setScene(spec: SceneSpec): void {
    this.spec = spec;
    this.rng = mulberry32(hashString(spec.id));
    this.pending.length = 0;
    this.particleCount = 0;
    this.attackCount = 0;
    this.nextAttackAt = this.time + 600;
    this.entities.length = 0;
    const ordered = [...spec.sprites].sort((a, b) => a.y - b.y);
    for (const s of ordered) {
      this.entities.push({
        spec: s,
        x: s.x,
        y: s.y,
        scale: s.scale,
        alpha: 1,
        flash: 0,
        visible: true,
        phase: this.rng() * Math.PI * 2,
        lunge: null,
        shakeStart: -1,
        flashStart: -1,
        deathStart: -1,
        respawnAt: -1,
        spawnStart: -1,
        dead: false,
      });
    }
    this.hotspots.length = 0;
    for (const h of spec.hotspots) {
      this.hotspots.push({ spec: h, scale: 1, alpha: 0.9, tint: h.exit ? 0xffd27a : 0x7ff3ff, tapStart: -1 });
    }
    this.layout();
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.viewWidth = Math.max(1, cssWidth);
    this.viewHeight = Math.max(1, cssHeight);
    this.layout();
  }

  private layout(): void {
    if (!this.spec) return;
    const cover = computeCover(this.viewWidth, this.viewHeight, this.spec.background.width, this.spec.background.height);
    this.worldScale = cover.scale;
    this.worldX = cover.offsetX + this.slideX;
    this.worldY = cover.offsetY;
  }

  /** Tween driven by model time (so it pauses with rendering). `apply` receives eased 0..1. */
  animate(durationMs: number, apply: (k: number) => void): Promise<void> {
    return new Promise((resolve) => {
      apply(0);
      this.tweens.push({ start: this.time, duration: durationMs, apply, resolve });
    });
  }

  update(dtMs: number): void {
    // Clamp so returning from background does not teleport everything.
    const dt = Math.min(Math.max(dtMs, 0), 100);
    this.time += dt;
    const t = this.time;

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      if (!tw) continue;
      const p = clamp01((t - tw.start) / tw.duration);
      tw.apply(easeInOutQuad(p));
      if (p >= 1) {
        this.tweens.splice(i, 1);
        tw.resolve();
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const ev = this.pending[i];
      if (ev && t >= ev.at) {
        this.pending.splice(i, 1);
        ev.run();
      }
    }
    if (this.autoBattle && this.spec && t >= this.nextAttackAt && this.tweens.length === 0) this.autoAttack();

    for (const e of this.entities) this.updateEntity(e, t);
    this.updateParticles(dt);
    for (const h of this.hotspots) {
      const tapP = h.tapStart >= 0 ? clamp01((t - h.tapStart) / 450) : 1;
      h.scale = HOTSPOT_SCALE * (1 + 0.08 * Math.sin(t * 0.004 + h.spec.x) + 0.6 * (1 - tapP));
      h.alpha = 0.75 + 0.25 * (1 - tapP);
    }
    this.layout();
  }

  private updateEntity(e: EntityState, t: number): void {
    const s = e.spec;
    let x = s.x;
    let y = s.y + Math.sin((t / 1000) * Math.PI * 2 * (s.flying ? 0.9 : 0.55) + e.phase) * (s.flying ? 16 : 6);
    let scale = s.scale;
    let alpha = 1;
    if (e.lunge) {
      const p = (t - e.lunge.start) / LUNGE_MS;
      if (p >= 1) e.lunge = null;
      else {
        const k = p < 0.35 ? easeOutCubic(p / 0.35) : 1 - easeInOutQuad((p - 0.35) / 0.65);
        x += e.lunge.dx * k;
        y += e.lunge.dy * k;
      }
    }
    if (e.shakeStart >= 0) {
      const p = (t - e.shakeStart) / SHAKE_MS;
      if (p >= 1) e.shakeStart = -1;
      else x += Math.sin(p * 45) * 18 * (1 - p);
    }
    e.flash = 0;
    if (e.flashStart >= 0) {
      const p = (t - e.flashStart) / FLASH_MS;
      if (p >= 1) e.flashStart = -1;
      else e.flash = 1 - p;
    }
    if (e.deathStart >= 0) {
      const p = clamp01((t - e.deathStart) / DEATH_MS);
      alpha = 1 - p;
      scale *= 1 - 0.25 * p;
      y += 40 * p;
      if (p >= 1) e.dead = true;
    }
    if (e.respawnAt >= 0 && t >= e.respawnAt) {
      e.respawnAt = -1;
      e.deathStart = -1;
      e.dead = false;
      e.spawnStart = t;
      alpha = 0;
    }
    if (e.spawnStart >= 0) {
      const p = clamp01((t - e.spawnStart) / SPAWN_FADE_MS);
      alpha = Math.min(alpha, p);
      if (p >= 1) e.spawnStart = -1;
    }
    e.x = x;
    e.y = y;
    e.scale = scale;
    e.alpha = alpha;
    e.visible = !e.dead && alpha > 0.001;
  }

  private updateParticles(dt: number): void {
    const s = dt / 1000;
    let n = this.particleCount;
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      if (!p) continue;
      p.age += dt;
      if (p.age >= p.life) {
        // Swap-remove.
        const last = this.particles[n - 1];
        if (last) {
          this.particles[i] = last;
          this.particles[n - 1] = p;
        }
        n--;
        i--;
        continue;
      }
      p.vy += 1400 * s;
      p.vx *= 1 - 1.5 * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      const k = p.age / p.life;
      p.alpha = 1 - k;
      p.scale = p.baseScale * (1 - 0.6 * k);
    }
    this.particleCount = n;
  }

  burst(x: number, y: number, tint: number, count: number): void {
    for (let i = 0; i < count && this.particleCount < MAX_PARTICLES; i++) {
      let p = this.particles[this.particleCount];
      if (!p) {
        p = { x: 0, y: 0, scale: 1, alpha: 1, tint, vx: 0, vy: 0, age: 0, life: 1, baseScale: 1 };
        this.particles.push(p);
      }
      const angle = this.rng() * Math.PI * 2;
      const speed = 250 + this.rng() * 450;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed - 350;
      p.age = 0;
      p.life = 450 + this.rng() * 350;
      p.baseScale = 0.6 + this.rng() * 0.9;
      p.scale = p.baseScale;
      p.alpha = 1;
      p.tint = this.rng() < 0.3 ? 0xffffff : tint;
      this.particleCount++;
    }
  }

  private find(id: string): EntityState | undefined {
    return this.entities.find((e) => e.spec.id === id);
  }

  hit(targetId: string, lethal = false): void {
    const e = this.find(targetId);
    if (!e || e.dead || e.deathStart >= 0) return;
    e.flashStart = this.time;
    e.shakeStart = this.time;
    this.burst(e.x, e.y - SPRITE_SOURCE_SIZE * e.spec.scale * 0.45, e.spec.tint, this.spec?.particlesPerBurst ?? 24);
    if (lethal) {
      e.deathStart = this.time;
      e.respawnAt = this.time + DEATH_MS + RESPAWN_DELAY_MS;
    }
  }

  attack(attackerId: string, targetId: string, lethal = false): void {
    const a = this.find(attackerId);
    const target = this.find(targetId);
    if (!a || !target || a.dead) return;
    a.lunge = { start: this.time, dx: (target.spec.x - a.spec.x) * 0.4, dy: (target.spec.y - a.spec.y) * 0.4 };
    this.pending.push({ at: this.time + HIT_DELAY_MS, run: () => this.hit(targetId, lethal) });
  }

  private alive(side: SpriteSpec['side']): EntityState[] {
    return this.entities.filter((e) => e.spec.side === side && !e.dead && e.deathStart < 0 && e.spawnStart < 0);
  }

  private autoAttack(): void {
    const spec = this.spec;
    if (!spec) return;
    this.nextAttackAt = this.time + spec.attackIntervalMs;
    const attackerSide = this.attackCount % 2 === 0 ? 'party' : 'foes';
    const attackers = this.alive(attackerSide);
    const targets = this.alive(attackerSide === 'party' ? 'foes' : 'party');
    if (attackers.length === 0 || targets.length === 0) return;
    const a = attackers[Math.floor(this.rng() * attackers.length)];
    const t = targets[Math.floor(this.rng() * targets.length)];
    if (!a || !t) return;
    this.attackCount++;
    const lethal = this.attackCount % 5 === 0 && targets.length > 1;
    this.attack(a.spec.id, t.spec.id, lethal);
  }

  /** CSS-pixel tap → hotspot or sprite reaction. */
  tap(cssX: number, cssY: number): { kind: 'hotspot' | 'sprite'; id: string; exit: boolean } | null {
    const bx = (cssX - this.worldX) / this.worldScale;
    const by = (cssY - this.worldY) / this.worldScale;
    for (const h of this.hotspots) {
      // Generous touch radius: at least 28 CSS px (≈ 56 px target, above the 44 px guideline).
      const r = Math.max(h.spec.radius, 28 / this.worldScale);
      if ((bx - h.spec.x) ** 2 + (by - h.spec.y) ** 2 <= r * r) {
        h.tapStart = this.time;
        this.burst(h.spec.x, h.spec.y, h.tint, Math.ceil((this.spec?.particlesPerBurst ?? 24) / 2));
        return { kind: 'hotspot', id: h.spec.id, exit: h.spec.exit };
      }
    }
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!e || !e.visible) continue;
      const size = SPRITE_SOURCE_SIZE * e.spec.scale;
      if (Math.abs(bx - e.x) < size * 0.4 && by <= e.y && by >= e.y - size * 0.9) {
        this.hit(e.spec.id);
        return { kind: 'sprite', id: e.spec.id, exit: false };
      }
    }
    return null;
  }
}
