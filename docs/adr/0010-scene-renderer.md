# ADR-0010: Scene viewport renderer (PixiJS vs Phaser)

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** Spike 2 (mobile rendering + Capacitor)

## Context
The game is mostly UI; the illustrated scene and combat overlay need a 2D renderer with sprites, tweens, transitions
and effects on mid/low-end mobile.

## Decision (hypothesis)
- App UI stays in **React/DOM**. Text, forms, inventory, reports are never drawn in canvas.
- The scene/combat viewport uses **PixiJS v8** behind a `SceneRenderer` interface; Phaser is the alternative.
- POC animation = static sprites + tweens (GSAP or equivalent); no skeletal animation (Spine) yet.
- Texture budget: one scene resident, compressed textures (KTX2/Basis), context-loss recovery.

## Consequences
- Swapping renderer costs weeks, not months.
- Spike 2 decides with measured FPS/memory on real devices.
