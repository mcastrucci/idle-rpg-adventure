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

## How to produce evidence
The device test kit lives in [`spikes/render-mobile/`](../../spikes/render-mobile/README.md): the same scene in PixiJS
and Phaser behind one `SceneRenderer` seam, an on-screen metrics HUD (FPS, frame times, load/transition time, texture
memory, context-loss recovery, background/foreground) and a "copy results" button whose output is pasted into
issue #12. Only results from real phones count; desktop/headless runs are smoke tests. KTX2/Basis is not covered by
the kit yet (see its README).
