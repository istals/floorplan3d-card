# Model builder guide (floorplan3d-card)

Instructions for whoever builds the house model. Hand this whole file to the model builder
session. The model describes **what exists**; Home Assistant decides **what it is connected to**
(floors, areas, entities, actions). Home Assistant ids in the model are suggestions only: an
object's `suggest.entity` lets the card bind it without setup, the user can change every binding
in the card and re-exports never break that.

Full design: [specs/2026-10-01-model-contract-design.md](superpowers/specs/2026-10-01-model-contract-design.md).

## Deliverable

One file: **`house.glb`** (binary glTF 2.0), under ~20 MB. No separate layout JSON is needed:
room outlines live inside the model.

## Coordinates

- Metres. glTF Y is up.
- Plan axes: **x = east, y = north**; in the glTF scene plan point (x, y) at height h is
  **(x, h, -y)**. "North" may be the house's own axis; the real compass angle is set in the card.
- Origin (0, 0, 0): south-west outer corner of the house, at ground floor finished floor level.

## Tagging: `fp` on nodes

Tag nodes with a small JSON object in glTF node `extras.fp`.
In Three.js set `node.userData.fp = { … }` before exporting: `GLTFExporter` writes `userData`
into `extras` automatically. (Blender: custom properties on the object, "Include custom
properties" in the glTF exporter.)

Every tag has:
- `kind`: `level` | `room` | `zone` | `object`
- `id`: lowercase `a-z 0-9 _ -`, max 64, **unique per kind and stable forever**. The card binds
  everything to ids. When you re-export, a lamp that moved keeps its id. Never give an old id to
  a different thing; for a new thing use a new id.
- `label` (optional): human name.

If your tool cannot write extras, name the node `fp:<kind>:<id>` (levels, rooms, zones) or
`fp:<type>:<id>` (objects), for example `fp:level:ground`, `fp:light:terrace_ceiling_1`.

## Structure

```
scene              (or one wrapper node, e.g. "house" with fp {views: [...]}, see Views)
├─ basement        fp {kind: level, id: basement, role: basement, order: -1, elevation: -2.6, height: 2.4}
│   ├─ storage     fp {kind: room, id: storage, outline: [...]}
│   └─ …
├─ ground          fp {kind: level, id: ground, role: storey, order: 0, elevation: 0, height: 2.89}
│   ├─ kitchen     fp {kind: room, id: kitchen, outline: [...], doors: [...]}
│   │   ├─ floor slab, cabinets …            (scenery)
│   │   └─ ceiling_light_1   fp {kind: object, type: light, id: kitchen_ceiling_1, …}
│   ├─ living_room …
│   ├─ walls, windows, stairs                 (scenery of the level)
│   └─ front_door  fp {kind: object, type: door, id: front_door, …}
├─ first           fp {kind: level, id: first, role: storey, order: 1, elevation: 3.25, height: 2.5}
├─ attic           fp {kind: level, id: attic, role: storey, order: 2, …}
├─ exterior        fp {kind: level, id: exterior, role: exterior}
│   ├─ terrace     fp {kind: zone, id: terrace, outline: [...]}
│   │   ├─ terrace_ceiling_1  fp {kind: object, type: light, …}
│   │   └─ terrace_ground_1   fp {kind: object, type: light, hints: {beam: up}}
│   ├─ garden      fp {kind: zone, id: garden, outline: [...]}
│   │   ├─ charging_station   fp {kind: object, type: dock, id: mower_dock}
│   │   └─ mower              fp {kind: object, type: mower, id: mower}
│   ├─ driveway    fp {kind: zone, id: driveway, outline: [...]}
│   ├─ gate        fp {kind: object, type: gate, id: driveway_gate, hints: {...}}
│   ├─ facade_lamp_1 … fp {kind: object, type: light, id: facade_1, hints: {beam: down}}
│   └─ fence, lawn, road, terrain              (scenery)
└─ roof            fp {kind: level, id: roof, role: roof}
```

Rules:
1. **Levels are top-level** (or children of one wrapper node, like `house` above). Every other
   node is inside exactly one level.
2. **One level per storey**, including basements. Fill `order` bottom-up (basement -1, ground 0,
   first 1 …), `elevation` (top of that storey's floor slab) and `height` (clear ceiling height).
3. **Exterior is its own level** (`role: exterior`): garden, terrace, drive, fence, lawn, road,
   outdoor lamps, gate, charging station, mower. Your views decide where it shows (usually in
   every view); the user can change that per view in the card.
4. **Roof is its own level** (`role: roof`). Storey views hide it; an overview (Exterior) shows it.
5. **Rooms (indoor) and zones (outdoor) are groups** inside their level, holding their own floor
   slab and furniture. Give each an `outline`: the inner floor polygon in plan metres
   `[[x, y], …]`, corners in order, no repeated closing point; neighbouring rooms share exact
   corner coordinates. Optional `doors`: points on the outline at the middle of each opening.
   One room per real room; a stair hall is a room too.
6. **Nothing larger than the plot inside a storey level.** World ground planes, roads and
   terrain go in `exterior` (or leave a world ground plane out entirely; the card has its own
   background).
7. Walls, windows, stairs, slabs can be untagged scenery of their level.
8. Walls stay at full storey height. **Each storey's ceiling belongs to the storey above** (the
   top storey's ceiling goes in the roof level), so hiding the upper level opens the view into
   the rooms. Tag ceiling meshes with `layer: ceiling`. Because the ceiling is the lowest
   geometry of the storey above, always fill that storey's `elevation`: without it the card
   measures the level from its lowest point and reads the ceiling's underside.
9. No lights, cameras, helpers, grids or text in the export. Lamps are objects (below), not
   three.js lights.
10. **One floor mesh per room.** Each room's floor slab is its own mesh inside its room group.
    Merge geometry per room or per layer, never across rooms or storeys: the card picks rooms
    by their floor and hides parts per room, level and layer.

## Views

Views are the buttons on the card (Exterior, Ground floor, Attic …). Put them in the model so
every install starts with the right set: `fp.views` on the root node, or on the single wrapper
node when the scene has one (the wrapper's `fp` has no `kind`, it only carries `views`).

```js
house.userData.fp = { views: [
  { id: 'exterior', label: 'Exterior', show: ['all'] },
  { id: 'ground', label: 'Ground floor', show: ['level:ground', 'role:exterior'], hide: ['level:attic', 'role:roof'] },
  { id: 'attic', label: 'Attic', show: ['level:ground', 'level:attic', 'role:exterior'], hide: ['role:roof'],
    camera: { position: [7.8, 22, 26], target: [7.8, 3, -5] } },
] };
```

- Listed in display order. `id`: same rules as tag ids, **stable forever** (the user's per-view
  edits, saved cameras and linked HA floors are stored by view id).
- `show`: when present, the view starts from nothing and shows these; `hide` is applied after.
  Rules cascade to children, and a later rule wins over an earlier one.
- `camera` (optional): `{ position, target }` in model world metres (Y up; the card applies the
  model's placement, so it follows a realignment). The card tweens to
  it when the view is opened and on **Reset view**; without one the camera stays where it is.
- `camera_top` (optional): `{ center: [x, y], zoom }`, the view's **Top** camera: centre in plan
  metres (x east, y north) and zoom > 0 (1 shows 20 m vertically; the horizontal extent follows
  the card width). Used when the
  view is opened in Top and on **Reset view** there; invalid values are ignored with a warning.
- `section` (optional): `{ normal: [x, y, z], constant }`, the view's **Side section** cut as a
  three.js plane in model world (the side where `normal · p + constant ≥ 0` stays), e.g.
  `{ normal: [-1, 0, 0], constant: 7 }` keeps x ≤ 7 m. Without one the card keeps the west half,
  cut through the middle of the storeys. Users can move it per view (Edit → Views → Side section).
  Use the prototype's presets as a starting point (see below).
- A view that shows every storey and the roof is an **overview**: all devices are shown. In a
  storey view the top visible storey is the view's storey: devices of lower storeys are hidden,
  outdoor devices stay.
- Without `views` the card generates one view per storey (lower storeys stacked under it) plus
  "All".

Selectors:

| selector | matches |
|---|---|
| `all` | the whole model |
| `level:<id>` | a level |
| `role:<storey\|basement\|exterior\|roof>` | every level with that role |
| `room:<id>` / `zone:<id>` | a room or zone |
| `object:<id>` / `type:<type>` / `group:<name>` | objects by id, type or group |
| `tag:<name>` | objects carrying the tag (Edit → Objects; by default the object's `group` and the HA labels of its entity) |
| `layer:<name>` | every node with that layer (below) |
| `node:<path>` | a node by its name path from the root, `/`-separated; `*` matches within a name, `**` across levels |

Reference for view sets, camera presets (`fp.views[*].camera`), controls and lighting:
[prototype-view-rules.md](prototype-view-rules.md) (the rules the prototype house uses: which
view shows which buckets, camera per view, what follows the view).

## Render recipe

`fp.render` on the root node (or the single wrapper, next to `views`) tells the card how the
model was meant to look. Every key is optional; missing keys keep the card's defaults (shown
below), unknown keys are ignored, out-of-range numbers are clamped with a warning
(`npm run check-model` lists them). The card option `render: default` ignores the recipe.

```js
house.userData.fp = { render: {
  toneMapping: 'ACESFilmic',   // None | Linear | Reinhard | Cineon | ACESFilmic | AgX | Neutral
  exposure: 1.25,              // 0.05..4
  outputColorSpace: 'srgb',    // srgb | srgb-linear
  pixelRatioMax: 1.5,          // 0.5..3 (the device pixel ratio is capped to this)
  anisotropy: 8,               // 1..16 (texture filtering at grazing angles)
  camera: { fov: 35, near: 0.3, far: 500 },  // fov 10..100; near / far start values, far is an upper bound
                                             // that never cuts the house or the sky dome
  sun: { shadowMapSize: 2048, bias: -0.0005, normalBias: 0.02 },  // map 256..4096 (power of two)
  lampShadows: { max: 4, mapSize: 512, bias: -0.004, normalBias: 0, radius: 1 },  // max 0..8
  day: { hemi: ['#c4d6ff', '#2a2520', 0.9], sun: ['#fff0dc', 2.6] },   // [sky, ground, intensity], [colour, intensity]
  night: { hemi: ['#c4d6ff', '#2a2520', 0.14], sun: ['#fff0dc', 0] },
  glowIntensityPerBrightness: 3,  // glow mesh emissive per unit of lamp brightness
} };
```

- Colours are `'#rrggbb'` strings or numbers (`0xrrggbb`). Day and night blend through dusk;
  clouds still dim the sun and soften its shadow on top.
- `lampShadows.max` asks for that many shadow-casting lamps. The card grants
  min(max, device cap): 4 on touch devices, screens with a pixel ratio above 2 or 4 CPU cores or
  fewer, else 8. The light pool is built once when the model loads (shadow lamps + 4 more point
  lights + 4 spots), so it never changes at runtime.

## Layers

`fp.layer` on any node (a string, or an array of strings) groups parts across rooms and levels,
so a view or the user can hide them in one go. Use these names where they fit (others are allowed):
`furniture`, `ceiling`, `roof`, `facade`, `fence`, `terrain`, `decoration`, `glass`, `stairs`.
A layer-only `fp` (`{ layer: 'furniture' }`) is not a tag: the node stays scenery of its room
or level. Tag the group of a piece (the sofa group, not each cushion) so a click picks the piece.

## Objects

Tag anything that should react to Home Assistant or be controllable. The card binds each object
to an entity by itself (from `suggest.entity`), so a well-tagged model works without any setup.

```json
{ "kind": "object", "id": "facade_lamp_1", "type": "light",
  "label": "Facade lamp 1",
  "group": "facade",
  "glow": "glow",
  "hints": { "beam": "down", "max": 5, "distance": 6, "decay": 2, "castShadow": false, "offset": [0, 0, 0.12] },
  "suggest": { "entity": "light.facade" },
  "ui": { "tap": "toggle", "hold": "popup", "popup": ["toggle", "brightness", "color"] } }
```

What the card reads (everything else in `fp` is kept for later and ignored):

- `id` (required, stable): the binding key. `label`: the name in the popup and the Objects tab.
- `type`: one of the types below. Unknown types work as `generic` (more-info / state popup).
- `glow`: name of the mesh inside the object that lights up or changes colour (bulb, glass, LED).
  Default `glow`. **One glow mesh per fixture**, with its own material: the card clones that
  material once and drives its emissive colour; a mesh shared by two fixtures shows the brighter one.
  Without a glow mesh the object gets no emissive look; its light still comes from the anchor.
- `anchor`: optional local point used when there is no glow mesh (default: the object's box centre).
  With a glow mesh the light, popup and labels sit at the glow mesh centre.
- `group`: fixtures of one circuit (all facade lamps) share a group name. They usually share one
  entity; the user can also give the group a controller entity in the card (a relay). A fixture is
  lit only while its own entity **and** the group controller are both on. A lit group gets one real
  light (at its middle fixture, 1.5 × brighter), not one per fixture.
- `suggest.entity`: the exact entity id to bind to automatically, if it exists in Home Assistant.
  Missing in HA: the object stays unbound and the Objects tab says "entity not found". There is no
  guessing by area or domain; the user can rebind any object in the Objects tab.
- `hints`: see below. Invalid values fall back to the defaults.
- `ui`: optional tap / hold actions and popup rows (see Actions).
- Model each object at its real place and size. Keep moving parts as their own nodes.

### Types

| type | look in the card | tap / hold (default) | hints read |
|---|---|---|---|
| `light` | glow mesh emissive in the light colour (brightness / 255 × 3, less for large glow meshes) + a real light | toggle / popup | `beam`, `max`, `distance`, `decay`, `angle`, `penumbra`, `target`, `castShadow`, `offset` |
| `light_strip` | the whole glow mesh emissive; a real light only when `max` is set | toggle / popup | as `light` |
| `mower` | the node follows the mower's live position and heading; glow green mowing, amber returning, red error | popup / more-info | `front`: `+x` / `-x` / `+z` / `-z` (which local axis is the nose, default `+x`) |
| `dock` | LED mesh lit while the mower is docked | more-info / more-info | `led`: LED mesh name (default `led`) |
| `ev_charger` | LED green charging, blue ready, red error; a power label while charging | more-info / popup | `led` |
| `climate` | a label with the current temperature; glow warm heating, cool cooling | more-info / popup | — |
| anything else | no change in look | more-info / popup | — |

Later types (`door`, `gate`, `cover`, `fan`, `vacuum`, …) can be tagged already; they behave as
`generic` until the card supports them.

### Light hints

| key | meaning | default |
|---|---|---|
| `beam` | `point`, `spot`, `down`, `up` or `updown` (alias `both`: washes the wall above and below; a point light) | `point` |
| `max` | light intensity at full brightness (real light = brightness / 255 × `max`) | 5 |
| `distance` | metres the light reaches (0 = no limit) | 0 |
| `decay` | fall-off (2 = physical) | 2 |
| `angle` | spot cone, degrees (5–80) | 24 |
| `penumbra` | spot edge softness 0–1 | 0.6 |
| `target` | `[x, y, z]` model point a spot aims at | straight down |
| `castShadow` | `false` keeps the lamp out of the (at most 4) shadow casters | true |
| `offset` | `[x, y, z]` metres added to the light position (model axes) | none |

The card owns a fixed pool of 12 real lights (8 point, 4 spot) and gives them to the lit fixtures in
view, largest `max` first; the rest glow without a light. At most 4 point fixtures without a group
cast shadows. Give the important room lamps the larger `max`.

**Wall lamps:** put the light 12 cm in front of the wall, either by placing the glow mesh there or
with `offset` (e.g. `[0, 0, 0.12]` on a south wall), otherwise the lamp lights its own wall harshly.
**Decals and glow planes** on a surface (LED dots, light panels) sit 2–5 mm in front of it so they
don't flicker (z-fighting).

### Actions (optional `ui`)

- `ui.tap_action`, `ui.hold_action`, `ui.double_tap_action`: Home Assistant actions
  (`{ "action": "navigate", "navigation_path": "/lovelace/lights" }`, `toggle`, `more-info`, `url`,
  `perform-action`, `assist`, `popup`, `none`; see the README's Actions). The older `ui.tap` /
  `ui.hold` strings (`"toggle"`, `"more-info"`, `"popup"`, `"none"`) still work. The type default
  otherwise; the Objects tab and the card YAML `actions:` override the model.
  Toggle acts on the object's entity, else its group controller.
- `ui.popup`: rows of the popup, in order: `toggle`, `brightness`, `color`, `state`, `battery`,
  `power`, `energy`, `temperature`, `mode`, `start_dock` (mower start / dock). Rows that don't apply
  to the bound entity are left out. Grouped fixtures also show the group controller and why a
  fixture is dark ("Facade switch is off").
  Links at the bottom: `history`, `logbook`, `statistics` and `{ "label": "…", "navigate": "/…" }`
  or `{ "label": "…", "url": "https://…" }`.

## Re-exporting

- Keep every `id`. Moving, resizing or remodelling an object is fine.
- New object: new id. It appears in the card as unassigned.
- Removed object: its assignment is kept in the card in case the id comes back.
- Do not rename levels or rooms casually; if you must, tell the user (they reassign once).
- Keep view ids too; changing a view's `show` / `hide` / `camera` is fine. Keep the names of
  groups the user may have hidden by clicking (they are stored as `node:` paths).

## Checklist before handing over

- [ ] One `.glb`, metres, Y up, origin at the south-west house corner, north = -Z.
- [ ] Top-level levels only: storeys (with `order`, `elevation`, `height`), `exterior`, `roof`.
- [ ] Every room and outdoor zone tagged, with `outline` (and `doors`); one floor mesh per room.
- [ ] Ceilings in the storey above (`layer: ceiling`), furniture on `layer: furniture`.
- [ ] `fp.views` on the root / wrapper, ids stable, cameras from the presets if you have them.
- [ ] Every lamp, the charging station, mower, gate, garage door, blinds … tagged as objects with
      stable ids, glow mesh named where it matters, moving parts as separate nodes with `hinge`.
- [ ] No mesh larger than the plot inside a storey; no world ground plane in storeys.
- [ ] No lights / cameras / helpers in the export. Under ~20 MB, textures ≤ 2048 px.
- [ ] `node tools/check-model.mjs house.glb` reports OK (run it in the floorplan3d-card repository).

## Example (Three.js)

```js
const ground = new THREE.Group();
ground.name = 'ground';
ground.userData.fp = { kind: 'level', id: 'ground', role: 'storey', order: 0, elevation: 0, height: 2.89 };

const kitchen = new THREE.Group();
kitchen.name = 'kitchen';
kitchen.userData.fp = { kind: 'room', id: 'kitchen', label: 'Kitchen',
  outline: [[7.47, 0.42], [10.12, 0.42], [10.12, 4.17], [7.47, 4.17]], doors: [[7.47, 2.295]],
  suggest: { area: 'kitchen' } };
ground.add(kitchen);

const lamp = buildCeilingLamp();              // a Group with a child mesh named "lamp_glass"
lamp.name = 'kitchen_ceiling_1';
lamp.position.set(8.8, 2.85, -2.3);           // plan (8.8, 2.3) at 2.85 m
lamp.userData.fp = { kind: 'object', id: 'kitchen_ceiling_1', type: 'light', glow: 'lamp_glass',
  hints: { beam: 'point', max: 20, distance: 8, decay: 2 }, suggest: { entity: 'light.kitchen_ceiling' } };
kitchen.add(lamp);

const exterior = new THREE.Group();
exterior.name = 'exterior';
exterior.userData.fp = { kind: 'level', id: 'exterior', role: 'exterior' };
const dock = buildDock();
dock.userData.fp = { kind: 'object', id: 'mower_dock', type: 'dock', hints: { led: 'dock_led' },
  suggest: { entity: 'lawn_mower.mower' } };
exterior.add(dock);
```
