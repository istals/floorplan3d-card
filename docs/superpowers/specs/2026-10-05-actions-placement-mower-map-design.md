# Actions, surface placement and the mower map (v0.4.2)

Status: scope agreed in chat item by item; spec awaiting review
Date: 2026-10-05

## Goal
1. Objects and markers can navigate and run HA actions like standard Lovelace cards.
2. Devices sit on real model surfaces (walls, ceilings, floors), never floating; dragging shows where they land.
3. The Sunseeker live map lies on the real lawn: aligned by points, background transparent so mowed
   stripes, path and no-mow zones show on the lawn; the enlarged mower icon hidden; a warning over the
   mower when it is in error or stuck.
Rule: stay light and easy — good defaults, few options.

## 1. Actions
- Keys `tap_action`, `hold_action`, `double_tap_action` with HA's standard shape:
  `toggle`, `more-info` (`entity`), `navigate` (`navigation_path`), `url` (`url_path`),
  `perform-action` (`perform_action`, `data`, `target`), `assist`, `none`, plus our `popup`;
  optional `confirmation: true | { text }`.
- Sources, later wins: model `fp.ui` (also accepts the old `tap`/`hold` keys) → layout
  `layout.objects[id].ui` (Objects tab) → card YAML `actions:` keyed `object:<id>`, `<entity_id>` or
  `device:<id>` (markers too).
- Navigation: `history.pushState(null, '', path)` + `window.dispatchEvent(new Event('location-changed'))`;
  url: `window.open(url, '_blank', 'noopener')` (same tab when the path starts with `/`).
- Double tap: two taps within 250 ms; single tap waits 250 ms only when a double_tap_action exists.
- Objects tab: per object Tap / Hold / Double tap selects (default, toggle, more-info, popup,
  navigate, url, perform-action, none) with the needed fields.
- Popup links: rows `history`, `logbook`, `statistics` (open `/history?entity_id=…`,
  `/logbook?entity_id=…`, more-info statistics), and custom `{ label, navigate | url }` rows in
  `fp.ui.popup` or YAML; shown at the popup bottom.

## 2. Placement on surfaces
- Drag preview (edit mode, Devices): while dragging over the model, a ring (r 0.12 m) on the target
  surface, the hit surface face tinted, and the stem; over a model object its outline highlights and a
  label "Attach: <object label>". Alt = free drag (no preview).
- Automatic placement with a model: auto-placed markers (not pinned) are moved onto the nearest model
  surface by their anchor type (placement.js rules): `wall` → nearest wall surface found by horizontal
  rays in 8 directions from the computed point at its height (≤ 2.5 m), placed 5 cm off along the
  normal; `center`/ceiling → ray up to the ceiling, 5 cm below; floor-type → ray down, 5 cm above;
  `corner`/`door` → nearest wall as above. No hit → keep today's point. Computed once per model /
  layout change, cached.
- Devices tab button "Stick all to surfaces": for pinned markers that are > 0.15 m from any surface,
  move them like above; shows "N markers will move" with Apply / Cancel.

## 3. Mower map
- Align by points: "Align by points" → click a point on the map image, then the same point on the
  model; 2 points → similarity (scale, rotation, offset) written to overlay x/y/rotation/width;
  3+ → least-squares similarity. Sliders stay for fine tuning.
- Lies on the lawn: overlay height = model surface height under the overlay centre (ray down,
  ignoring the overlay and helpers) + 0.02 m; slider "Height offset" (−0.5…+0.5 m). Independent of the
  HA floor's elevation (fixes overlays floating on floors with odd elevations).
- Image processing on each refresh (one canvas pass): background colour (picked) → transparent;
  no-mow colour (picked) → dark translucent hatched; mower icon pixels (the detected blob, dilated
  3 px) → transparent when "Hide mower icon on the map" is on (default on). Tolerances per colour.
- Clip to zone: optional zone id (default: the zone containing the overlay centre, e.g. `garden`);
  pixels outside the zone outline are not drawn (stencil-free: alpha mask from the outline polygon).
- Under objects: depthTest on, polygonOffset, renderOrder below objects.
- "Show the map only in edit mode" checkbox.

## 4. Mower warning
- Red ⚠ (world-size sprite above the mower model, gentle pulse, also in top view) when the mower
  entity state is `error`, or an optional "Error entity" (Mower tab) reports a problem
  (`binary_sensor` on, or a sensor whose state is not empty/none/ok/unknown/unavailable).
- Yellow ⚠ "Stuck?" when the state is `mowing` and the detected position moved < 0.3 m for N minutes
  (default 5, setting in the Mower tab, 0 = off).
- Tap → popup with the error text (error entity state or attributes), Start / Dock buttons.

## Testing
Unit: action resolution and merge order, double-tap timing, navigation calls; surface snapping
direction choice; point alignment fit; image processing (key colours, icon mask, zone mask) on
synthetic images; stuck detector. Headless: navigate/perform-action from a tap and hold; drag preview
ring present; auto placement moves a wall sensor onto the demo wall; align by 2 points reproduces a
known overlay; demo map background transparent, icon hidden, ⚠ visible on mock error and after
a mocked stuck period.
