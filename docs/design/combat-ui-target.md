# Combat UI visual target

**Status:** visual direction for the POC; interaction details below are a target, not a renderer or combat-system approval. See issues [#136](https://github.com/mcastrucci/idle-rpg-adventure/issues/136) and [#139](https://github.com/mcastrucci/idle-rpg-adventure/issues/139).

## Composition

Use a tall portrait viewport, approximately 9:19.5. The upper ~40% is a pixel-art greenhouse/Ark combat scene; the lower portion is a compact purple-and-gold control surface. Keep the illustrated scene visually distinct from the dense controls. Scene layers may support parallax, sprite motion, and impact effects in a future renderer, gated on the rendering spike and its device evidence. This record describes a target composition; it does not select or validate a renderer.

The party panel is a 2×2 grid. The controlled hero has a persistent, clear highlight; other party frames show status, with target selection exposed only if the actual combat interface supports it. Portraits and role icons are future data-driven assets; current placeholders should use initials and must not hardcode classes or roles into the layout. Use consistent names and breadcrumbs for the system; all player-facing strings, including labels, tooltips, and empty states, must come from localization. Spanish is the POC default with English fallback.

## Battle controls and feedback

- Show only the active hero's authoritative skill loadout. Skill examples in a mockup are illustrative unless confirmed by that loadout. For example, Max with Taunt, Guard, Cleave (4s), and Shield Bash is a visual example, not a statement of the current starter loadout; Mend may be present in the actual loadout.
- Show an active potion count (for example, 2). Potion use is a player command subject to server validation.
- Make retreat visibly disabled during a boss encounter and expose the authoritative reason accessibly.
- Show an ally-healed confirmation after a successful heal; do not imply success before the server confirms it.
- Provide an Auto control and a queued-next-action indicator (for example, Guard queued for the next action). Distinguish queued intent from a resolved action.
- Keep the combat log collapsed by default; expose a clear control to expand it.

The composition may demonstrate concurrent effects without implying balance approval: Guard, lasting 2 attacks, and Bleed, lasting 3 seconds, on an ally; Regen, lasting 4 seconds, on another ally; and boss Taunt, lasting 3 attacks. Use distinct iconography plus text or accessible labels so duration and target are not conveyed by color alone. A boss telegraph may show “Crushing Blow” with a 2-second countdown and “Targeting Max.” These timings are visual examples, not new gameplay rules.

## Scope and safeguards

The POC is single-player: exactly one controlled hero acts, and party members are server-owned combat entities. Four-hero examples are presentation fixtures, not implemented network co-op. A four-person party arrangement in phase 2 is also not implemented co-op. This visual target does not approve new roles, skills, co-op, raids, or a renderer choice. Treat all unavailable features as future data or presentation hooks; do not present them as working controls.

Keep combat state and action outcomes server authoritative. Display durations according to server ticks and authoritative effect state; client animation may interpolate presentation but must not create offline combat controls or alter outcomes. Preserve readable state at 360px width, use at least 44px touch targets, support reduced motion, and provide text alternatives for important visual effects. Avoid relying on animation alone to communicate a state change.

## Review boundary

This document records the adopted visual direction from the reference mockup in text. The source image is private and is intentionally neither embedded nor linked here. No device validation is claimed; the renderer and performance decision remain gated by the real-device spike. Review this composition against issues #136 and #139 before implementation work expands its scope.
