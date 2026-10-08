# floorplan3d-card — Home Assistant 3D floorplan

Custom Lovelace card (Three.js) for a home floorplan. Goal: map HA areas to rooms
once, then every device assigned to an area shows up on the plan automatically, positioned
by device type, with mouse-drag for exact placement. Plus Sunseeker robot mower live
position and map overlay.

## Stack
- Vanilla custom element (no Lit), Three.js 0.169, esbuild bundle -> `dist/floorplan3d-card.js`
- OrbitControls, CSS2DRenderer (markers/labels as DOM, so `<ha-icon>` works), GLTFLoader
- Companion integration `custom_components/floorplan3d/` for shared server-side storage
- Respect HA theme CSS vars (--card-background-color, --primary-color, --primary-text-color,
  --divider-color, --state-light-active-color). Light and dark themes must both look right.

## Already written (src/)
- `placement.js` — polygon geometry, type rules (domain/device_class -> anchor + height),
  `autoPlace(room, markers, roomHeight)`. Anchors: center (ceiling grid), wall, corner, door.
- `registry.js` — builds markers from `hass.entities` / `hass.devices` / `hass.areas` /
  `hass.floors` (live, available to non-admin users, no websocket calls needed). Groups
  entities per device, picks primary entity by domain priority, skips config/diagnostic and
  hidden entities. Icons, active state, value display.
- `mower.js` — read position from entity (gps: latitude/longitude attrs or "lat,lon" state;
  xy: configurable attributes), calibration: 1 pt translate, 2 pts similarity, 3+ pts
  least-squares affine. `overlayUrl()` for image./camera. entities via entity_picture.
- `storage.js` — LayoutStore: companion integration WS -> `frontend/set_user_data` -> localStorage.

Review these, fix bugs, add unit tests (vitest) for placement + mower math.

## Coordinates
Plan metres: x = east, y = north, z = height above floor. Three.js world:
`(x, floorElevation + z, -y)` so north is up in top view. Wall box rotation.y = atan2(dy, dx).
Floor shape: ShapeGeometry rotated -90° about X.

## Layout data (stored, not in YAML)
```json
{ "version": 1,
  "floors": [{ "id": "ground", "name": "Ground floor", "elevation": 0, "height": 2.7 }],
  "rooms": [{ "id": "r1", "area_id": "kitchen", "floor_id": "ground", "polygon": [[0,0],[4,0],[4,3],[0,3]],
              "doors": [[2,0]], "outdoor": false }],
  "pins": { "device:abc123": { "x": 1.2, "y": 0.4, "z": 2.6, "floor_id": "ground" } },
  "hidden": ["device:xyz"],
  "mower": { "entity": "device_tracker.mower_position", "source": "gps", "x_attr": "x", "y_attr": "y",
             "floor_id": "ground", "calibration": [{ "src": [45.0, 10.0], "plan": [10, -5] }],
             "overlay": { "entity": "image.mower_map", "x": 0, "y": 0, "rotation": 0, "width": 30,
                          "opacity": 0.6, "refresh": 10 } } }
```
Floors auto-sync from HA floors (`hass.floors`, elevation = level * 3). Room floor defaults to
the area's floor_id.

## Card YAML (minimal)
```yaml
type: custom:floorplan3d-card
layout_key: default      # storage key
height: 520px
group_by: device         # device | entity
wall_height: 1.0         # cut-away display height
model: /local/house.glb   # optional underlay from the existing Three.js design
model_position: [0, 0, 0]
model_rotation: 0
model_scale: 1
```

## Behaviour
View mode:
- Floor chips (each floor + All), 3D / Top view toggle, edit button (admins only).
- Marker tap: toggle for light/switch/fan/input_boolean, otherwise more-info.
  Long-press (500 ms): more-info (`hass-more-info` event, bubbles + composed).
- Lights that are on: additive radial glow on the floor, colour from rgb_color, strength from brightness.
- Marker shows secondary sensor value (e.g. temperature) when the device has one.

Edit mode (side panel, tabs Rooms / Devices / Mower / Data):
- Rooms: list every HA area with status (room drawn / missing) and a Draw button. Draw =
  click corners on the plan, snap 0.05 m and to existing vertices within 0.25 m (shared walls),
  close by clicking first point or Enter, Esc cancels. Select room -> drag vertex handles,
  change area, outdoor toggle, set door (click near an edge), delete. Floor management.
- Devices: drag any marker -> becomes pinned (saved). Selected marker: height input,
  "Return to auto placement", Hide. List devices whose area has no room yet. Unhide list.
- Mower: pick entity, source gps/xy, attribute names, floor. Calibration: "Add point" takes
  current reading, then click where the mower really is. Overlay: image/camera entity,
  sliders x / y / rotation / width / opacity + drag-to-move tool; camera refreshes every N s.
  Live marker (mdi:robot-mower).
- Data: export / import layout JSON, show which storage backend is active (warn if not shared).
- Click vs orbit: pointer move < 5 px counts as a click. Disable OrbitControls while dragging.
- Render loop only while connected; render when controls change or state dirty.
- Rebuild markers only when registry objects change identity; per-hass-update just refresh states.
- Remove CSS2D elements from the DOM on dispose (removing the object does not remove the element).

## Sunseeker
Integration: HACS "Sunseeker robotic mower" (github.com/Sdahl1234/Sunseeker-lawn-mower).
Wireless models expose a Map image entity, a Live map camera entity, a Work region sensor and
a Mower position (GPS derived from map coordinates). Inspect the real entities in your HA
(Developer tools -> States) and adapt attribute names. Optional local alternative:
iiseppi/sunseeker_local_control (MQTT).

## Companion integration
`custom_components/floorplan3d/`: manifest.json, `__init__.py` with `async_setup` (enabled by
`floorplan3d:` in configuration.yaml), `homeassistant.helpers.storage.Store` (key
`floorplan3d.layouts`), websocket commands `floorplan3d/layout/get` {key} and
`floorplan3d/layout/set` {key, layout} (set requires admin).

## Repo / delivery
- GitHub (`origin`) is the main remote; HACS installs it as an Integration from release
  `floorplan3d.zip` (integration with the card bundled; it registers the card via
  add_extra_js_url). Manual: copy `custom_components/floorplan3d/` after `npm run build`.
- CI: `.github/workflows/ci.yml` (lint, vitest, build, headless checks, pytest);
  `release.yml` on `v*` tags builds the zip and creates the release.
- Add `npm run deploy` that scp's dist + integration to the HA host (host from .env, not committed).
- `demo/index.html` with a mock `hass` object (few areas, floors, lights, sensors, a fake mower
  moving in a circle) for testing without HA. Verify with a headless browser screenshot.

## Order of work
1. Scaffold (package.json, esbuild, vitest, eslint), tests for existing modules.
2. Card: scene, floors, rooms, walls, markers, glow, view mode. Demo page.
3. Edit mode: room drawing/editing, marker drag + pins, storage.
4. Companion integration.
5. Mower: live position, calibration, overlay.
6. GLB underlay import; export helper for the existing Three.js house design
   (GLTFExporter snippet to run in its browser console).
7. README with install + usage, in English.
