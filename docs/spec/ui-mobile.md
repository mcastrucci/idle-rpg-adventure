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
| **Scene (live)** | One fixed frame, see [§2.1](#21-fixed-live-frame): breadcrumb, illustrated scene band (canvas) with exit arrows and hotspots, status strip, a mode panel with actions, run bag and the Return button (when allowed), log row |
| **Combat overlay** | Same fixed frame: hero and enemy sprites in the scene band with the enemy HP overlay; party frames in the strip; telegraph, queue + Auto, 2×2 skills, feedback, potion + retreat in the mode panel; combat log drawer |
| **Expedition setup** | Region → activity → duration chips → consumables → rules preview → **Estimate card** (XP/gold p50 with ranges, potions, death %) → Start |
| **Expedition progress** | Progress ring, revealed encounters feed, cancel (with consequences dialog) |
| **Report** | Totals, loot list, consumables used, notable events, death log if any, "Go again" |
| **Death screen** | What happened (top 3 causes), what was lost, where the corpse is, CTA |

### 2.1 Fixed live frame

While a live adventure is on screen the app is a single `100dvh` frame (#176; rows from
`games/rpg/art/region-1/mockup/layout-spec.md`, visual reference `docs/design/references/fixed-combat-reference.png`):
no document scroll, nothing the player needs below the fold.

| Row | 360×780 | 360×640 | Contents |
|---|---:|---:|---|
| Breadcrumb | 44 | 44 | `← Map` (the way back; the adventure keeps running), area › location, connection dot |
| Scene band | flexible (272) | flexible (186) | Backdrop canvas with tappable exits/hotspots; in combat the hero and enemy sprites and the enemy HP overlay |
| Status strip | 104 | 76 | Level/XP line, then hero HP (exploring) or party frames (combat) |
| Mode panel | 316 | 290 | Exploring: actions list (engage, travel, interact, gather, supplies, groups, run bag) that scrolls **inside** the panel, plus the Return button. Combat: telegraph 48, queue + Auto 44, 2×2 skills 104, feedback 32, potion + retreat 44, caption 26 (24 and 40/96/30 on short phones) |
| Log | 44 | 44 | Collapsed button; opens an overlay drawer that never moves a row |

The header and tab bar are hidden while the frame is on screen (they would take ~140 px of a 640 px phone and are not
needed mid-adventure); the breadcrumb row's back control returns to the world map, where both are back. Rows have
reserved heights: text clips or wraps inside its row and long lists scroll inside their panel. Layout is fluid down to
320 px wide. Every control is at least 44 px; motion respects `prefers-reduced-motion`.

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
- Combat sprites are 512×512 PNGs (1 MiB RGBA each). The combat layer fetches and decodes only the hero and the enemies of
  the current group (duplicates share one decode), so a fight adds at most 5 MiB (hero + 4 distinct enemies) to the
  6 MiB background, inside the 16 MiB budget, and releases them when the fight ends. An enemy without a manifest sprite
  is drawn as a labelled silhouette.

## 4. Notifications (web POC)

In-app only (badge + toast when an expedition completes while the app is open). Push/local notifications come with
Capacitor (ADR-0011).
