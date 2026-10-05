# Floorplan 3D for Home Assistant

A Lovelace card that shows your home as a 3D floorplan with every device on it. Draw each room
once and link it to a Home Assistant area. After that, every device assigned to the area appears
in the room by itself, placed by type: lights on the ceiling, door sensors by the door, other
sensors on the walls. Drag any of them to its exact spot. Also shows a robot mower's live
position over its map.

![3D view](docs/images/view-3d.png)

- Floors from Home Assistant, a chip per floor plus "All", 3D and north-up top view; with a
  3D model the chips are the model's views (Exterior, Ground floor, …), linked to HA floors
- Tap toggles lights, switches, fans and input booleans; other devices (and long-press) open
  the more-info dialog
- Lights that are on cast a glow on the floor in their colour and brightness
- Markers show a value next to the icon (temperature, power, …)
- Edit mode for admins: draw rooms, doors, floors, pin and hide devices, import/export
- One layout shared by every user and device (stored by the companion integration)
- Robot mower: live position, trail, map image or camera overlay, point calibration
- Optional 3D model of the house (.glb) under the plan: views per storey (upper storeys and the
  roof hidden), click a part to hide it in a view, saved cameras, pick a room's outline from the
  model, and a Day / Night button for lighting
- Day / Night button cycles Auto, Day, Night (remembered per device). Auto follows `sun.sun`: the
  sun's light and shadows point where the real sun is (using the model's `north`), and the house
  darkens smoothly through dusk; without `sun.sun` it stays Day
- Sun and moon in the sky (3D view with a model): the sun where `sun.sun` puts it, the moon from
  your Home Assistant location (`latitude` / `longitude`) with its current phase, and faint cool
  moonlight on moonlit nights
- Model objects are the controls: lamps glow and really light rooms and the facade (night is dark,
  the lamps carry it), tap a lamp to toggle it, hold it for brightness and colour; the mower model
  drives on the plan, the dock, EV charger and climate units show their state. Objects bind to
  their entities from the model's suggestions without setup
- Follows the HA theme, light and dark

## Install

The repository is a Home Assistant integration that also serves the card, so one install
covers both. The integration stores the layout and makes it available to all users.

### HACS

1. HACS → ⋮ → Custom repositories → add `https://github.com/istals/floorplan3d-card`,
   type **Integration**.
2. Search for **Floorplan 3D** in HACS and download it.
3. Restart Home Assistant.
4. Settings → Devices & services → **Add integration** → **Floorplan 3D** → Submit.
5. Reload the browser.

### Manual

