# Combat layout mockup spec

## Purpose

A standalone, offline review artifact for a fixed-position realtime combat HUD. It uses the supplied Seed Chamber background and the Max and Hollow Matriarch sprite references as relative image paths. It is a visual and interaction mockup; the co-op footer explicitly marks the feature as phase 2 and does not imply a working network or co-op implementation.

Open `index.html` directly in a modern browser. It has no dependencies, build step, font downloads, or network calls. Expected asset paths, relative to this directory:

- `../backgrounds/webp/seed-vault-heart.webp`
- `../sprites/hero_max.png`
- `../sprites/hollow_matriarch.png`

## Layout at 360 × 780 CSS pixels

The frame is capped at 360px wide, fixed at 780px high, and uses a fixed grid. On widths below 360px it fills the available width while retaining the same row positions and vertical dimensions. The document body itself has no outer margin, and the frame clips overflow so text changes do not push controls down.

| Top / bottom | Region | Height | Contents |
|---:|---|---:|---|
| 0–22 | Breadcrumb | 22px | Verdant Hollow › Seed Chamber |
| 22–310 | Scene | 288px | Background, Max and boss sprites, boss HP overlay and taunt count |
| 310–422 | Party | 112px | Four 2×2 party frames; Max is highlighted as the controlled tank |
| 422–470 | Telegraph | 48px | Crushing Blow, target and 2s countdown |
| 470–514 | Queue | 44px | Next action and Auto toggle |
| 514–618 | Skills | 104px | Taunt, Guard, Cleave cooldown, Shield Bash in a 2×2 grid |
| 618–650 | Feedback | 32px | Live feedback stripe |
| 650–694 | Items | 44px | Potion ×2 and disabled Retreat |
| 694–712 | Caption | 18px | “Can't retreat from a boss.” |
| 712–756 | Combat log | 44px | Collapsed button; opens an absolute overlay drawer |
| 756–780 | Footer | 24px | “MOCKUP · CO-OP PHASE 2” |

All visible interactive controls are at least 44px high: skill buttons are sized to their grid tracks (at least 44px), Auto is 44px, Potion and Retreat are 44px, the collapsed log button is 44px, and the drawer close button is 44px. Disabled Cleave and Retreat keep their unavailable state visible.

## Content and behavior

- Party labels and HP: Max 76/140 HP · You (Tank icon), Luna 94/110 HP (Healer icon), Emma 102/120 HP (Archer icon), Kai 88/115 HP (Swordsman icon). Current/max numbers sit in the frame text row at readable size; the bars show the same current-health percentages.
- Status examples: Guard · 2 attacks on Max, Regen 4s on Luna, Bleed 3s on Kai; Emma is Ready.
- Boss example: Hollow Matriarch at 65%, taunted for 3 attacks.
- Telegraph example: Crushing Blow, targeting Max, in 2 seconds.
- Queue example: “Queued: Guard · next action”; Auto starts on. The queue label may wrap within its reserved row.
- Telegraph timer has a fixed-width cell and target text is clipped, so long state strings cannot expand over neighboring controls.
- Feedback example: Luna healed Max +24 HP.
- Skills and Auto can be selected/toggled to demonstrate control affordances. Selecting a skill updates the queue text without changing the other skill subtitles. Potion count decrements on click. Retreat and Cleave remain disabled in this scenario.
- Combat log opens as an overlay within the scene/frame and does not change grid row geometry.
- Stress review hook: in the browser console call `window.mockup.setState({feedback: 'long feedback...', telegraph: 'long move...', target: 'long target...', time: 'long time...', queued: 'long queued action...'})`. Empty strings are supported. Text clips or wraps within its reserved stripe; it does not reflow the frame.
- Reduced-motion preference disables the telegraph pulse animation.

## Scope limits

This file illustrates a proposed fixed HUD arrangement only. It does not establish final combat mechanics, multiplayer synchronization, server authority, accessibility sign-off, or production touch-device testing. The visual targets a 360px baseline and fluid widths down to 320px; it is not a substitute for validating the full range of devices and localized strings.
