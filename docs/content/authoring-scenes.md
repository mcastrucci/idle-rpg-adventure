# Authoring scenes with Tiled

Scene geometry is optional and is compiled only when a location declares `"scene": "scenes/<area>/<location>.tmj"`.
Gameplay IDs and meaning stay in the location JSON. The compiler imports geometry and checks exact name parity; it
does not run Tiled scripts, contact a network, inspect image pixels, or publish assets.

Adding a playable location also requires adding its ID to the owning area's `locations` array and authoring the graph
connection in location JSON (including the matching exit in the adjacent location when the route is bidirectional).
The `.tmj` file only supplies geometry; it does not create world ownership or graph edges.

## Checklist: add a location with data only

No TypeScript is involved. For a new location `loc:<area>.<name>` in an existing area:

1. Put the background image next to the map, e.g. `scenes/<area>/<name>.png`. Inside the `.tmj`, the image layer path is
   relative to the `.tmj` file (`<name>.png`); the compiled record stores it relative to the content root.
2. Save the map as `scenes/<area>/<name>.tmj` with the layers and settings below. Omit object layers you do not need
   (for example `resources` and `enemyAnchors` when the JSON declares none).
3. Add `world/locations/<area>/<name>.json` with `"scene": "scenes/<area>/<name>.tmj"` and an `exits[]`/`hotspots[]`/
   `resources[]`/`enemyAnchors[]` entry for every object in the map, using the exact names.
4. Add the location ID to the area's `locations` array and add an exit to it in the neighbouring location's JSON (plus
   the return exit in the new location). Neighbours without a `scene` need no geometry for their exits.
5. Run `pnpm content:validate` (or `pnpm content-cli build ... --out <file>` to see the bundle).

Common failures: `scene.entityParity` (a JSON exit/hotspot/resource/anchor and the Tiled objects differ by name),
`scene.mapOrphan` (a `.tmj` that no location's `scene` references), `scene.mapMissing` (a `scene` path with no `.tmj`).

[`no-code-location.test.ts`](../../games/rpg/tools/content-plugin/src/no-code-location.test.ts) automates exactly these
steps on a copy of the real content, including the three failures above.

## Tiled map settings

- Save as Tiled JSON (`.tmj`) under `content/scenes/`.
- Use a finite, orthogonal map with positive integer width, height, tile width and tile height.
- Add exactly one image layer for the background. Its local image path must resolve to a regular file inside the
  content root, must not use `..`, an absolute path, a URL, or a backslash. When `imagewidth` or `imageheight` is
  present, it must match the corresponding map pixel dimension (`map width × tile width` or `map height × tile height`).
  Tiled added these image-layer fields in 1.11.1, so earlier exports can omit them. The importer does not inspect image
  pixels; put the image alongside the map or in a child directory.
- Keep the image layer and object layers visible, fully opaque, at the map origin, with no parallax, scale, repeat,
  offset, tint, transparent-color, or non-normal blend mode. Objects must also remain visible and fully opaque.
  Custom properties, tile layers, tilesets, templates, polygons, ellipses, text and rotated objects are unsupported
  and produce errors. Hidden objects also produce errors. Map JSON is parsed as data only; no embedded scripts are
  evaluated.
- Add object layers named `exits`, `hotspots`, `enemyAnchors`, and `resources` as needed. Their objects must fit within
  the map bounds. Exits and hotspots are unrotated rectangles. Enemy anchors and resource placements are point objects.
  Tiled's JSON export represents point objects with `point: true` and normally includes `width: 0` and `height: 0`;
  the importer accepts those zero dimensions (or omitted dimensions) and rejects nonzero point sizes. Optional
  visibility, repeat, point, ellipse and numeric transform fields must have their documented JSON types; defaults may
  be omitted.

The supported fields follow Tiled's [JSON Map Format](https://doc.mapeditor.org/en/stable/reference/json-map-format/).
The importer intentionally supports only the scene subset described here; it does not claim to implement all of Tiled.

## Geometry names and JSON parity

Names are stable IDs, compared exactly and case-sensitively. Every JSON item needs one matching Tiled object, and every
Tiled object needs one JSON item:

| Tiled layer | Object name | JSON source |
| --- | --- | --- |
| `exits` | Exit `id`, such as `exit:grove.glade.entrance` | `location.exits[].id` |
| `hotspots` | Hotspot `id`, such as `old_stump` | `location.hotspots[].id` |
| `resources` | Runtime placement ID, such as `res:test_grove.herb_patch#0` | Resource `node` plus its zero-based occurrence among the same node in `location.resources[]` |
| `enemyAnchors` | Local stable ID, such as `foe_left` | `location.enemyAnchors[]` |

Resource placement IDs use the same occurrence order as the server's live resource IDs. Reordering repeated resource
entries therefore also changes which authored placement ID refers to each entry.

The importer emits a renderer-neutral record keyed by location ID, with the map's pixel dimensions, a canonical
content-root-relative background path, rectangle maps for exits and hotspots, and point maps for anchors and resources.
Scene-less content remains bundle format 1. A bundle with geometry is format 2 and includes a `scenes` map, which is
covered by its canonical SHA-256 content hash. Runtime boot validates the format, geometry bounds, location references,
and RPG entity parity before using the bundle.

## Tappable regions in the live view (#154)

When a location has scene geometry, the live view carries `scene: { width, height, regions: [{ id, kind, x, y, r }] }`.
Coordinates are in the Tiled map's pixel space (`width` x `height` is the map size in pixels, origin top left). Each
region is a circle around an exit or hotspot rect: its centre, and half of the larger side as radius. `kind` is `exit`
or `hotspot`, and `id` is the exit or hotspot ID of `exits[]` / `hotspots[]`, which carry the open/done state. The server
lists only exits and hotspots the viewer can currently see, so an undiscovered secret exit has no region. Resources and
enemy anchors are not sent.

The web client scales this space onto the background art (per axis: art size divided by map size), so a map authored at
the art's native size (for example 1086 x 1448) maps one to one. If the map is smaller or larger than the art, author it
with the same aspect ratio. The renderer keeps at least a 44 px tap target. Region 1 has DRAFT scene geometry (#168) under
`content/scenes/region_1/`, awaiting owner verification; each `.tmj` references a copy of its background WebP next to it,
because the importer only accepts images inside the content root. `seed_vault_heart` has no exits or hotspots, so no scene.

## Validation boundary

`content-cli validate` and `content-cli build` perform the local map and entity checks. Art size, texture memory,
renderer behavior, and real-device performance remain unvalidated until the #12 renderer spike establishes explicit
budgets and validates an authored scene on target devices. No texture limits are implied by this importer.

The compiler currently supports a deliberately small Tiled subset. If an authoring workflow needs transforms or tiled
layers, extend the format with documented semantics and tests before using those features in content.
