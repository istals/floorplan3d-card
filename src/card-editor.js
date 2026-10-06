// Visual editor for the card options (Lovelace "Show visual editor"), built on HA's ha-form.
// Rooms, devices, mower and model are edited on the card itself (its Edit button).

const DEFAULTS = { layout_key: 'default', height: '520px', group_by: 'device', wall_height: 1.0, view: '3d', room_labels: 'size', zoom_to: 'center', occlusion: true, lights: 'auto', merge: true, sky_bodies: true, clouds: true };

export const SCHEMA = [
  { name: 'height', selector: { text: {} } },
  {
    type: 'grid', name: '', schema: [
      { name: 'view', selector: { select: { mode: 'dropdown', options: [{ value: '3d', label: '3D' }, { value: 'top', label: 'Top (north up)' }] } } },
      { name: 'floor', selector: { floor: {} } },
      { name: 'wall_height', selector: { number: { min: 0.2, max: 3, step: 0.05, mode: 'box', unit_of_measurement: 'm' } } },
      { name: 'group_by', selector: { select: { mode: 'dropdown', options: [{ value: 'device', label: 'One marker per device' }, { value: 'entity', label: 'One marker per entity' }] } } },
      { name: 'zoom_to', selector: { select: { mode: 'dropdown', options: [{ value: 'center', label: 'Centre of the view' }, { value: 'cursor', label: 'Mouse cursor' }] } } },
      { name: 'lights', selector: { select: { mode: 'dropdown', options: [{ value: 'auto', label: 'Real lights' }, { value: 'off', label: 'Glow only (weak devices)' }] } } },
      { name: 'room_labels', selector: { select: { mode: 'dropdown', options: [{ value: 'size', label: 'Name and size' }, { value: 'name', label: 'Name only' }, { value: 'none', label: 'None' }] } } },
    ],
  },
  { name: 'occlusion', selector: { boolean: {} } },
  { name: 'merge', selector: { boolean: {} } },
  { name: 'sky_bodies', selector: { boolean: {} } },
  { name: 'clouds', selector: { boolean: {} } },
  { name: 'weather', selector: { entity: { domain: 'weather' } } },
  { name: 'debug', selector: { boolean: {} } },
  { name: 'layout_key', selector: { text: {} } },
  {
    type: 'expandable', name: '', title: 'Model from a URL (instead of uploading in the card)', schema: [
      { name: 'model', selector: { text: {} } },
      {
        type: 'grid', name: '', schema: [
          { name: 'model_rotation', selector: { number: { min: -180, max: 180, step: 0.5, mode: 'box', unit_of_measurement: '°' } } },
          { name: 'model_scale', selector: { number: { min: 0.0001, step: 0.0001, mode: 'box' } } },
          { name: 'model_opacity', selector: { number: { min: 0.1, max: 1, step: 0.05, mode: 'slider' } } },
        ],
      },
    ],
  },
];

const LABELS = {
  height: 'Card height',
  view: 'Start view',
  floor: 'Start floor',
  wall_height: 'Cut-away wall height',
  occlusion: 'Dim markers behind walls',
  merge: 'Merge model parts (faster)',
  sky_bodies: 'Sun and moon in the sky',
  clouds: 'Clouds in the sky',
  weather: 'Weather entity',
  debug: 'Performance overlay (debug)',
  group_by: 'Markers',
  room_labels: 'Room labels',
  zoom_to: 'Zoom towards',
  lights: 'Model lamps',
  layout_key: 'Layout name',
  model: 'Model URL (.glb)',
  model_rotation: 'Model rotation',
  model_scale: 'Model scale',
  model_opacity: 'Model opacity',
};

const HELPERS = {
  height: 'CSS height, e.g. 520px or 60vh',
  wall_height: 'Drawn walls only; a model is cut at the top of the storey',
  occlusion: 'With a 3D model: markers hidden by a wall from the current angle are shown faint',
  merge: 'With a 3D model: static parts of a room / layer with the same material are drawn as one (fewer draw calls). Turn off to keep every part separate.',
  sky_bodies: 'With a 3D model: show the sun and the moon (position and phase from your Home Assistant location)',
  clouds: 'With a 3D model: clouds from the weather entity\'s cloud coverage (the light follows the weather either way)',
  weather: 'Empty: the first weather entity. In YAML, weather: none ignores the weather.',
  floor: 'Empty: the first floor that has rooms',
  zoom_to: 'Centre: zoom and rotate around the view\'s rotation centre (Edit → Views)',
  lights: 'With a 3D model: lamps light the house (auto) or only glow (off)',
  layout_key: 'Cards with the same name share one plan. Letters, digits, - and _.',
  model: 'e.g. /local/house.glb. Leave empty to upload a model on the card (Edit → Model).',
};

// Drop empty values and defaults so the YAML stays short.
export function cleanConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null || v === '') continue;
    if (k !== 'type' && DEFAULTS[k] === v) continue;
    out[k] = v;
  }
  return out;
}

export class Floorplan3dCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!customElements.get('ha-form')) {
      this.textContent = 'Edit this card in YAML (the visual editor needs a newer Home Assistant).';
      return;
    }
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => HELPERS[s.name] || '';
      this._form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        const config = cleanConfig({ ...this._config, ...e.detail.value, type: this._config.type });
        this._config = config;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
      });
      const hint = document.createElement('p');
      hint.style.cssText = 'margin: 16px 0 0; color: var(--secondary-text-color); font-size: 13px;';
      hint.textContent = 'Rooms, devices, the mower and the 3D model are set up on the card itself: save, then use its Edit button.';
      this.append(this._form, hint);
    }
    this._form.hass = this._hass;
    this._form.schema = SCHEMA;
    this._form.data = { ...DEFAULTS, ...this._config };
  }
}

if (!customElements.get('floorplan3d-card-editor')) customElements.define('floorplan3d-card-editor', Floorplan3dCardEditor);
