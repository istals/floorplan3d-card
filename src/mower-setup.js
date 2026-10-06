import { colorList } from './mower-image.js';

// Mower tab setup checklist (pure). Each row: { id, label, ok, optional, target } where target is
// the CSS selector of the control that fixes it.
const DEFAULT_OV = { x: 0, y: 0, width: 20 };

export function overlayAligned(o) {
  if (!o || !o.entity || !(Number(o.width ?? DEFAULT_OV.width) > 0)) return false;
  if (o.aligned) return true;
  return (Number(o.x) || 0) !== DEFAULT_OV.x || (Number(o.y) || 0) !== DEFAULT_OV.y || Number(o.width ?? DEFAULT_OV.width) !== DEFAULT_OV.width;
}

// m: layout.mower; states: hass.states; found: true when the last position reading / detection worked;
// auto: { static, picture } of auto mode when it is on (the static map replaces the colour picks).
export function setupChecklist(m, states = {}, found = false, auto = null) {
  m = m || {};
  const o = m.overlay || null;
  const image = m.source === 'image';
  const rows = [
    { id: 'entity', label: 'Entity', ok: !!(m.entity && states[m.entity]), target: '[data-field="mower-entity"]' },
    { id: 'map', label: 'Map image', ok: !!(o && o.entity && states[o.entity]), target: '[data-field="ov-entity"]' },
    { id: 'aligned', label: 'Aligned', ok: overlayAligned(o), target: o && o.entity ? '[data-act="ov-align"]' : '[data-field="ov-entity"]' },
  ];
  if (auto) {
    rows.push({ id: 'static', label: auto.mismatch ? "Static map doesn't match the live map" : 'Static map', ok: !!auto.static && !auto.mismatch, target: '[data-field="mower-static"]' });
    rows.push({ id: 'picture', label: 'Mower picture', ok: !!auto.picture, optional: true, target: '[data-field="mower-picture"]' });
  } else if (image) rows.push({ id: 'color', label: 'Mower colour', ok: colorList(m.image).length > 0, target: '[data-act="img-pick"]' });
  rows.push({ id: 'found', label: 'Found', ok: !!found, target: '.mower-live' });
  if (!auto) {
    rows.push({ id: 'mowed', label: 'Mowed colour', ok: colorList(o, 'mowed').length > 0, optional: true,
      target: o && o.entity ? '[data-act="map-pick"][data-kind="mowed"]' : '[data-field="ov-entity"]' });
  }
  return { rows, complete: rows.every((r) => r.optional || r.ok) };
}
