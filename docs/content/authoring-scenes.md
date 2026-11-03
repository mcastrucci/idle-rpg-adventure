# Authoring scenes with Tiled

Scene geometry is optional and is compiled only when a location declares `"scene": "scenes/<area>/<location>.tmj"`.
Gameplay IDs and meaning stay in the location JSON. The compiler imports geometry and checks exact name parity; it
does not run Tiled scripts, contact a network, inspect image pixels, or publish assets.

Adding a playable location also requires adding its ID to the owning area's `locations` array and authoring the graph
connection in location JSON (including the matching exit in the adjacent location when the route is bidirectional).
The `.tmj` file only supplies geometry; it does not create world ownership or graph edges.

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

## Validation boundary

`content-cli validate` and `content-cli build` perform the local map and entity checks. Art size, texture memory,
renderer behavior, and real-device performance remain unvalidated until the #12 renderer spike establishes explicit
budgets and validates an authored scene on target devices. No texture limits are implied by this importer.

The compiler currently supports a deliberately small Tiled subset. If an authoring workflow needs transforms or tiled
layers, extend the format with documented semantics and tests before using those features in content.
