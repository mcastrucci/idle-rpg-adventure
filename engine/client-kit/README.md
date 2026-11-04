# `@engine/client-kit`

## World map

`WorldMap` renders the engine-neutral presentation projection as SVG routes and accessible map controls. Import
`WorldMap` plus `WorldMapView`, `WorldMapLabels`, and `WorldMapTheme` from this package. RPG or other game adapters map
their protocol DTO to `WorldMapView`; the engine does not import game predicates, names, or protocol packages.

`WorldMapView` contains a hub, visible areas, and their routes. An absent area is hidden: producers should omit hidden
area IDs, names, reasons, and connected routes. Visible locked areas include localized `lockedReasons`; action flags on
a locked area are ignored by the component and its Enter CTA stays disabled. Completion is an optional generic count;
game-specific progress and status copy can be supplied through `details` and `badges`.

The host supplies localized strings through `labels`, optional theme color tokens through `theme`, and action callbacks
for hub/area selection, entering an area, and starting an idle activity. Selecting a node opens the detail sheet; it
does not run an action. Map positions use the view's `size` coordinate system, defaulting to 1000 × 620; authored
points are uniformly fitted and centered so relative placement survives compact or large source coordinates. Missing
or colliding positions receive a stable presentation layout with room for touch targets.

`labels` requires `mapLabel`, `zoomIn`, `zoomOut`, `resetZoom`, `hubAction`, `enterArea`, `startIdle`, `completion`,
`locked`, `idleAvailable`, and `closeDetails`. `theme` accepts optional `accent`, `accentContrast`, `surface`,
`surfaceRaised`, `text`, `mutedText`, `route`, `locked`, and `border` colors. The app owns localization, theming, and
which callbacks are provided.

Nodes remain keyboard focusable and use measured, inverse-scaled hit areas and labels so their target stays at least
44 CSS px and their label remains 13 CSS px as the map resizes or zooms. Pointer drag pans, two pointers pinch-zoom,
and the visible controls zoom in, zoom out, or reset. The implementation is covered by happy-dom interaction tests;
final browser/device rendering still needs a 360 px mobile playtest.

## Scene viewport

`createSceneRenderer()` returns a generic `SceneRenderer` (ADR-0010): `mount(container)`, `loadScene(spec)`,
`transitionTo(spec)`, `setRegions`, `resize`, `setReducedMotion`, `destroy`, and `on('regionTap' | 'contextLost' |
'contextRestored')`. A `SceneSpec` is a background image, optional layers and circular regions in the background's pixel
space; images are `{ key, width, height, load() }` so decoding happens in the preload step. The engine knows no game
concepts: a tap reports the region ID and the host issues the same command its DOM control does.

PixiJS v8 is loaded with a dynamic `import()` only when a viewport is mounted. `mount` resolves `'fallback'` (and draws
nothing) when WebGL or the library is unavailable. Budget: DPR capped at 2; the next scene is decoded and uploaded
before the fade starts; at most two scenes are resident and the previous one's textures are destroyed after the
transition; the fade is at most 1 s and becomes an instant cut under reduced motion, while hidden, or while the context
is lost; rendering is on demand and stops while the document is hidden.
