# Spec: Mobile-first UI Proposal

> Status: **Draft v0.1**. Wireframe-level; visual design pending.

## 1. Principles

- **Portrait first**, baseline viewport 360×640 CSS px; scales to tablets/desktop with a centered column + side panels.
- Text, lists, forms and menus are **DOM** (accessible, selectable, localizable). Only the scene viewport is canvas.
- Thumb zone: primary actions in the bottom third; tap targets ≥ 44 px.
- Short-session friendly: from app open to "expedition started" in ≤ 3 taps when repeating the last config.
- Respect `prefers-reduced-motion`; never convey state by color alone.
- Connection banner for reconnecting/offline; commands are disabled (not lost) while disconnected.

## 2. Screens

| Screen | Content |
|---|---|
| **Sanctuary hub** | Tab bar: Character · Inventory · World map · Expeditions · (Social, phase 2). Header: level, XP bar, gold, active-expedition chip with countdown |
| **Character** | Attributes, derived stats, skill loadout (4 slots), automation rules editor (reorderable cards), build presets |
| **Inventory / Storage** | Grid with filters; item detail sheet with compare vs equipped (uses `packages/stats`) |
| **World map** | Engine `client-kit` world map: hub and areas as nodes, routes, fog of war (known/locked/hidden with reason), per-area completion progress (`X / required`, objectives), danger rating vs actor, idle-unlocked badge, Enter button. Replaces a flat region list |
| **Scene (live)** | Top ~60%: illustrated scene (canvas) with exit arrows and hotspots. Bottom sheet: location name, actions, run bag count, Return button (when allowed) |
| **Combat overlay** | Enemies in scene; party frames (HP/effects) top; telegraph banner; bottom skill bar (4 skills + consumable + auto toggle); combat log drawer |
| **Expedition setup** | Region → activity → duration chips → consumables → rules preview → **Estimate card** (XP/gold p50 with ranges, potions, death %) → Start |
| **Expedition progress** | Progress ring, revealed encounters feed, cancel (with consequences dialog) |
| **Report** | Totals, loot list, consumables used, notable events, death log if any, "Go again" |
| **Death screen** | What happened (top 3 causes), what was lost, where the corpse is, CTA |

## 3. Scene art guidelines and texture budget (provisional, spike 2)

Provisional, measured only on a high-end device so far (#12, ADR-0010). Revisit after low-end runs.

- Authored in portrait with a safe area; reference size 1536×2048 *(provisional)*. No texture side above 2048 px.
- **Delivery format: WebP.** In the spike, WebP backgrounds were 53–73 KB, against 1.2–1.6 MB as PNG, at the same GPU
  memory. KTX2/Basis is not measured yet; do not depend on it.
- **One scene resident.** The current scene plus, at most, the preloaded next one during a transition. Release the
  previous scene's textures after the transition.
- **Texture memory per resident scene: ≤ 16 MiB** (the spike scene measured about 12.9 MiB: 2048 px background, 6
  sprites, particles). Budget about 1–2 MiB per enemy or hero sprite sheet.
- **Canvas resolution:** DPR capped at 2.
- **Performance targets:** 60 fps target and a 30 fps floor on the low-end device. A scene transition should take
  ≤ 1 s, decoding and uploading the next background before the transition starts.
- Exits and hotspots must be readable at 360 px width; hotspot highlight on long-press/"reveal" button.
- Enemy sprites authored as separate layers to allow tween-based animation.

## 4. Notifications (web POC)

In-app only (badge + toast when an expedition completes while the app is open). Push/local notifications come with
Capacitor (ADR-0011).