1. Download `floorplan3d.zip` from the [latest release](https://github.com/istals/floorplan3d-card/releases)
   and extract it to `/config/custom_components/floorplan3d/`
   (or build it yourself: `npm ci && npm run build`, then copy `custom_components/floorplan3d/`).
2. Restart, then Settings → Devices & services → Add integration → **Floorplan 3D**.

`floorplan3d:` in `configuration.yaml` also works; it is imported as the integration entry.

The card is loaded on every dashboard automatically; you do not need to add a resource.
If you only want the card without the integration, add `floorplan3d-card.js` from the release
as a dashboard resource (Settings → Dashboards → ⋮ → Resources, type JavaScript module). The
layout is then stored per user, or per browser on old HA versions; the Data tab says which.

## Add the card

Dashboard → Edit → Add card → search **Floorplan 3D** (or Manual: `type: custom:floorplan3d-card`).
The options below can be set in the visual editor or in YAML.

| Option | Default | |
|---|---|---|
| `layout_key` | `default` | Name of the stored layout. Use different keys for different plans. |
| `height` | `520px` | Card height. |
| `group_by` | `device` | `device`: one marker per device. `entity`: one per entity. |
| `wall_height` | `1.0` | Height of the cut-away drawn walls in metres (rooms drawn on the card; a model is cut at its storey height instead). |
| `occlusion` | `true` | With a model: markers hidden behind a wall from the current camera angle are shown faint (25 %) and can't be tapped; in edit mode they stay half visible and draggable. Checked once the camera has been still for 150 ms; not in top view. `false` turns it off. |
| `merge` | `true` | With a model: static parts that share a room / zone / level / layer group and a material are merged into one mesh when the model loads (far fewer draw calls; Edit → Model shows "Draw calls: before → after"). Objects, glass and other transparent parts, `<room>_floor` pieces and parts named by a `node:` view rule stay separate. `false` keeps every part (reloads the model). |
| `sky_bodies` | `true` | With a model: sun and moon discs on a dome around the house with a compass ring (moon position and phase from the HA location) and faint moonlight at night. `false` hides the discs and the ring. |
| `view` | `3d` | Start in `3d` or `top` view. |
| `floor` | first floor with rooms | Floor id (or view id) to show first, or `all`. |
| `view_id` | | View to show first (with a model: a view id such as `ground`). Wins over `floor`. |
| `room_labels` | `size` | Room labels: `size` (name and size, e.g. `Office · 4.5 × 5.0 m`, or `m²` for other shapes), `name`, or `none`. |
| `zoom_to` | `center` | Zoom pivot: `center` zooms (and rotates) around the view's rotation centre, `cursor` zooms towards the mouse pointer. A view can override it (see Camera). |
| `views` | | Per-view overrides by view id (see Views). |
| `model` | | URL of a `.glb` model, e.g. `/local/house.glb`. |
| `model_position` | `[0, 0, 0]` | Model offset in plan metres `[east, north, up]`. |
| `model_rotation` | `0` | Model rotation in degrees, counter-clockwise. |
| `model_scale` | `1` | Model scale (e.g. `0.01` for a centimetre model). |
| `model_opacity` | `1` | Model opacity, `0`–`1`. |
| `lights` | `auto` | With a model: `auto` gives lit lamps real lights (at most 12, 4 with shadows); `off` keeps them glowing only (for weak tablets). |
| `actions` | | Tap / hold / double tap actions for objects and markers (see [Actions](#actions)). |
| `model_floors` | auto | Which HA floor each model level belongs to, e.g. `{ground: floor1, attic: floor2}` (for a `model:` URL; uploads set it in the Model tab). |

## Set up the plan

Click **Edit** on the card (admins only). The panel has tabs Rooms, Devices, Objects (with a
model that has objects), Mower, Views, Model and Data.

![Edit mode](docs/images/edit-rooms.png)

**Rooms.** Every HA area is listed as *drawn* or *missing*. Click **Draw** and click the
corners of the room on the plan. Points snap to 5 cm, to existing corners within 25 cm (so
neighbouring rooms share walls exactly), and line up with nearby corners. Click the first point
or press Enter to finish, Backspace removes the last point, Esc cancels.
With a model loaded, **Pick** takes the outline from the model instead: click the room's
floor. A tagged room is linked to the area directly; an untagged floor is traced and previewed,
then **Use this outline** or **Draw instead** (Esc cancels).
Select a room (click it, or **Select** in the list) to:
- drag its corners, drag an edge's middle handle to add a corner, right-click a corner to delete it
- **Add door**, then click on a wall
- change its area or floor, mark it **Outdoor** (terrace, garden: no walls), delete it

Floors come from HA (Settings → Areas → Floors) with elevation = level × 3 m. Without a model,
adjust elevation and ceiling height per floor under *Advanced* at the bottom of the Rooms tab;
with a model the heights come from the model.

**Devices.** Every device with an area appears in that area's room. Drag a marker to pin it; set
its height above the floor; **Return to auto placement** removes the pin; **Hide** removes it
from the plan. With a model the dragged marker sticks to the surface under the pointer (5 cm off
it, on the floor of that level); dropped on a model object (lamp, mower, …) it attaches and
follows that object's position (not its rotation, e.g. the mower's heading). **Detach** keeps it
where it is as a normal pin. Hold **Alt** while dragging for a free drag at the current height. While
dragging over the model a ring marks the target spot and the surface is tinted; over a model
object a label reads "Attach: <object>". Devices whose area has no room yet, and hidden devices, are listed here.

With a model, auto-placed (not pinned) devices sit on the model's real surfaces: wall, corner and
door devices on the nearest wall of their room (within 2.5 m), ceiling devices (lights, fans,
smoke) 5 cm below the ceiling, floor devices (vacuum, mower) on the floor. Where no surface is
found the computed spot stays. **Stick all to surfaces** (Devices tab) moves pinned markers that
float more than 15 cm from any surface onto the nearest suitable one; it shows how many will
move, with Apply / Cancel.

**Objects.** (Only with a model that has objects.) The model's objects grouped by level and room,
each with its entity: *auto* means bound from the model's `suggest.entity`; type another entity
to rebind, empty returns to auto, `none` leaves it unbound. *entity not found* means the entity
doesn't exist in HA (the object stays unbound). **Tap / Hold / Double tap** pick the object's
[actions](#actions) (*Default* = the model's or the type's action; navigate, url and perform-action
show the fields they need and flag a missing one). **Test** toggles it like a tap, **Hide** ignores the
object as a control (dark, and its device gets its marker back). Click an object in the view to
find its row. *Groups*: a fixture group (e.g. all facade lamps) can get a controller entity, a
relay that must be on too; empty or `none` removes it, an unknown entity is ignored and flagged.
See [Lamps and objects](#lamps-and-objects).

**Mower.** See below.

**Views.** See [Views](#views).

**Model.** Upload or replace a 3D model of the house (.glb, up to 100 MB; needs the
integration, see below) and line it up with the plan using the sliders (east, north, up,
rotation, opacity) and scale. For a tagged model the tab lists its levels and rooms/zones:
choose which HA floor each level belongs to (*auto*, a floor, or *no floor*) and assign each room
or zone to an HA area. Defaults follow level order and the tag's suggested area. Click a part
of the model in the view to find it in the lists. A report shows errors and warnings found
in the model's tags, and a "no longer in the model" list shows assignments whose level or
room was removed by a re-export, with **Forget** to drop them. See
[docs/model-builder-guide.md](docs/model-builder-guide.md).

**Data.** Export and import the layout as JSON, and see where it is stored. *Shared* means the
integration is active and everyone sees the same plan.

Coordinates are metres, x = east, y = north. A layout prepared elsewhere (for example from an
existing house model) can be imported here; see [docs/house-model-spec.md](docs/house-model-spec.md)
for the format.

## Robot mower

Works with any entity that reports a position:
- **GPS**: `latitude` / `longitude` attributes (device trackers), or a `"lat,lon"` state
- **x / y**: map coordinates in two attributes, names configurable
- **Live map image**: no position entity needed; the mower icon is found by its colour in the map
  image or camera, and the map overlay alignment maps it onto the plan

For the Sunseeker integration ([Sdahl1234/Sunseeker-lawn-mower](https://github.com/Sdahl1234/Sunseeker-lawn-mower)),
pick the mower position entity with source GPS and the *Map* image entity (or *Live map* camera)
as overlay. Check the attribute names in Developer tools → States first.

In the **Mower** tab:
1. Pick the position entity, the source and the floor (usually the ground floor).
2. Calibrate: drive or carry the mower to a spot you can find on the plan (a corner of the lawn,
   the charging station), click **Add point**, then click that spot on the plan. One point aligns
   a GPS track north-up, two points also fix rotation and scale, three or more also correct skew.
   Spread the points far apart. The fit error is shown for 3+ points.
3. Overlay: pick the image or camera entity, then line it up: **Align by points** (click a spot
   on the map image, then the same spot on the model; two points fix position, rotation and size,
   more refine it by least squares; **Done** or Esc ends), then fine-tune with the sliders or
   **Move with mouse**. Cameras refresh every N seconds; images when they change.
   The map lies on the model's surface under its centre (2 cm above the lawn, whatever the HA
   floor's elevation; without a model: on the mower's floor). **Height offset** (−0.5…+0.5 m)
   lifts or lowers it. Model objects (the mower, furniture) draw over it.
   **Show the map only in edit mode** hides it in view mode; the live-map detection keeps working.

The mower's own marker follows the live position and draws a trail for the current session.

### Map picture (Sunseeker live map)

The live map is mostly dark green (unmowed), with light mowed stripes, grey no-mow areas, a boundary
line and a large mower icon. Under **Map picture** in the Mower tab, each refresh of the picture is
processed once before it is drawn on the lawn (large pictures on a copy at most 1024 px wide):
- **Pick background colour**, then click the dark green on the map: it becomes transparent, so the
  model's lawn shows through. Without a background colour the picture is drawn as it is.
- **Pick mowed colour** (click a light stripe): mowed pixels stay as subtle light stripes.
- **Pick no-mow colour** (click a grey area): no-mow areas are drawn dark, translucent and hatched.
- Each picked colour has a **Tolerance** slider and a **Clear** link.
- **Hide mower icon on the map** (live map image source; on by default): the detected icon (plus
  3 px) is removed from the picture, so only the mower model or marker shows the mower.
- **Clip to zone**: pixels outside the zone outline are not drawn. *Automatic* uses the model zone
  (room or outdoor outline) under the map's centre, e.g. `garden`; or pick a zone, or *None*.
  The clip applies once a colour is picked or the icon is hidden.
- With a mowed colour, the mower popup and the Mower tab show **Stripes** (the stripe direction as
  a compass axis against true north, using the model's north and alignment, e.g. `60° (NE–SW)`) and
  **Mowed** (mowed pixels / zone pixels without no-mow areas and the icon; without a zone,
  mowed / (mowed + background)). **Show the stripe direction on the lawn** adds an arrow inside the zone.
- The picture is read once per refresh; the pixel work runs in a background worker where the browser
  supports it.

### Sunseeker without GPS (position from the live map image)

Models without latitude / longitude still render a map with the mower on it. In the **Mower** tab:
1. Pick the mower entity (e.g. its `lawn_mower.*` entity; its marker follows the detection) and
   source **Live map image (mower icon colour)**.
2. Add the *Live map* camera (or *Map* image) as overlay and line it up with the plan
   (**Align by points**, sliders or **Move with mouse**). This alignment is the calibration: no
   calibration points.
3. Click **Pick mower colour**, then click the mower icon on the overlay (Esc cancels). The colour
   (median of the 5×5 pixels around the click) is shown as a swatch; widen **Colour tolerance** if
   the icon is shaded, narrow it if the lawn picks up matches.
4. The tab shows "Found at x, y (N px)" or "Mower icon not found". The image is read on every
   refresh (cameras: the overlay refresh interval, at least 2 s; images: when they change), only
   while the card is visible. Optionally read a different image entity with the same geometry
   (*Image entity*).

The image must come from Home Assistant itself (same origin) so the card can read its pixels;
otherwise the tab shows "Can't read the map image".

A mower object in the 3D model (type `mower`) replaces the mower device's marker: the model itself drives
around, turned to its direction of travel (`hints.front`: `+x` default, `-x`, `+z` or `-z` for the model's
front axis). Its popup shows state, battery and start / dock.

## 3D model underlay

![Model](docs/images/model.png)

Upload it on the card: **Edit → Model → Upload .glb**, then align it with the sliders. The file
is stored in `/config/floorplan3d/models/` and only served to logged-in users.

Alternatively put a `.glb` in `/config/www/` and set `model: /local/house.glb` in the card
(files in `www` are readable without login). A YAML `model` takes precedence over an upload.

Tag the model's parts (levels, rooms, zones, objects) so the card can use them: top-level
levels become floors, tagged rooms and zones become the card's rooms, so the model's outlines
replace hand-drawn ones. Format and examples: [docs/model-builder-guide.md](docs/model-builder-guide.md).
Untagged models still load and show whole.

In **Edit → Model** you choose which HA floor each level belongs to and assign each room to an
HA area. Defaults follow level order and the tag's suggested area, so most of it is automatic;
your choices are stored by id and survive re-exports. Click a part of the model in the view to
find it in the lists. A tagged model shows whole levels and is never clipped; only an untagged
model is cut, at the top of the view's highest storey (its elevation + storey height, 2.7 m when
unknown; per view, *Cut at storey height* in the Views tab). Check a model before uploading with
`npm run check-model -- house.glb`.

Rendering notes for model authors:
- **Shadows:** every mesh receives shadows; glass does not cast them, so light reaches rooms
  behind windows. No shadow is cast by meshes that are transparent, have opacity < 1 or
  transmission, are named like *glass / window / pane / glazing*, sit on an `fp.layer` of
  `glass`, `terrain`, `floor`, `decal` or `label`, or are flat (< 2 cm thick) overlays.
- The sun's shadow box covers the storey / basement / roof levels + 4 m (an untagged model:
  meshes up to 30 m across), not the whole plot, so shadows stay sharp. If the model root (or a
  top node) has `fp.north` (degrees), the sun's azimuth follows it (north + 0.35 rad).
- Meshes on an `fp.layer` of `decal` / `edging`, or named like *decal / edging / overlay*, are
  drawn in front of the surface under them (polygon offset), so they don't flicker.
- With `model_opacity` below 1 the model is blended but keeps writing depth, so overlapping
  parts don't vanish; originally transparent materials (glass) keep their own opacity.

### Lamps and objects

Objects tagged in the model (see the [model builder guide](docs/model-builder-guide.md#objects))
bind to Home Assistant entities by themselves (`suggest.entity`), and a device bound to an object
has no marker: the object is the control.
- **Lamps** (`light`, `light_strip`): the bulb glows in the light's colour and brightness and a real
  light lights the rooms and facade around it. The card uses a fixed pool of 12 real lights
  (8 point, 4 spot) for the lit lamps in view, largest first, and at most 4 of them cast shadows;
  a fixture group gets one light. Other lit lamps only glow. `lights: off` keeps glow only and
  takes the light pool out of the shaders (the switch recompiles them once). Shadow maps are
  redrawn only for lit lamps that changed and for the sun while it is up.
- **Day / Night:** the toolbar button cycles Auto, Day, Night. Auto follows `sun.sun`: by night
  the house is nearly dark and the lamps carry the scene; the sun's direction and shadows follow
  the real sun.
- **Sun and moon:** with a model the sun (down to 2° below the horizon) and the moon (while above
  it) sit on a dome around the house: house centre + their direction × the dome radius (1.4 × the
  house's half width, at least 12 m), so a low sun is near the faint compass ring on the ground
  (with an "N" at true north) and a high sun stands above the house; the house hides a disc behind
  it. Top view shows their azimuth on the ring (the top view frames the ring). Auto: the sun from
  `sun.sun`, the moon computed in the browser from the HA location (`hass.config.latitude` /
  `longitude`, low-precision formulas, well under 1° off) every 60 s, with the lit part by its
  illumination, lit on the right while waxing. At night (night factor > 0.5) a moon above the
  horizon adds a faint shadowless light from its direction (0.05 + 0.15 × illumination). Manual
  Day shows the sun at azimuth 200°, 40° high; manual Night a moon at 160°, 35° high, 80 % lit.
  Both use the model's `north` and alignment rotation. `sky_bodies: false` hides both discs and the ring.
- **Tap** a lamp to toggle it, **hold** (500 ms) for a small popup: on / off, brightness, colour,
  and for grouped fixtures the group controller and why a lamp is dark ("Facade switch is off").
  Esc or a tap outside closes it. Taps near an object (30 px, 52 px on touch) hit the object
  before markers. Other objects: mower popup (state, battery, start / dock), climate (temperature,
  mode), EV charger (state, power, energy); `fp.ui` in the model, the Objects tab or the card YAML
  can change tap / hold / double tap and the rows (see [Actions](#actions)).
- **Mower, dock, charger, climate:** the mower model drives where the mower is; the dock LED is
  lit while docked; the charger LED shows charging / ready / error with the power as a label; a
  climate unit shows its temperature and glows warm or cool while heating or cooling.
- **Edit mode:** bind objects in the Objects tab; in the Devices tab a dragged marker sticks to the
  model's surfaces and attaches to an object it is dropped on (Alt: free drag, Detach to undo).

### Actions

Objects and markers take Home Assistant's standard actions: `tap_action`, `hold_action` (500 ms)
and `double_tap_action`, each `{ action: ... }` with `toggle`, `more-info` (optional `entity`),
`navigate` (`navigation_path`), `url` (`url_path`: `http(s)://…` opens a new tab, a path starting
with `/` the same tab; other schemes are refused), `perform-action` (`perform_action`, `data`,
`target`; the older `service` / `service_data` work too), `assist`, `none`, plus `popup` (the
object's popup). `confirmation: true` (or `{ text: ..., exemptions: [{ user: <user id> }] }`) asks
first in a small dialog in the card, except for the listed users.
Later wins: the model's `fp.ui` (old `tap` / `hold` keys still work) → the Objects tab → the card
YAML `actions:`, keyed `object:<id>` (model objects), `<entity_id>` or `device:<device_id>` (objects
and markers):

```yaml
actions:
  object:lamp_hall:
    hold_action: { action: navigate, navigation_path: /lovelace/lights }
    double_tap_action:
      action: perform-action
      perform_action: light.turn_on
      target: { entity_id: light.hall }
      data: { brightness_pct: 100 }
  binary_sensor.front_door:
    tap_action: { action: more-info }
  object:mower:
    popup: [state, battery, start, dock, history, { label: Mower map, navigate: /lovelace/garden }]
```

Defaults: lamps toggle on tap and open the popup on hold; markers toggle lights / switches / fans /
input booleans and open more-info otherwise, hold opens more-info. A single tap waits 250 ms for a
second tap only on objects or markers that have a `double_tap_action`; everything else reacts at
once. An action missing a field (e.g. `navigate` without `navigation_path`) does nothing and shows
a short message; a failed service call shows its error the same way. Popup rows can end with links: `history`, `logbook` (open HA's history / logbook for
the entity), `statistics` (the entity's more-info) and custom `{ label, navigate }` or `{ label, url }`.

### Views

With a model, the chips on the card are **views**. They come from the model (`fp.views`, see the
[model builder guide](docs/model-builder-guide.md#views)); a model without views gets one view per
storey (lower storeys stacked under it) plus *All*. Each view is linked to HA floors (by default
the floor of its top storey):
- In a storey view, devices in the visible rooms of that storey and outdoor devices are shown;
  devices of lower storeys are hidden. An overview (every storey and the roof visible, e.g.
  Exterior) shows every device.
- A pin belongs to the model room or zone under it (on its floor), so a pin dropped in the garden
  shows wherever the garden zone shows. The live mower is outdoors: it shows in every view where
  part of an exterior level is visible.
- Devices outside every model room and zone (pins off the plan, areas without a room) follow
  their HA floor: they show in views linked to that floor, and are hidden in views above it.
- Room labels (name and size) appear in storey views for the rooms of that storey.
- Switching views keeps the camera, unless the view has a saved camera. **Reset view** (the
  crosshair button) returns to the view's camera or frames the house.

**Edit → Views** edits the current view: label, add / hide / reorder views, linked HA floors,
**Save current view as start** (the camera), and a tree of the model (levels, rooms, objects,
layers, groups) with an eye per row: *default* → *shown* → *hidden* in this view. Click any part
of the model in 3D for a menu: **Hide in this view**, **Show in this view**, **Hide in all
views**, **Reveal in tree**. Your changes are stored per view id in the layout and survive model
re-exports; parts no longer in the model are listed for removal.

#### Camera

- **Rotation centre**: *Edit → Views → Set rotation centre*, then click a point on the model (or
  the floor of the view when nothing is hit; Esc cancels). The camera moves so it orbits and zooms
  around that point, keeping its angle and distance, and the view's camera (position + centre) is
  saved. While the Views tab is open a small cross marks the current centre.
- **Zoom towards**: card option `zoom_to` (`center` by default, or `cursor`), per view in the
  Views tab (or `views.<id>.zoom_to` in YAML).
- **Top view camera**: in **Top**, *Save current view as start* stores the view's own top camera
  (`camera_top: { center: [x, y], zoom }`, plan metres; zoom 1 shows 20 m vertically, the
  horizontal extent follows the card width) instead of the 3D one. Switching views in Top uses it, else keeps the current top camera;
  *Set rotation centre* in Top recentres the top camera. Models may give `fp.views[*].camera_top`.
- **Reset view** returns to the saved camera (3D: incl. its rotation centre; Top: `camera_top`),
  else frames the view. *Reset camera* in the Views tab drops the camera of the current mode.
- Cameras from the model (`fp.views[*].camera` / `camera_top`) are in model coordinates and follow
  the model when you move, rotate or scale it in the Model tab. Cameras and side-section planes
  saved in the card (Views tab, YAML `views.<id>`) are in card coordinates and stay put when the
  model is realigned later: save them again afterwards. Pins placed on the model follow it; pins
  from v0.2.x on a floor bound to a model level start following it on the first realignment.

#### Side section

The **Section** button (box cutter, 3D view with a model) cuts the house with one vertical plane
and turns the camera to look at the cut face: every storey and the roof are shown while it is on,
devices beyond the cut are hidden, and cut walls read solid. Turning it off, switching views,
**Reset view** or **Top** clears the cut and returns to the view. Where the cut runs is set per
view in **Edit → Views → Side section**: which half stays (*Keep west / east / north / south
half*) and a **Position** slider across the house (its storeys; 0.05 m steps, the cut follows the
slider live). The camera looks at the cut face from the removed half. Without a setting the
model's `fp.views[*].section` is used (`{ "normal": [-1, 0, 0], "constant": 7 }`, a three.js plane
in model coordinates: the side where `normal · p + constant ≥ 0` stays, here x ≤ 7 m), else the
west half is kept, cut through the middle of the house.

Per-card overrides in YAML (same keys, they win over the stored ones):

```yaml
views:
  ground:
    label: Downstairs
    floors: [ground_floor]
    rules:
      - hide: layer:furniture
      - hide: node:house/level0/sofa
    camera: { position: [18, 22, 16], target: [6, 0, -4] }
    camera_top: { center: [6, 4], zoom: 1.5 }   # plan metres
    zoom_to: cursor
    section: { normal: [-1, 0, 0], constant: 7 }   # card world: keeps x <= 7 m
  exterior:
    hidden: true
```

Model builders: [docs/model-builder-guide.md](docs/model-builder-guide.md) (format, selectors,
layers) and [docs/prototype-view-rules.md](docs/prototype-view-rules.md) (reference view set,
camera presets for `fp.views[*].camera`, controls).

To export an existing Three.js design: add `window.scene = scene;` to its code, open it in the
browser, paste [tools/export-glb.js](tools/export-glb.js) into the developer console. It drops
lights and helpers, prints size and origin, and downloads `house.glb`.

## Development

```sh
npm ci
npm run demo          # http://localhost:8765/demo/  (mock HA, add ?model=1 for the 3D model with views)
npm run make-demo-model   # regenerate demo/house.glb (views, layers, tagged rooms)
npm test              # unit tests (vitest)
npm run lint
npm run check         # build + headless Chrome checks of view, edit mode and model
python -m pytest      # integration tests (pip install -r requirements-test.txt first)
npm run deploy        # build and scp the integration to HA (settings in .env, see .env.example)
```

Releases: bump the version in `package.json`, `custom_components/floorplan3d/manifest.json` and
`src/floorplan3d-card.js`, then push a `vX.Y.Z` tag. GitHub Actions builds `floorplan3d.zip`
(the integration with the card inside) for HACS.

Layout: `src/placement.js` (auto placement), `src/registry.js` (HA registries to markers),
`src/layout.js` (floors, walls, positions), `src/view.js` (Three.js), `src/editor.js` (edit
operations), `src/edit-mode.js` (panel and plan interactions), `src/mower.js` (mower math),
`src/storage.js` (layout storage), `custom_components/floorplan3d/` (integration).

## Troubleshooting

- **Card not found** after install: restart HA, then reload the browser (clear cache on mobile app).
- **Data tab says per-user or browser storage**: the Floorplan 3D integration is not added
  (Settings → Devices & services), or HA has not been restarted since installing it.
- **No Edit button**: only admins can edit.
- **A device is missing**: give it an area and draw that area's room, or check *Devices → Hidden*.
  Diagnostic and configuration entities are never shown.
- **Mower not on the plan**: GPS sources need at least one calibration point; the Mower tab shows
  the current reading. Live map image source: needs the overlay and a picked colour.
