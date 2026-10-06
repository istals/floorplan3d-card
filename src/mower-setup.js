// Mower tab setup checklist (pure). Each row: { id, label, ok, optional, target } where target is
// the CSS selector of the control that fixes it.
const DEFAULT_OV = { x: 0, y: 0, width: 20 };

export function overlayAligned(o) {
  if (!o || !o.entity || !(Number(o.width ?? DEFAULT_OV.width) > 0)) return false;
  if (o.aligned) return true;
  return (Number(o.x) || 0) !== DEFAULT_OV.x || (Number(o.y) || 0) !== DEFAULT_OV.y || Number(o.width ?? DEFAULT_OV.width) !== DEFAULT_OV.width;
}

// m: layout.mower; states: hass.states; found: true when the last position reading / detection worked.
export function setupChecklist(m, states = {}, found = false) {
  m = m || {};
  const o = m.overlay || null;
  const image = m.source === 'image';
  const rows = [
    { id: 'entity', label: 'Entity', ok: !!(m.entity && states[m.entity]), target: '[data-field="mower-entity"]' },
    { id: 'map', label: 'Map image', ok: !!(o && o.entity && states[o.entity]), target: '[data-field="ov-entity"]' },
    { id: 'aligned', label: 'Aligned', ok: overlayAligned(o), target: o && o.entity ? '[data-act="ov-align"]' : '[data-field="ov-entity"]' },
  ];
  if (image) rows.push({ id: 'color', label: 'Mower colour', ok: !!(m.image && Array.isArray(m.image.color)), target: '[data-act="img-pick"]' });
  rows.push({ id: 'found', label: 'Found', ok: !!found, target: '.mower-live' });
  rows.push({ id: 'mowed', label: 'Mowed colour', ok: !!(o && Array.isArray(o.mowed_color)), optional: true,
    target: o && o.entity ? '[data-act="map-pick"][data-kind="mowed"]' : '[data-field="ov-entity"]' });
  return { rows, complete: rows.every((r) => r.optional || r.ok) };
}
