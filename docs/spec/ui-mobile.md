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
| **Sanctuary hub** | Tab bar: Character · Inventory · Adventure · Expeditions · (Social, phase 2). Header: level, XP bar, gold, active-expedition chip with countdown |
| **Character** | Attributes, derived stats, skill loadout (4 slots), automation rules editor (reorderable cards), build presets |
| **Inventory / Storage** | Grid with filters; item detail sheet with compare vs equipped (uses `packages/stats`) |
| **Adventure** | Region list with conquest progress (`X / required`, boss status), danger rating vs character, Enter button |
| **Scene (live)** | Top ~60%: illustrated scene (canvas) with exit arrows and hotspots. Bottom sheet: location name, actions, run bag count, Return button (when allowed) |
| **Combat overlay** | Enemies in scene; party frames (HP/effects) top; telegraph banner; bottom skill bar (4 skills + consumable + auto toggle); combat log drawer |
| **Expedition setup** | Region → activity → duration chips → consumables → rules preview → **Estimate card** (XP/gold p50 with ranges, potions, death %) → Start |
| **Expedition progress** | Progress ring, revealed encounters feed, cancel (with consequences dialog) |
| **Report** | Totals, loot list, consumables used, notable events, death log if any, "Go again" |
| **Death screen** | What happened (top 3 causes), what was lost, where the corpse is, CTA |

## 3. Scene art guidelines (pending spike 2 numbers)

- Authored in portrait with a safe area; reference size 1536×2048 *(provisional)*; runtime variants at 1×/2× compressed.
- Exits and hotspots must be readable at 360 px width; hotspot highlight on long-press/"reveal" button.
- Enemy sprites authored as separate layers to allow tween-based animation.

## 4. Notifications (web POC)

In-app only (badge + toast when an expedition completes while the app is open). Push/local notifications come with
Capacitor (ADR-0011).
