# ADR-0010: Scene viewport renderer (PixiJS vs Phaser)

- **Status:** Accepted (provisional, 2026-11-04). Revisit when low-end device results exist (see below).
- **Date:** 2026-11-01 (proposed), 2026-11-04 (provisionally accepted by the owner)
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

## Provisional acceptance (2026-11-04)

The owner accepted **PixiJS v8** provisionally so that scene work (#40) can proceed. The only real-device evidence so far
comes from one high-end phone. Numbers are from the owner's run in [#12](https://github.com/mcastrucci/idle-rpg-adventure/issues/12):
Galaxy Z Fold 5, Adreno 740, Chrome 156, browser, resolution 2, stress variant.

| | PixiJS 8.22 | Phaser 4.2.1 |
|---|---|---|
| Benchmarks (normal/stress, 30 s) | 60 fps, 1% low ≥ 56, no frame > 50 ms | same |
| Bundle raw / gzip | 593 / 179 KiB | 1368 / 358 KiB |
| JS heap peak | 7.4 MiB (WebP), 10.6 MiB (PNG) | 18.0 / 16.9 MiB |
| Renderer init + scene load | 0.3–1.6 s | about 0.2 s |
| Scene transition avg / max | 943–971 ms / 1.6–2.5 s | 673–693 ms / about 0.7 s |
| Context-loss recovery, BG/FG resume, audio unlock | pass | pass |
| Texture memory (est.) | 12.9 MiB | 12.9 MiB |

**Why PixiJS:**
- Both renderers hold 60 fps on this device, so frame rate does not separate them.
- PixiJS is about half the download and JS heap, which matters most on the low-memory target.
- PixiJS is a pure renderer that fits the React/DOM shell. Phaser's game framework would mostly go unused.

**Known PixiJS weakness to address in #40:** scene transitions had 1.6–2.5 s worst cases. They were probably caused by
decoding and uploading the next background during the transition. Preload and decode the next scene's textures before
transitioning, and keep transitions within the budget in `docs/spec/ui-mobile.md` §3.

**Revisit criteria.** Run the spike kit on a ~2 GB RAM Android and an older iPhone (11/SE) when available. Switch to
Phaser, behind the same `SceneRenderer` seam, if PixiJS misses the 30 fps floor or the transition budget there while
Phaser meets them. KTX2/Basis compressed textures remain unmeasured.
