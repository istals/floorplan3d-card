// floorplan3d-card: Home Assistant Lovelace card showing a 3D floorplan with auto-placed devices.

import { Color } from 'three';
import { FloorplanView } from './view.js';
import { EditMode } from './edit-mode.js';
import './card-editor.js';
import { LayoutStore } from './storage.js';
import { buildMarkers, registrySignature, iconFor, isActive, displayValue, areaName } from './registry.js';
import { mergeFloors, roomFloorId, markerPositions, lightGlow, roomLabel } from './layout.js';
import {
  resolveLevels, resolveRoomAreas, modelRooms, combineRooms, levelFloorOverrides, bindingDiff, snapshotDiff, levelsFromFloorMap,
  measuredElevations, transformPoint,
} from './bindings.js';
import { threeAdapter } from './manifest.js';
import {
  nodeIndex, resolveViews, resolveVisibility, primaryLevel, defaultFloors, levelOrders, isOverview, floorLevels, deviceState,
  defaultViewId, viewCut, orderViews, unmatchedSelectors, sectionPlane, sectionCamera, zoomToFor, roomAt, exteriorShown, cameraToCard, topCameraToCard,
} from './views.js';
import { readSource, mowerTransform, overlayUrl } from './mower.js';
import { errorKind, errorText, stuckStep, stuckDueIn, STUCK_DEFAULT_MIN } from './mower-warning.js';
import { findBlob, stepTrack, headingMinStep, pixelToPlan, readImagePixels, MapProcessor, mowedShare, stripeBearing, insidePoint } from './mower-image.js';
import { ObjectLayer } from './objects/layer.js';
import { bindObjects, effectiveGroups, nightFactor, sunVector, sunStrength, clampSunDir, screenByDistance, attachedPosition } from './objects/logic.js';
import { moonPosition } from './sky.js';
import { ObjectPopup, actionTarget, toggleCall } from './objects/popup.js';
import { typeOf } from './objects/types.js';
import { resolveActions, actionCall, TapSequencer } from './actions.js';
import { pointInPolygon, signedArea } from './placement.js';
import { surfaceKind, surfaceKey, surfaceSearch, chooseSurface, nearPolygon, worldOf, planOf } from './surface.js';

const VERSION = '0.4.1';
const NONE = Object.freeze({}); // stable stand-in for a missing layout.objects / groups (binding cache key)
// HA frontend navigation: push the path and tell the router.
function navigate(path, replace = false) {
  if (replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace } }));
}

const TAP_TOGGLE = new Set(['light', 'switch', 'fan', 'input_boolean']);
const LONG_PRESS_MS = 500;
const MOON_EVERY_MS = 60000;
const DAY_SUN = [200, 40]; // manual Day: sun azimuth / elevation (deg)
const NIGHT_MOON = [160, 35]; // manual Night: moon azimuth / elevation
const CLICK_SLOP_PX = 5;
const WARN_ID = '__mower_warning__'; // tap target of the warning when the mower is a marker, not a model object
const OBJECT_HIT_PX = { touch: 52, mouse: 30 };
const TRAIL_STEP_M = 0.15;
const TRAIL_MAX = 3000;
const MOWER_Z = 0.15;
const MODEL_API = '/api/floorplan3d/model';
const nodeShown = (n) => { for (let x = n; x; x = x.parent) if (!x.visible) return false; return true; };

const STYLE = `
  :host { display: block; }
  ha-card { display: block; overflow: hidden; position: relative; container-type: inline-size;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 12px); color: var(--primary-text-color); }
  .stage { position: relative; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
  .stage canvas { display: block; }
  .toolbar { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; gap: 8px;
    align-items: flex-start; z-index: 2; pointer-events: none; }
  .toolbar > * { pointer-events: auto; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .spacer { flex: 1; }
  button.chip, .seg button { font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
    padding: 7px 12px; border-radius: 16px; border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  button.chip.on, .seg button.on { background: var(--primary-color); border-color: var(--primary-color);
    color: var(--text-primary-color, #fff); }
  .seg { display: flex; }
  .seg button:first-child { border-radius: 16px 0 0 16px; }
  .seg button:last-child { border-radius: 0 16px 16px 0; border-left: none; }
  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px; color: var(--secondary-text-color); pointer-events: none; }
  .empty[hidden], .notice[hidden] { display: none; }
  .notice { position: absolute; left: 8px; bottom: 8px; right: 8px; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    background: var(--card-background-color, #fff); color: var(--error-color, #db4437);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); pointer-events: none; }

  .fp-room-label { font-size: 11px; letter-spacing: .02em; color: var(--secondary-text-color, #727272);
    white-space: nowrap; pointer-events: none; opacity: .9; }
  .fp-room-label.outdoor { font-style: italic; }
  .fp-attach-label { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; pointer-events: none;
    transform: translateY(-22px); background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  /* the marker box is just the dot (CSS2D centres the box on the 3D point); the value hangs below it */
  .fp-marker { position: relative; display: flex; flex-direction: column; align-items: center; pointer-events: auto;
    cursor: pointer; transform-origin: center; }
  .fp-dot { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272);
    border: 1.5px solid var(--divider-color, rgba(0,0,0,.15)); box-shadow: 0 1px 4px rgba(0,0,0,.25);
    transition: background .2s, color .2s, transform .1s; --mdc-icon-size: 17px; }
  .fp-marker:hover .fp-dot { transform: scale(1.12); }
  .fp-marker.active .fp-dot { background: var(--primary-color); border-color: var(--primary-color);
    color: var(--text-primary-color, #fff); }
  .fp-marker.active.light .fp-dot { background: var(--fp-light, var(--state-light-active-color, #ffb74d));
    border-color: var(--fp-light, var(--state-light-active-color, #ffb74d)); color: #fff; }
  .fp-marker.unavailable .fp-dot { opacity: .45; border-style: dashed; }
  .fp-marker.fp-occluded { opacity: .25; pointer-events: none; }
  .editing .fp-marker.fp-occluded { opacity: .5; pointer-events: auto; }
  .fp-val { position: absolute; top: calc(100% + 2px); left: 50%; transform: translateX(-50%);
    font-size: 10.5px; font-weight: 500; padding: 1px 5px; border-radius: 8px; white-space: nowrap;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 1px 3px rgba(0,0,0,.2); }
  .fp-val:empty { display: none; }
  .fp-popup { position: absolute; left: 0; top: 0; z-index: 3; min-width: 190px; max-width: 260px; padding: 8px 10px 10px;
    box-sizing: border-box; overflow: auto;
    border-radius: 12px; background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); box-shadow: 0 4px 16px rgba(0,0,0,.28); font-size: 13px;
    touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  .fp-pop-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .fp-pop-title { flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fp-pop-x { border: none; background: none; color: var(--secondary-text-color); font-size: 18px; line-height: 1;
    cursor: pointer; padding: 2px 4px; }
  .fp-pop-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
  .fp-pop-label { flex: 1; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fp-pop-row.chain { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); margin-top: 4px; padding-top: 4px; }
  .fp-pop-row.chain .fp-pop-label { color: var(--primary-text-color); }
  .fp-pop-row.reason { font-size: 12px; color: var(--secondary-text-color); font-style: italic; min-height: 0; padding-top: 4px; }
  .fp-pop-row.brightness .fp-pop-label { flex: none; }
  .fp-pop-row.brightness input { flex: 1; min-width: 0; accent-color: var(--primary-color); }
  .fp-pop-row.brightness.off input { opacity: .5; }
  .fp-pop-row.color { flex-wrap: wrap; gap: 6px; padding: 4px 0; }
  .fp-swatch { width: 22px; height: 22px; border-radius: 50%; padding: 0; cursor: pointer;
    border: 1.5px solid var(--divider-color, rgba(0,0,0,.15)); }
  .fp-swatch.on { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .fp-swatch.white { background: #ffd9a8; }
  .fp-switch { width: 36px; height: 20px; border-radius: 10px; border: none; padding: 2px; cursor: pointer; flex: none;
    background: var(--switch-unchecked-track-color, rgba(127,127,127,.45)); display: flex; transition: background .15s; }
  .fp-switch span { width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3);
    transition: transform .15s; }
  .fp-switch.on { background: var(--primary-color); }
  .fp-switch.on span { transform: translateX(16px); }
  .fp-pop-value { font-weight: 500; }
  .fp-pop-btns { display: flex; gap: 6px; }
  .fp-pop-row.link { min-height: 26px; }
  .fp-pop-row:not(.link) + .fp-pop-row.link { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); margin-top: 4px; padding-top: 4px; }
  .fp-pop-link { border: none; background: none; padding: 2px 0; font: inherit; color: var(--primary-color); cursor: pointer; }
  .fp-toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 4; width: max-content; max-width: calc(100% - 32px); box-sizing: border-box;
    padding: 6px 12px; border-radius: 8px; font-size: 12px; background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border: 1px solid var(--warning-color, #ff9800); box-shadow: 0 2px 8px rgba(0,0,0,.25); pointer-events: none; }
  .fp-toast[hidden] { display: none; }
  .fp-confirm { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 5; width: min(280px, calc(100% - 32px));
    box-sizing: border-box; padding: 12px 14px; border-radius: 12px; font-size: 13px; background: var(--card-background-color, #fff);
    color: var(--primary-text-color); border: 1px solid var(--divider-color, rgba(0,0,0,.12)); box-shadow: 0 6px 20px rgba(0,0,0,.35); }
  .fp-confirm-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .fp-confirm-btns button { font: inherit; padding: 4px 12px; border-radius: 12px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .fp-confirm-btns button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .fp-pop-btns button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 12px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .body { display: flex; }
  .body .stage { flex: 1; min-width: 0; }
  .panel { display: none; width: 300px; flex: none; box-sizing: border-box; flex-direction: column; max-height: var(--fp-height);
    border-left: 1px solid var(--divider-color, rgba(0,0,0,.12)); font-size: 13px; }
  .editing .panel { display: flex; }
  /* narrow cards (e.g. a sections-view column): plan on top, panel below */
  @container (max-width: 640px) {
    .body.editing { flex-direction: column; }
    .body.editing .stage { flex: none; width: 100%; }
    .editing .panel { width: auto; max-height: 420px; border-left: none; border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  }
  .tabs { display: flex; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .panel .tabs button { flex: 1; border-radius: 0; font: inherit; padding: 10px 4px; background: none; border: none; cursor: pointer;
    color: var(--secondary-text-color); border-bottom: 2px solid transparent; }
  .panel .tabs button.on { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .tab-body { flex: 1; overflow: auto; padding: 4px 12px 12px; }
  .foot { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 11px;
    color: var(--secondary-text-color); border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .panel h3 { margin: 4px 0 6px; font-size: 14px; font-weight: 500; }
  .panel .sub { margin: 14px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--secondary-text-color); }
  .panel .hint, .panel .dim { color: var(--secondary-text-color); }
  .panel .hint { font-size: 12px; line-height: 1.4; }
  .panel p { margin: 6px 0; }
  .panel .box { border: 1px solid var(--divider-color, rgba(0,0,0,.12)); border-radius: 8px; padding: 8px 10px;
    margin: 8px 0; }
  .panel label { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; font-size: 12px;
    color: var(--secondary-text-color); }
  .panel label.check { flex-direction: row; align-items: center; gap: 6px; color: var(--primary-text-color); }
  .panel select, .panel input[type=number] { font: inherit; padding: 5px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); min-width: 0; }
  .panel button, .panel label.button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: inline-block; margin: 0; }
  .panel button:disabled { opacity: .45; cursor: default; }
  .panel button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .panel button.danger { color: var(--error-color, #db4437); }
  .panel button.link { border: none; background: none; padding: 0 2px; color: var(--primary-color); }
  .panel .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .panel ul { list-style: none; margin: 0; padding: 0; }
  .panel ul.list li { display: flex; align-items: center; gap: 6px; padding: 4px 0;
    border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06)); }
  .panel ul.list li.sel .name { color: var(--primary-color); font-weight: 500; }
  .panel .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel .pill { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; }
  .panel .pill.ok { background: rgba(76,175,80,.16); color: var(--success-color, #43a047); }
  .panel tr.sel td { background: rgba(3,169,244,.12); }
  .stage.picking .fp-marker, .stage.picking .fp-handle { pointer-events: none; opacity: .45; }
  .panel details.report { margin: 6px 0; font-size: 12px; }
  .panel details.report summary { cursor: pointer; color: var(--secondary-text-color); }
  .panel details.report ul, .panel .msg { user-select: text; -webkit-user-select: text; cursor: text; }
  .panel .pill.missing { background: rgba(255,152,0,.16); color: var(--warning-color, #ef8a00); }
  .panel table.floors { width: 100%; border-collapse: collapse; font-size: 12px; }
  .panel table.floors th { font-weight: normal; color: var(--secondary-text-color); text-align: left; font-size: 11px; }
  .panel table.floors td { padding: 2px 3px 2px 0; }
  .panel table.floors input { width: 64px; }
  .panel .note { padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; }
  .panel .note.ok { background: rgba(76,175,80,.12); }
  .panel .note.warn { background: rgba(255,152,0,.14); }
  .panel .msg { margin: 8px 0; padding: 6px 10px; border-radius: 6px; background: rgba(76,175,80,.12); font-size: 12px; }
  .panel .msg.warn { background: rgba(255,152,0,.14); }
  .panel .msg.error { background: rgba(219,68,55,.14); color: var(--error-color, #db4437); }
  button.edit { font: inherit; font-size: 13px; line-height: 1; cursor: pointer; padding: 6px 10px; border-radius: 16px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; gap: 4px; --mdc-icon-size: 16px; }
  button.edit[hidden], button.daynight[hidden], button.section[hidden] { display: none; }
  button.section.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.reset, button.section { font: inherit; line-height: 1; cursor: pointer; padding: 5px 8px; border-radius: 16px; display: flex;
    align-items: center; border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); --mdc-icon-size: 17px; }
  button.daynight { font: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 5px 10px; border-radius: 16px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; --mdc-icon-size: 17px; }
  .editing button.edit { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }

  .fp-handle { box-sizing: border-box; width: 13px; height: 13px; border-radius: 50%; pointer-events: auto; cursor: grab;
    background: var(--card-background-color, #fff); border: 2px solid var(--primary-color, #03a9f4); touch-action: none; }
  .fp-handle.mid { width: 9px; height: 9px; opacity: .75; border-width: 1.5px; }
  .fp-handle.door { width: 11px; height: 11px; border-radius: 2px; background: var(--primary-color, #03a9f4);
    pointer-events: none; }
  .fp-handle.draw { pointer-events: none; width: 9px; height: 9px; }
  .fp-handle.draw.first { width: 15px; height: 15px; background: var(--primary-color, #03a9f4); }
  .fp-handle.cursor { pointer-events: none; width: 7px; height: 7px; border: none; background: var(--primary-color, #03a9f4); }
  .fp-handle.cursor.vertex { width: 15px; height: 15px; background: none; border: 2px solid var(--primary-color, #03a9f4); }
  .fp-handle.cursor.align { width: 9px; height: 9px; }
  .editing .fp-marker { cursor: grab; }
  .stage.drawing { cursor: crosshair; }
  .stage.drawing .fp-marker { pointer-events: none; opacity: .4; }
  .stage.drawing .fp-handle { pointer-events: none; }
  .stage.moving { cursor: move; }
  .stage.moving .fp-marker, .stage.moving .fp-handle { pointer-events: none; }
  .panel input[type=range] { width: 100%; margin: 0; accent-color: var(--primary-color); }
  .panel label .lab { display: flex; justify-content: space-between; }
  .panel label .val { color: var(--primary-text-color); }
  .panel label.button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .panel label.button.disabled { opacity: .6; pointer-events: none; }
  .panel .bad { color: var(--error-color, #db4437); }
  .panel code { font-size: 11px; }
  .panel .tabs button { padding: 10px 2px; font-size: 12.5px; }
  .panel input:not([type]), .panel input[list] { font: inherit; padding: 5px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); min-width: 0; }
  .panel .row label { flex: 1; }
  .fp-marker.selected .fp-dot { outline: 3px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .has-model .fp-dot { width: 22px; height: 22px; --mdc-icon-size: 14px;
    background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }
  .fp-marker.fp-faded { opacity: .3; }
  .compact .fp-dot { width: 21px; height: 21px; --mdc-icon-size: 13px; border-width: 1px; }
  .compact .fp-val { font-size: 9.5px; padding: 0 4px; }
  .stage.picking-views { cursor: pointer; }
  .panel details.advanced { margin: 12px 0 4px; }
  .panel details.advanced summary { cursor: pointer; color: var(--secondary-text-color); font-size: 12px; }
  .panel .floor-links { display: flex; flex-wrap: wrap; gap: 0 12px; }
  .panel .floor-links label.check { margin: 3px 0; }
  .panel ul.vtree li { display: flex; align-items: center; gap: 4px; padding: 1px 0 1px calc(var(--d, 0) * 14px);
    border-radius: 4px; min-height: 26px; }
  .panel ul.vtree li .name { font-size: 12.5px; }
  .panel ul.vtree li.off .name, .panel ul.vtree li.off .state { opacity: .45; }
  .panel ul.vtree li.lvl > .name { font-weight: 500; }
  .panel ul.vtree li.picked { background: rgba(3,169,244,.12); }
  .panel ul.vtree .state { --mdc-icon-size: 15px; color: var(--secondary-text-color); display: flex; }
  .panel ul.vtree button.eye { padding: 2px 5px; display: flex; align-items: center; --mdc-icon-size: 16px; line-height: 1; }
  .panel ul.vtree button.eye.shown { color: var(--primary-color); border-color: var(--primary-color); }
  .panel ul.vtree button.eye.hidden { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
  .panel ul.vtree button.eye.default { opacity: .7; }
  .panel ul.otree { list-style: none; margin: 4px 0; padding: 0; }
  .panel ul.otree li.room { display: flex; align-items: center; gap: 4px; padding: 2px 0 2px calc(var(--d, 0) * 14px); font-size: 12.5px; }
  .panel ul.otree li.lvl { font-weight: 500; }
  .panel ul.otree li.obj { padding: 4px 6px; margin: 2px 0 2px 28px; border-radius: 6px; border: 1px solid var(--divider-color); }
  .panel ul.otree li.obj.sel { background: rgba(3,169,244,.12); border-color: var(--primary-color); }
  .panel ul.otree li.obj.hid .name { opacity: .5; }
  .panel ul.otree li.obj .orow { display: flex; align-items: center; gap: 6px; --mdc-icon-size: 16px; margin-bottom: 3px; }
  .panel ul.otree li.obj .orow .name { flex: 1; font-size: 12.5px; }
  .panel ul.otree li.obj .orow label.check { margin: 0; font-size: 12px; }
  .panel ul.otree li.obj .oacts { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; }
  .panel ul.otree li.obj .oacts label.act { display: flex; flex-direction: column; margin: 0; font-size: 11px; color: var(--secondary-text-color); flex: 1; min-width: 80px; }
  .panel ul.otree li.obj .oacts select { font-size: 12px; }
  .panel ul.otree li.obj > input[data-field=obj-act-field] { margin-top: 3px; }
  .panel ul.otree li.obj > .badge.warn { display: block; margin-top: 3px; white-space: normal; }
  .panel ul.otree li.obj input[type=text], .panel ul.otree li.obj input:not([type]) { width: 100%; box-sizing: border-box; }
  .panel ul.otree .badge { font-size: 9.5px; padding: 0 4px; border-radius: 4px; background: var(--secondary-background-color, rgba(127,127,127,.2)); color: var(--secondary-text-color); }
  .panel ul.otree .badge.warn { background: none; color: var(--error-color, #db4437); border: 1px solid currentColor; }
  .panel ul.otree li.flash { animation: fp-flash 1.2s ease-out; }
  .panel ul.vtree li.flash { animation: fp-flash 1.2s ease-out; }
  @keyframes fp-flash { 0%, 40% { background: color-mix(in srgb, var(--primary-color, #03a9f4) 35%, transparent); } 100% { background: transparent; } }
  .panel ul.vtree li.part .state { color: var(--primary-color); }
  .panel ul.vtree button.expand { font-size: 12px; color: var(--secondary-text-color); padding: 0 4px; }
  .panel ul.vtree .yaml { font-size: 9.5px; padding: 0 4px; border-radius: 4px; letter-spacing: .04em;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); color: var(--secondary-text-color); }
  .panel ul.vtree li.gone .name { text-decoration: line-through; opacity: .6; }
  .fp-pickmenu { position: absolute; z-index: 5; display: flex; flex-direction: column; gap: 2px; padding: 6px; min-width: 170px;
    box-sizing: border-box; border-radius: 8px; font-size: 12.5px; color: var(--primary-text-color);
    background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    box-shadow: 0 4px 16px rgba(0,0,0,.28); }
  .fp-pickmenu .title { padding: 2px 6px 4px; font-size: 11px; color: var(--secondary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .fp-pickmenu button { font: inherit; text-align: left; padding: 6px 8px; border: none; border-radius: 5px; cursor: pointer;
    background: none; color: inherit; }
  .fp-pickmenu button:hover { background: color-mix(in srgb, var(--primary-color, #03a9f4) 14%, transparent); }
`;

function cssColor(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const c = new Color();
  try {
    // drop alpha from rgba() so three.js can parse it
    c.setStyle((v || fallback).replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgb($1,$2,$3)'));
  } catch (e) {
    c.setStyle(fallback);
  }
  return c;
}

const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

function readSkyMode() {
  try {
    const v = localStorage.getItem('floorplan3d.sky');
    if (v === 'auto' || v === 'day' || v === 'night') return v;
  } catch (e) { /* storage blocked */ }
  return 'auto';
}

class Floorplan3dCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._layout = null;
    this._layoutReady = new Promise((r) => { this._layoutLoaded = r; }); // resolves once the stored layout has loaded (or failed)
    this._built = {};
    this._taps = new TapSequencer(); // single vs double tap, per target
    this._markers = [];
    this._markerEls = new Map();
    this._floor = null;
    this._views = [];
    this._viewId = null;
    this._viewState = null;
    this._viewStates = new Map();
    this._index = null;
    this._mode = '3d';
    this._daylight = true;
    this._skyMode = readSkyMode();
    this._skyLast = null;
    this._section = false; // side section toggle
    this._sectionPreview = null; // Views tab slider: plane shown while dragging
    this._objects = null; // ObjectLayer: model lamps and the real light pool
    this._bindings = new Map(); // object id -> binding (objects/logic.js bindObjects)
    this._boundEntities = new Set(); // entities bound to a model object: no marker of their own
    this._mowerObjectBound = false;
    this._groups = {}; // layout.groups whose controller exists in HA (objects/logic.js effectiveGroups)
    this._bindKey = null;
  }

  static getStubConfig() {
    return {};
  }

  // sections view: span the whole section by default
  getGridOptions() {
    return { columns: 'full', min_columns: 6, rows: 'auto' };
  }

  static getConfigElement() {
    return document.createElement('floorplan3d-card-editor');
  }

  setConfig(config) {
    this._config = { layout_key: 'default', height: '520px', group_by: 'device', wall_height: 1.0, view: '3d', ...config };
    this._mode = this._config.view === 'top' ? 'top' : '3d';
    this._store = new LayoutStore(this._config.layout_key);
    if (this._stage) {
      this._stage.style.height = this._config.height;
      this._body.style.setProperty('--fp-height', this._config.height);
    }
    if (this.isConnected && !this._view) this.connectedCallback();
    else if (this._view) {
      this._view.setOcclusion(this._config.occlusion !== false);
      if (this._view.model) this._applySky(true); // sky_bodies
      this._applyZoomTo();
      this._loadModel();
      this._updateObjects(); // lights: auto | off
    }
  }

  // model: from YAML (model: url) if set, else the one uploaded to the integration (layout.model)
  _loadModel(reload = false) {
    const c = this._config;
    let opts = null;
    if (c.model) {
      opts = {
        url: String(c.model),
        position: Array.isArray(c.model_position) ? c.model_position.map(Number) : [0, 0, 0],
        rotation: Number(c.model_rotation) || 0, scale: Number(c.model_scale) || 1,
        opacity: c.model_opacity === undefined ? 1 : Number(c.model_opacity),
      };
    } else {
      const m = this._layout && this._layout.model;
      if (m && m.version && this._hass && this._hass.fetchWithAuth) {
        const url = `${MODEL_API}/${encodeURIComponent(c.layout_key)}?v=${m.version}`;
        opts = {
          id: m.version, name: m.name,
          data: async () => {
            const r = await this._hass.fetchWithAuth(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
          },
          position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1, opacity: m.opacity ?? 1,
        };
      }
    }
    if (opts) {
      opts.merge = c.merge !== false;
      // node: rules in the layout must be known before merging: wait for it when it has not loaded yet
      opts.keep = () => (this._layout ? this._mergeKeepSelectors() : this._layoutReady.then(() => this._mergeKeepSelectors()));
      opts.onMerged = () => this._modelMerged();
      opts.reload = reload;
    }
    const prevModel = this._view.model;
    this._view.setModel(opts).then((err) => {
      if (this._view.model !== prevModel && this._section) this._dropSection();
      if (this._view.model !== prevModel) { this._endGesture(); this._popup.close(); }
      this._objects.setModel(this._view.model);
      // bind now: lamps light and bound markers hide without waiting for the next hass push
      if (this._hass && this._layout && this._floors && this._syncBindings()) {
        this._buildMarkers();
        this._refreshStates();
      }
      this._updateObjects();
      this._refreshAttached(); // the model (re)placed: attached markers follow their objects
      this._updateMowerWarning(); // the ground under the mower changed
      this._scheduleSurfaces(); // auto-placed markers onto (or off) the model's surfaces
      this._notice.textContent = err || '';
      this._notice.hidden = !err;
      // a new model resets the views; the first view applied frames it (see _resolveViewList)
      this._stage.classList.toggle('has-model', !!this._view.model);
      if (this._view.model) this._applySky(true);
      else { this._daylight = true; this._view.setDaylight(true); } // no model: the toggle is hidden, so always day
      this._syncToolbar();
      this._schedule(); // the manifest arrived: rebuild
      if (this._layout && this._layout.mower && this._hass) this._refreshMapOverlay(); // the map lies on the model's lawn
      if (this._editing) this._edit.onModelLoaded(this._view.model !== prevModel);
    });
  }

  // The model was merged after it was shown (the layout came later): index the merged tree, re-apply the view.
  _modelMerged() {
    const vw = this._view;
    if (!vw.model) return;
    if (this._index && this._built.viewManifest === vw.model.manifest) {
      this._index = nodeIndex(threeAdapter(vw.model.root), vw.model.manifest);
      this._viewStates = new Map();
      const cur = this.currentView();
      this._viewState = cur ? this._stateFor(cur) : null;
      if (!this._floorOnly) this._applyViewVisibility();
      this._applyMarkerStates();
    }
    if (this._editing) this._edit.render();
    this._scheduleSurfaces();
    this._schedule();
  }

  // Layout node: rules that match nothing and were not known when the model was merged (an imported or
  // later-loaded layout may target merged parts): load the model once more, merging around them.
  _checkMergeKeep() {
    const vw = this._view, ms = vw.mergeStats;
    if (!vw.model || !ms || !ms.enabled || !ms.merged || !this._index || this._mergeReloadFor === vw.model.id) return;
    const known = new Set(ms.keep);
    const fresh = this._mergeKeepSelectors().filter((x) => x.startsWith('node:') && !known.has(x));
    if (!fresh.length || !unmatchedSelectors(this._index, fresh.map((x) => ({ hide: x }))).length) return;
    this._mergeReloadFor = vw.model.id;
    this._loadModel(true);
  }

  // View rule selectors from the layout and the card YAML: their node: matches are not merged away.
  _mergeKeepSelectors() {
    const out = [];
    const add = (views) => {
      if (!views || typeof views !== 'object') return;
      for (const v of Object.values(views)) {
        for (const r of (v && Array.isArray(v.rules) ? v.rules : [])) {
          const sel = r && (r.show ?? r.hide);
          if (typeof sel === 'string') out.push(sel);
        }
      }
    };
    add(this._layout && this._layout.views);
    add(this._config.views);
    return out;
  }

  _modelAlign() {
    const c = this._config;
    if (c.model) {
      return {
        position: Array.isArray(c.model_position) ? c.model_position.map(Number) : [0, 0, 0],
        rotation: Number(c.model_rotation) || 0, scale: Number(c.model_scale) || 1,
      };
    }
    const m = (this._layout && this._layout.model) || {};
    return { position: m.position || [0, 0, 0], rotation: m.rotation || 0, scale: m.scale || 1 };
  }

  // Saved level/room bindings (layout.model; YAML model_floors for URL models) resolved
  // against the loaded model and the current HA floors and areas.
  modelBindings() {
    const manifest = this._view && this._view.modelManifest();
    if (!manifest || !this._hass) return null;
    // cached per input identity: per hass state update nothing here changes
    const inputs = [manifest, this._layout && this._layout.model, this._layout && this._layout.floors, this._hass.floors, this._hass.areas, this._config];
    const c = this._mbCache;
    if (c && c.inputs.every((x, i) => x === inputs[i])) return c.value;
    const value = this._computeBindings(manifest);
    this._mbCache = { inputs, value };
    return value;
  }

  _computeBindings(manifest) {
    const saved = (this._layout && this._layout.model) || {};
    const savedLevels = { ...(this._config.model ? levelsFromFloorMap(this._config.model_floors) : {}), ...(saved.levels || {}) };
    const haFloors = mergeFloors(this._hass, this._layout || {}); // HA floors plus layout-only floors
    return {
      manifest,
      levels: resolveLevels(manifest.levels, haFloors, savedLevels),
      rooms: resolveRoomAreas(manifest.rooms, Object.keys(this._hass.areas || {}), saved.rooms || {}),
      diff: bindingDiff(manifest, saved),
      notice: snapshotDiff(manifest, saved.known),
    };
  }

  _allRooms() {
    return combineRooms((this._layout && this._layout.rooms) || [], this._modelRooms || []);
  }

  getCardSize() {
    return Math.ceil(parseInt(this._config?.height, 10) / 50) || 10;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._view && this._view.model && this._skyMode === 'auto') this._applySky(false);
    if (!this._layout && !this._loading) this._load();
    this._schedule();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._config) return; // setConfig renders once it arrives
    if (!this._view) this._render();
    else if (this._editing) this._edit.attach();
    this._view.start();
    clearInterval(this._skyTimer);
    this._skyTimer = setInterval(() => this._applySky(false), MOON_EVERY_MS); // the moon moves without hass updates
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._stage);
    this._schedule();
    this._scheduleSurfaces();
  }

  disconnectedCallback() {
    if (this._view) this._view.stop();
    this._endGesture();
    this._taps.cancel();
    this._closeConfirm();
    if (this._popup) this._popup.close(); // window listeners
    if (this._editing && this._edit) this._edit.detach(); // window listeners (keys, pick menu)
    if (this._ro) this._ro.disconnect();
    clearInterval(this._skyTimer);
    this._skyTimer = null;
    clearTimeout(this._stuckTimer);
    this._stuckTimer = null;
    if (this._view) this._view.setMowerWarning(null); // its pulse timer
    this._setCameraTimer(0);
    this._setImageTimer(0);
    clearTimeout(this._mapReprocTimer);
    if (this._mapProc) this._mapProc.dispose(); // its worker
    clearTimeout(this._surfJob);
    this._surfJob = null;
  }

  async _load() {
    this._loading = true;
    try {
      this._layout = await this._store.load(this._hass);
    } finally {
      this._loading = false;
      this._layoutLoaded();
    }
    this._schedule();
  }

  _render() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STYLE}</style>
      <ha-card>
        <div class="body">
          <div class="stage">
            <div class="toolbar">
              <div class="chips"></div>
              <div class="seg"><button data-mode="3d">3D</button><button data-mode="top">Top</button></div>
              <button class="reset" title="Reset view"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
              <button class="section" hidden title="Side section"><ha-icon icon="mdi:box-cutter"></ha-icon></button>
              <button class="daynight" hidden title="Day / night: auto"><ha-icon icon="mdi:theme-light-dark"></ha-icon></button>
              <button class="edit" hidden title="Edit floorplan"><ha-icon icon="mdi:pencil"></ha-icon><span>Edit</span></button>
            </div>
            <div class="empty" hidden></div>
            <div class="notice" hidden></div>
            <div class="fp-toast" hidden></div>
          </div>
        </div>
      </ha-card>`;
    this._stage = root.querySelector('.stage');
    this._stage.style.height = this._config.height;
    root.querySelector('.body').style.setProperty('--fp-height', this._config.height);
    this._chips = root.querySelector('.chips');
    this._empty = root.querySelector('.empty');
    this._notice = root.querySelector('.notice');
    this._toastEl = root.querySelector('.fp-toast');
    root.querySelector('.seg').addEventListener('click', (e) => {
      const mode = e.target.dataset && e.target.dataset.mode;
      if (mode) this._setMode(mode);
    });
    this._chips.addEventListener('click', (e) => {
      const id = e.target.dataset && e.target.dataset.view;
      if (id) this._setView(id);
    });
    root.querySelector('button.reset').addEventListener('click', () => this._resetCamera());
    this._sectionBtn = root.querySelector('button.section');
    this._sectionBtn.addEventListener('click', () => this.setSection(!this._section));
    this._body = root.querySelector('.body');
    this._editBtn = root.querySelector('button.edit');
    this._dayBtn = root.querySelector('button.daynight');
    this._dayBtn.addEventListener('click', () => {
      this._skyMode = { auto: 'day', day: 'night', night: 'auto' }[this._skyMode];
      try { localStorage.setItem('floorplan3d.sky', this._skyMode); } catch (e) { /* private mode */ }
      this._applySky(true);
      this._syncToolbar();
    });
    this._editBtn.addEventListener('click', () => this._toggleEdit());
    this._view = new FloorplanView(this._stage);
    this._view.onMapImage = (img, w, h) => this._onMapImage(img, w, h);
    this._objects = new ObjectLayer(this._view);
    this._view.onObjectsInvalidate = () => this._updateObjects(); // view, section or placement changed
    this._popup = new ObjectPopup(this._stage, {
      onAction: (domain, service, data) => this._callService(domain, service, data),
      onLink: (action) => this._runAction(action, {}),
      project: (w) => this._view.projectWorld(w),
      anchor: (id) => this._objects.anchorOf(id),
      resolve: (id) => {
        const o = this._objects.objectAt(id);
        if (!o || !this._hass || (o.binding && o.binding.hidden)) return null;
        const extra = [];
        if (o.obj.type === 'mower') { // from the processed live map
          const mi = this.mapInfo();
          if (mi.stripes) extra.push({ kind: 'info', label: 'Stripes', value: mi.stripes });
          if (mi.mowed) extra.push({ kind: 'info', label: 'Mowed', value: mi.mowed });
          const wt = this._warningText();
          if (wt) extra.unshift({ kind: 'info', label: wt.label, value: wt.value });
        }
        return { obj: o.obj, chain: o.chain, states: this._hass.states, groups: this._groups, popup: this._objectActions(id, o).popup, extra };
      },
    });
    this._view.onRender = () => this._popup.position();
    this._view.setOcclusion(this._config.occlusion !== false);
    this._view.setMode(this._mode);
    this._loadModel();
    this._edit = new EditMode(this);
    this._body.append(this._edit.panel);
    const canvas = this._view.renderer.domElement;
    this._stage.addEventListener('pointerdown', (e) => {
      if (this._editing && e.target === canvas) this._edit.canvasDownCapture(e);
    }, true);
    canvas.addEventListener('pointerdown', (e) => this._editing && this._edit.canvasDown(e));
    canvas.addEventListener('pointermove', (e) => this._editing && this._edit.canvasMove(e));
    canvas.addEventListener('pointerup', (e) => this._editing && this._edit.canvasUp(e));
    // model objects: tap / hold, hit-tested on screen before markers and the canvas (capture phase)
    this._stage.addEventListener('pointerdown', (e) => this._objectDown(e, canvas), true);
    this._syncToolbar();
  }

  _toggleEdit() {
    this._endGesture();
    this._taps.cancel();
    this._closeConfirm();
    this._popup.close();
    this._editing = !this._editing;
    this._body.classList.toggle('editing', this._editing);
    if (this._editing) {
      if (!this._view.model && this._floor === 'all') this._setFloor(this._floors[0].id);
      this._edit.enter();
    } else {
      this._edit.exit();
      if (this._floorOnly) { // back to the view the chips show (camera kept)
        this._floorOnly = null;
        this._applyViewVisibility();
        this._applyMarkerStates();
      }
    }
    this._built.rooms = undefined; // model look: outlines and labels only while editing
    if (this._layout && this._layout.mower && this._hass) this._refreshMapOverlay(); // "map only in edit mode"
    this._schedule();
    this._syncToolbar();
    // the panel changes the canvas size: resize once the layout has settled; the camera stays
    requestAnimationFrame(() => this._resize());
  }

  // Apply an edited layout: rebuild the plan and save it.
  _commit(layout) {
    this._layout = layout;
    const seq = (this._saveSeq = (this._saveSeq || 0) + 1);
    this._edit.setSaveState('saving');
    this._store.save(this._hass, layout).then((ok) => {
      if (seq === this._saveSeq) this._edit.setSaveState(ok ? 'saved' : 'failed');
    });
    this._schedule();
  }

  _applyMarkerSelection(id) {
    for (const [mid, el] of this._markerEls) el.classList.toggle('selected', mid === id);
  }

  _resize() {
    const r = this._stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this._view.resize(r.width, r.height);
    if (!this._fitted && this._roomList) this._initialCamera();
  }

  _schedule() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => {
      this._pending = false;
      if (this._view && this._hass && this._layout) this._update();
    });
  }

  // Rebuild only what changed. Edits replace just the layout parts they touch, so identity
  // comparisons per part keep e.g. overlay slider changes from rebuilding the whole scene.
  _update() {
    const h = this._hass;
    const b = this._built;
    const l = this._layout;
    let structure = false, markers = false, mower = false;

    if (h.themes !== b.themes || !b.theme) {
      b.themes = h.themes;
      this._applyTheme();
      structure = true;
    }
    const mb = this.modelBindings();
    this._mb = mb;
    const viewsChanged = this._resolveViewList(mb);
    if (viewsChanged) this._checkMergeKeep();
    const viewsOnly = viewsChanged === 'views'; // only layout.views / view_order: no scene or marker rebuild
    let viewRefreshed = false;
    const mkIn = [mb, this._config, l.model];
    if (!b.modelKeyIn || mkIn.some((x, i) => x !== b.modelKeyIn[i])) {
      b.modelKeyIn = mkIn;
      b.modelKeyNow = mb ? JSON.stringify([mb.levels, mb.rooms, this._modelAlign()]) : '';
    }
    const modelKey = b.modelKeyNow;
    if (structure || (viewsChanged && !viewsOnly) || l.rooms !== b.rooms || l.floors !== b.lfloors || h.floors !== b.floors || h.areas !== b.areas
      || (mb && mb.manifest) !== b.manifest || modelKey !== b.modelKey) {
      b.manifest = mb && mb.manifest;
      b.modelKey = modelKey;
      this._buildStructure(mb, !!viewsChanged);
      markers = true;
    } else if (viewsOnly) {
      this._refreshViews();
      viewRefreshed = true;
    }
    const sig = registrySignature(h);
    const m = l.mower || null;
    const mowerKey = m ? `${m.entity}|${m.floor_id}` : '';
    if (this._syncBindings() || markers || !b.sig || sig.some((x, i) => x !== b.sig[i]) || l.pins !== b.pins || l.hidden !== b.hidden || mowerKey !== b.mowerKey) {
      b.sig = sig;
      b.pins = l.pins;
      b.hidden = l.hidden;
      b.mowerKey = mowerKey;
      this._buildMarkers();
      markers = true;
    }
    if (l.model !== b.model) {
      b.model = l.model;
      this._loadModel();
    }
    if (m !== b.mower) {
      b.mower = m;
      this._mowerFn = m && m.entity ? mowerTransform(m) : null;
      mower = true;
    }
    if (h.states !== b.states || markers || mower) {
      b.states = h.states;
      this._refreshStates();
      this._refreshMower(mower);
    }
    this._updateObjects();
    this._popup.update();
    if ((markers || viewRefreshed) && this._editing) this._edit.afterUpdate();
    else if (this._editing) this._edit.onStates();
  }

  _mowerFloor() {
    const m = this._layout.mower;
    return m && this._floors.some((f) => f.id === m.floor_id) ? m.floor_id : this._floors[0].id;
  }

  // Live mower: move its marker, extend the trail, refresh the map overlay.
  _refreshMower(configChanged) {
    const cfg = this._layout.mower;
    if (!cfg || !cfg.entity) {
      this._trail = [];
      this._mowerLive = null;
      this._view.setTrail(null);
      this._view.setMapOverlay(null);
      this._setCameraTimer(0);
      this._setImageTimer(0);
      return;
    }
    const floorId = this._mowerFloor();
    let reading = null, p;
    if (cfg.source === 'image') p = this._imageMowerPos(cfg);
    else {
      this._setImageTimer(0);
      this._imageBlob = null;
      this._imageResult = null;
      reading = readSource(this._hass.states[cfg.entity], cfg);
      p = reading && this._mowerFn ? this._mowerFn(reading) : null;
    }
    this._mowerLive = p ? { x: p[0], y: p[1], floorId, reading } : (reading ? { reading } : null);
    this._poseMowerObject(p, floorId);
    this._refreshAttached(); // markers attached to the mower ride along
    const id = this._mowerMarkerId;
    if (p && id) {
      const pos = { x: p[0], y: p[1], z: this._mowerZ(p[0], p[1], floorId), floorId, auto: false, live: true };
      const prev = this._positions.get(id);
      this._positions.set(id, pos);
      if (!this._view.markerObjects.has(id)) {
        this._buildMarkers();
        this._refreshStates();
      } else if (!prev || prev.x !== pos.x || prev.y !== pos.y || prev.z !== pos.z || prev.floorId !== floorId) {
        this._view.moveMarker(id, pos.x, pos.y, pos.z, floorId); // only when it actually moved
      }
    }
    if (configChanged) this._trail = [];
    if (cfg.trail !== false) {
      const t = (this._trail = this._trail || []);
      const last = t[t.length - 1];
      if (p && (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= TRAIL_STEP_M)) {
        t.push(p);
        if (t.length > TRAIL_MAX) t.splice(0, t.length - TRAIL_MAX);
        this._view.setTrail(t, floorId);
      } else if (configChanged) {
        this._view.setTrail(t, floorId);
      }
    } else {
      this._view.setTrail(null);
    }
    this._refreshMapOverlay();
    this._updateMowerWarning();
  }

  // ---------- warning over the mower (error / stuck) ----------
  // The lawn_mower state entity: the bound mower object's, else the one of the position entity's device.
  _mowerStateEntity() {
    const cfg = this._layout && this._layout.mower;
    if (!cfg || !cfg.entity) return null;
    const o = this._objects && this._objects.mowerEntity();
    if (o) return o;
    if (cfg.entity.startsWith('lawn_mower.')) return cfg.entity;
    const h = this._hass, reg = h && h.entities && h.entities[cfg.entity];
    if (reg && reg.device_id) {
      const sib = Object.keys(h.entities).find((e) => e.startsWith('lawn_mower.') && h.entities[e].device_id === reg.device_id);
      if (sib) return sib;
    }
    return cfg.entity;
  }

  // Red warning on error, yellow when mowing but not moving; the position is the live one (gps / xy / image).
  _updateMowerWarning() {
    clearTimeout(this._stuckTimer);
    this._stuckTimer = null;
    const cfg = this._layout && this._layout.mower, h = this._hass, view = this._view;
    if (!view) return;
    if (!cfg || !cfg.entity || !h) { this._stuck = null; this._warning = null; view.setMowerWarning(null); return; }
    const ms = h.states[this._mowerStateEntity()], es = cfg.error_entity ? h.states[cfg.error_entity] : null;
    const live = this._mowerLive, pos = live && live.x !== undefined ? [live.x, live.y] : null;
    const minutes = cfg.stuck_minutes === undefined ? STUCK_DEFAULT_MIN : Number(cfg.stuck_minutes) || 0;
    const now = Date.now();
    this._stuck = stuckStep(this._stuck, { now, pos, state: ms && ms.state, minutes });
    const kind = errorKind(ms, es) || (this._stuck.stuck ? 'stuck' : null);
    this._warning = kind ? { kind, minutes } : null;
    if (kind && pos) view.setMowerWarning({ kind, x: pos[0], y: pos[1], floorId: live.floorId });
    else view.setMowerWarning(null);
    const due = stuckDueIn(this._stuck, now, minutes);
    if (due !== null && this.isConnected) this._stuckTimer = setTimeout(() => this._updateMowerWarning(), due + 100);
    if (this._popup && this._popup.el) this._popup.update();
  }

  // Popup row for the warning: { label, value } or null.
  _warningText() {
    const w = this._warning, h = this._hass, cfg = this._layout && this._layout.mower;
    if (!w || !h || !cfg) return null;
    if (w.kind === 'stuck') return { label: 'Stuck?', value: `no movement for ${w.minutes} min` };
    return { label: 'Error', value: errorText(h.states[this._mowerStateEntity()], cfg.error_entity ? h.states[cfg.error_entity] : null) || 'error' };
  }

  // ---------- mower position from the live map image ----------
  // The last detected icon pixel mapped through the current overlay alignment; schedules detection
  // when the image changes (image entities) and every refresh interval (cameras, and as a fallback).
  _imageMowerPos(cfg) {
    const ic = cfg.image || {};
    const entity = ic.entity || (cfg.overlay && cfg.overlay.entity);
    const st = entity && this._hass.states[entity];
    const ready = !!(st && ic.color && cfg.overlay);
    // the overlay's own picture: detection runs on each loaded overlay image (one fetch per refresh)
    const driven = ready && this._mapDriven(cfg);
    this._setImageTimer(ready && !driven ? Math.max(2, Number(cfg.overlay.refresh) || 10) : 0);
    if (!ready) {
      this._imageBlob = null;
      this._imageResult = !st ? { error: entity ? `Map image ${entity} not found.` : 'Set the map overlay first.' } : null;
      return null;
    }
    const key = [entity, driven ? '' : st.last_updated, driven ? '' : st.state, ic.color.join(','), ic.tolerance, ic.min_pixels].join('|');
    if (key !== this._imageKey) {
      this._imageKey = key;
      if (driven) this._reprocessMap(); // detection settings changed: run again on the loaded picture
      else this._detectMower();
    }
    const b = this._imageBlob;
    if (!b) return null;
    const q = pixelToPlan(b.px, b.py, b.imgW, b.imgH, cfg.overlay);
    return [q.x, q.y];
  }

  _setImageTimer(seconds) {
    if (!this.isConnected) seconds = 0;
    if (this._imageTimerSec === seconds) return;
    clearInterval(this._imageTimer);
    this._imageTimerSec = seconds;
    this._imageTimer = seconds ? setInterval(() => this._detectMower(), seconds * 1000) : null;
  }

  // The mower icon is looked for on the overlay's own picture (no separate image entity).
  _mapDriven(cfg) {
    const ic = cfg && cfg.source === 'image' && cfg.image;
    const o = cfg && cfg.overlay;
    return !!(ic && ic.color && o && o.entity && (!ic.entity || ic.entity === o.entity));
  }

  // Find the icon colour in sampled pixels (imagePixels / readImagePixels), track it, store the pixel.
  // -> { result, found } (found: the blob seen in this picture, image pixels)
  _detectOn(img, ic) {
    const k = img.imgW / img.width; // sampled canvas -> image pixels
    const old = this._imageBlob;
    const sameColor = !!old && String(old.color) === String(ic.color);
    // the picture may change size between refreshes: the track scales with it (same geometry)
    const rs = sameColor && old.imgW > 0 ? img.imgW / old.imgW : 1;
    const track = sameColor ? { px: (old.px * rs) / k, py: (old.py * rs) / k, count: old.count == null ? null : (old.count * rs * rs) / (k * k), misses: old.misses || 0 } : null;
    const b = findBlob(img.data, img.width, img.height, ic.color, ic.tolerance ?? 40, { minPixels: ic.min_pixels ?? 4, prev: track });
    const step = stepTrack(track, b);
    if (step.found) {
      this._imageBlob = { px: b.px * k, py: b.py * k, count: b.count * k * k, misses: 0, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, color: ic.color };
      return { result: { count: b.count }, found: this._imageBlob };
    }
    if (!sameColor) this._imageBlob = null; // a stale position of another colour would mislead
    else if (rs !== 1) { // last known position and count, in this picture's pixels
      this._imageBlob = { ...old, px: old.px * rs, py: old.py * rs, count: old.count == null ? null : old.count * rs * rs, imgW: img.imgW, imgH: img.imgH, sampleW: img.width, misses: step.track.misses };
    } else this._imageBlob = { ...old, misses: step.track.misses }; // last known position, count kept
    return { result: { missing: true }, found: null };
  }

  // Read the map image (a separate image entity), find the icon colour, store the pixel. Async
  // (fetch + createImageBitmap), one run at a time; skipped while disconnected or the tab is hidden.
  async _detectMower() {
    if (!this.isConnected || !this._hass || !this._layout) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this._imageBusy) { this._imageAgain = true; return; }
    const cfg = this._layout.mower;
    const ic = (cfg && cfg.source === 'image' && cfg.image) || null;
    const entity = ic && (ic.entity || (cfg.overlay && cfg.overlay.entity));
    if (!ic || !ic.color || !entity || this._mapDriven(cfg)) return;
    const url = overlayUrl(this._hass, entity, Date.now());
    if (!url) return;
    this._imageBusy = true;
    let result;
    try {
      result = this._detectOn(await readImagePixels(url), ic).result;
    } catch (e) {
      console.warn('floorplan3d: could not read the mower map image', e);
      result = { error: "Can't read the map image." };
    } finally {
      this._imageBusy = false;
    }
    const now = this._layout && this._layout.mower;
    if (!now || now.source !== 'image') return;
    this._imageResult = result;
    if (this._view) this._refreshMower(false);
    if (this._editing && this._edit) this._edit.onStates();
    if (this._imageAgain) {
      this._imageAgain = false;
      this._detectMower();
    }
  }

  // A bound mower object follows the live position; heading from the last real movement (> 5 cm;
  // image source: > max(0.25 m, 3 map pixels), so detection noise never turns it).
  _poseMowerObject(p, floorId) {
    const layer = this._objects;
    if (!layer || !layer.mowerBound()) { this._mowerHeadFrom = null; layer && layer.setMowerPose(null); return; }
    if (!p) return;
    const from = this._mowerHeadFrom;
    if (!from) this._mowerHeadFrom = [p[0], p[1]];
    else if (Math.hypot(p[0] - from[0], p[1] - from[1]) > this._headingStep()) {
      this._mowerHeading = Math.atan2(p[1] - from[1], p[0] - from[0]);
      this._mowerHeadFrom = [p[0], p[1]];
    }
    layer.setMowerPose({ x: p[0], y: p[1], floorId, heading: this._mowerHeading, ground: this._view.groundAt(p[0], p[1]) });
  }

  // Mower marker height above its HA floor: MOWER_Z over the ground under it (the lawn of the model,
  // cached per 0.5 m cell), so a garden floor at an odd elevation does not lift it off the lawn.
  _mowerZ(x, y, floorId) {
    const g = this._view.groundAt(x, y);
    return g === null ? MOWER_Z : g - this._view.floorElevation(floorId) + MOWER_Z;
  }

  _headingStep() {
    const m = this._layout && this._layout.mower, b = this._imageBlob;
    return headingMinStep(m && m.source, m && m.overlay && m.overlay.width, b && b.sampleW);
  }

  clearTrail() {
    this._trail = [];
    this._view.setTrail(null);
  }

  // One pass per loaded map picture (view.onMapImage): a single readback at working size, mower
  // detection on it (when the icon is on the overlay's own picture; a new picture only, re-runs on the
  // same picture reuse that result), then the processed picture (transparent background, mowed stripes,
  // shaded no-mow, hidden icon, zone clip; in a worker where possible) and its statistics.
  // -> Promise of { canvas, width, height } | null (draw as loaded) | undefined (keep what is shown)
  async _onMapImage(image, W, H) {
    const cfg = this._layout && this._layout.mower;
    const o = cfg && cfg.overlay;
    if (!o || !W || !H) return null;
    const driven = this._mapDriven(cfg);
    const pre = this._mapSettings(o, null);
    const wantIcon = driven && o.hide_icon !== false;
    if (!driven && !pre) {
      if (this._mapStats) { this._mapStats = null; this._mapStatsChanged(); }
      return null;
    }
    const proc = (this._mapProc = this._mapProc || new MapProcessor());
    const px = proc.read(image, W, H);
    let blob = null;
    if (driven) {
      const ic = cfg.image;
      const dkey = [String(ic.color), ic.tolerance, ic.min_pixels].join('|');
      const last = this._mapDetect;
      if (last && last.image === image && last.key === dkey) {
        blob = last.found; // same picture, same settings: not a new sighting / miss
      } else {
        const d = this._detectOn(px, ic);
        blob = d.found;
        this._mapDetect = { image, key: dkey, found: d.found };
        this._imageResult = d.result;
        if (!this._mowerRefreshQueued) {
          this._mowerRefreshQueued = true;
          queueMicrotask(() => {
            this._mowerRefreshQueued = false;
            if (!this._view || !this._layout || !this._layout.mower) return;
            this._refreshMower(false);
            if (this._editing && this._edit) this._edit.onStates();
          });
        }
      }
    }
    const s = wantIcon && blob ? this._mapSettings(o, blob) : pre;
    if (!s) {
      if (this._mapStats) { this._mapStats = null; this._mapStatsChanged(); }
      return null;
    }
    let r;
    try {
      r = await proc.process(px, s);
    } catch (e) {
      console.warn('floorplan3d: could not process the mower map', e);
      return undefined;
    }
    const was = this._mapStats;
    this._mapStats = { zone: s.zoneId || null, angle: s.mowed ? r.angle : null, share: s.mowed ? mowedShare(r) : null };
    if (!was || was.angle !== this._mapStats.angle || was.share !== this._mapStats.share) this._mapStatsChanged();
    return r;
  }

  // Process the loaded picture again after a settings change; 150 ms debounce (slider drags).
  _reprocessMap() {
    clearTimeout(this._mapReprocTimer);
    this._mapReprocTimer = setTimeout(() => { if (this._view) this._view.reprocessMap(); }, 150);
  }

  _mapStatsChanged() {
    if (this._popup) this._popup.update();
    if (this._editing && this._edit) this._edit.onStates();
    if (this._view) this._stripeArrow();
  }

  // Processing settings of the overlay (null: none set, the picture is drawn as loaded).
  // blob: the mower icon found in this very picture (image pixels) or null.
  _mapSettings(o, blob) {
    const col = (c, t, d) => (Array.isArray(c) && c.length >= 3 ? { color: c.map(Number), tolerance: Number(t ?? d) } : null);
    const bg = col(o.bg_color, o.bg_tolerance, 30), mowed = col(o.mowed_color, o.mowed_tolerance, 30), nomow = col(o.nomow_color, o.nomow_tolerance, 30);
    const ic = this._layout.mower.image || {};
    const iconBlob = blob && o.hide_icon !== false ? { px: blob.px, py: blob.py, count: blob.count, color: ic.color, tolerance: ic.tolerance ?? 40 } : null;
    const explicitZone = !!o.zone && o.zone !== 'auto' && o.zone !== 'none';
    if (!bg && !mowed && !nomow && !iconBlob && !explicitZone) return null;
    const zone = this.mapZone(o);
    return { bg, mowed, nomow, iconBlob, dilate: 3, zone: zone ? zone.polygon : null, zoneId: zone ? zone.id : null, overlay: o };
  }

  // Zone the map is clipped to: overlay.zone = a zone id, 'none', or unset / 'auto' = the zone
  // (model room / outdoor outline) containing the overlay centre, the smallest one.
  mapZone(o) {
    const zones = this._zones || [];
    if (!o || o.zone === 'none') return null;
    if (o.zone && o.zone !== 'auto') return zones.find((z) => z.id === o.zone) || null;
    const c = [Number(o.x) || 0, Number(o.y) || 0];
    let best = null, area = Infinity;
    for (const z of zones) {
      if (!pointInPolygon(c, z.polygon)) continue;
      const a = Math.abs(signedArea(z.polygon));
      if (a < area) { area = a; best = z; }
    }
    return best;
  }

  // "Stripes" / "Mowed" texts from the last processed map (null each when unknown).
  mapInfo() {
    const st = this._mapStats, o = this._layout && this._layout.mower && this._layout.mower.overlay;
    if (!st || !o) return { stripes: null, mowed: null };
    // against true north: the model's north and alignment rotation, as the sky uses them
    const m = this._view && this._view.model;
    const b = st.angle != null ? stripeBearing(st.angle, o.rotation, m ? m.north || 0 : 0, m ? this._modelAlign().rotation || 0 : 0) : null;
    return {
      stripes: b ? `${b.bearing}° (${b.label})` : null,
      mowed: st.share != null ? `${Math.round(st.share * 100)} %` : null,
    };
  }

  _stripeArrow() {
    const o = this._layout && this._layout.mower && this._layout.mower.overlay;
    const st = this._mapStats;
    if (!o || !o.stripe_arrow || !st || st.angle == null) { this._view.setStripeArrow(null); return; }
    const z = this.mapZone(o);
    const c = z ? insidePoint(z.polygon) : [o.x || 0, o.y || 0];
    this._view.setStripeArrow({ x: c[0], y: c[1], angle: st.angle + (Number(o.rotation) || 0), length: Math.min(4, (o.width || 20) / 3) });
  }

  _refreshMapOverlay() {
    const cfg = this._layout.mower;
    const o = cfg && cfg.overlay;
    const st = o && o.entity && this._hass.states[o.entity];
    if (!st) {
      this._view.setMapOverlay(null);
      this._setCameraTimer(0);
      this._mapProcKey = null;
      return;
    }
    const camera = o.entity.startsWith('camera.');
    this._setCameraTimer(camera ? Math.max(1, Number(o.refresh) || 10) : 0);
    // image entities change their state when the picture changes; cameras are polled
    const bust = camera ? this._cameraTick || 1 : st.last_updated || st.state;
    this._view.setMapOverlay({
      url: overlayUrl(this._hass, o.entity, bust),
      x: o.x, y: o.y, rotation: o.rotation, width: o.width, opacity: o.opacity,
      floorId: this._mowerFloor(), heightOffset: o.height_offset || 0,
      hidden: !!o.edit_only && !this._editing, // detection keeps reading the loaded image
    });
    // processing settings (and the alignment, which moves the zone clip) changed: process the
    // loaded picture again
    // the alignment only matters to a zone clip (it moves the clip over the picture)
    const z = this.mapZone(o);
    const pk = JSON.stringify([o.bg_color, o.bg_tolerance, o.mowed_color, o.mowed_tolerance, o.nomow_color, o.nomow_tolerance,
      o.hide_icon, o.zone, z && z.id, z && z.polygon, ...(z ? [o.x, o.y, o.rotation, o.width] : [])]);
    if (pk !== this._mapProcKey) {
      const first = this._mapProcKey == null;
      this._mapProcKey = pk;
      if (!first) this._reprocessMap();
    }
    this._stripeArrow();
  }

  _setCameraTimer(seconds) {
    if (this._cameraTimerSec === seconds) return;
    clearInterval(this._cameraTimer);
    this._cameraTimerSec = seconds;
    this._cameraTimer = seconds && this.isConnected ? setInterval(() => {
      this._cameraTick = Date.now();
      this._refreshMapOverlay();
    }, seconds * 1000) : null;
  }

  _applyTheme() {
    const bg = cssColor(this, '--card-background-color', '#ffffff');
    const text = cssColor(this, '--primary-text-color', '#212121');
    const dark = this._hass.themes && typeof this._hass.themes.darkMode === 'boolean'
      ? this._hass.themes.darkMode : luminance(bg) < 0.4;
    const mix = (a, c, t) => a.clone().lerp(c, t);
    this._built.theme = {
      dark,
      floor: mix(bg, text, dark ? 0.09 : 0.05),
      outdoor: mix(bg, new Color('#5a9e4b'), dark ? 0.22 : 0.3),
      wall: mix(bg, text, dark ? 0.42 : 0.3),
      edge: mix(bg, text, dark ? 0.3 : 0.22),
      primary: cssColor(this, '--primary-color', '#03a9f4'),
    };
    this._view.setTheme(this._built.theme);
  }

  _buildStructure(mb, viewsChanged = false) {
    const h = this._hass, b = this._built;
    b.rooms = this._layout.rooms;
    b.lfloors = this._layout.floors;
    b.floors = h.floors;
    b.areas = h.areas;
    const align = this._modelAlign();
    // a level bound to an HA floor gives that floor its elevation and height (user overrides win);
    // untagged levels use their measured geometry
    let overrides = [];
    if (mb) {
      const meas = measuredElevations(mb.manifest.levels);
      const levels = mb.manifest.levels.map((lv) => (meas[lv.id] ? { ...lv, elevation: meas[lv.id].elevation, height: lv.height ?? meas[lv.id].height } : lv));
      overrides = levelFloorOverrides(levels, mb.levels, align);
    }
    this._floors = mergeFloors(h, { ...this._layout, floors: [...overrides, ...(this._layout.floors || [])] });
    this._modelRooms = mb ? modelRooms(mb.manifest.rooms, mb.levels, mb.rooms, align) : [];
    // every model room / zone outline in card plan, for roomless markers (pins) by position
    this._zones = mb ? mb.manifest.rooms.filter((r) => Array.isArray(r.outline) && r.outline.length > 2)
      .map((r) => ({ id: r.id, level: r.level, polygon: r.outline.map((p) => transformPoint(p, align)) })) : [];
    if (mb) {
      this._view.setModelLevels(mb.levels);
      const levelOrder = levelOrders(mb.manifest.levels);
      const levelFloor = {};
      for (const [id, a] of Object.entries(mb.levels || {})) if (a && a.floor) levelFloor[id] = a.floor;
      this._levels = { levelOrder, levelFloor, floorLevel: floorLevels(levelFloor, levelOrder) };
    } else {
      this._levels = null;
    }
    const roomLevel = new Map(mb ? mb.manifest.rooms.map((r) => [r.id, r.level]) : []);
    this._roomList = this._allRooms().map((room) => {
      const floorId = roomFloorId(room, h, this._floors);
      return {
        room, floorId,
        name: room.name || (room.area_id ? areaName(h, room.area_id) : room.label || ''),
        levelId: room.modelId ? roomLevel.get(room.modelId) : this._levels ? this._levels.floorLevel[floorId] : undefined,
      };
    });

    const fresh = !!this._viewFresh;
    this._viewFresh = false;
    this._pickView();
    if (viewsChanged) this._floorOnly = null;
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
    this._applyZoomTo();
    this._pushStructure();
    if (!this._floorOnly) this._applyViewVisibility();
    this._empty.hidden = this._roomList.length > 0 || !!this._editing;
    this._empty.textContent = 'No rooms drawn yet. Open edit mode to draw rooms for your areas.';
    this._syncToolbar();
    // frame once per load / model; later rebuilds (edits, registry changes) keep the user's camera
    if (fresh) {
      this._fitted = false;
      this._initialCamera();
    }
  }

  // The active view: kept while it exists, else the configured / first one. Resets the per-view states.
  _pickView() {
    this._viewStates = new Map();
    if (!this._views.some((v) => v.id === this._viewId && !v.hidden)) {
      const withRooms = this._floors.find((f) => this._roomList.some((r) => r.floorId === f.id)) || this._floors[0];
      this._viewId = defaultViewId(this._views, {
        viewId: this._config.view_id, floor: this._config.floor, fallback: this._view.model ? null : withRooms.id,
      }, (v) => this._stateFor(v).floors);
      this._floorOnly = null;
    }
  }

  // View settings changed (rules, labels, cameras, floors, cut, order): re-resolve visibility and
  // marker states only; the scene, rooms and markers stay.
  _refreshViews() {
    this._pickView();
    this._floorOnly = null;
    const cur = this.currentView();
    this._viewState = cur ? this._stateFor(cur) : null;
    this._applyZoomTo();
    if (this._labelKeyNow() !== this._labelKey) this._pushStructure();
    this._applyViewVisibility();
    this._applyMarkerStates();
    this._syncToolbar();
  }

  // Rooms, walls and labels into the view. Labels with a model: edit mode, or storey views for
  // rooms on the view's primary level.
  _pushStructure() {
    const hasModel = !!this._view.model;
    const st = this._viewState;
    const mode = this._config.room_labels || 'size';
    this._labelKey = this._labelKeyNow();
    const labelled = (r) => !hasModel || !!this._editing || (!!st && !st.overview && !!st.primary && r.levelId === st.primary);
    const rooms = (this._roomList || []).map((r) => ({
      room: r.room, floorId: r.floorId, label: labelled(r) ? roomLabel(r.name, r.room.polygon, mode) : '',
    }));
    this._view.setStructure(this._floors, rooms, {
      wallHeight: Number(this._config.wall_height) || 1.0,
      walls: !hasModel, fills: !hasModel, outlines: !hasModel || !!this._editing, labels: true,
    });
    this._stage.classList.toggle('has-model', hasModel);
  }

  _labelKeyNow() {
    const st = this._viewState;
    if (!this._view.model || this._editing) return '*';
    return st && !st.overview && st.primary ? 'p:' + st.primary : '';
  }

  // Views from the model (or HA floors without one) merged with layout + YAML overrides.
  // Returns true when they changed. A new model resets the node index and re-frames.
  _resolveViewList(mb) {
    const l = this._layout, b = this._built;
    // same inputs (by identity) as last time: nothing to resolve (the usual per-state-update case)
    const inputs = [mb, l.views, l.view_order, l.floors, l.model, this._hass.floors, this._config];
    if (b.viewInputs && inputs.every((x, i) => x === b.viewInputs[i])) return false;
    b.viewInputs = inputs;
    const manifest = mb ? mb.manifest : null;
    const haFloors = mergeFloors(this._hass, manifest ? { floors: [] } : l);
    const savedLevels = { ...(this._config.model ? levelsFromFloorMap(this._config.model_floors) : {}), ...((l.model && l.model.levels) || {}) };
    const key = JSON.stringify([haFloors.map((f) => [f.id, f.name]), this._config.views || null, savedLevels, mb ? mb.levels : null]);
    const vkey = JSON.stringify([l.views || null, l.view_order || null]);
    if (manifest === b.viewManifest && key === b.viewKey && vkey === b.viewsKey) return false;
    const onlyViews = manifest === b.viewManifest && key === b.viewKey && !!this._floors;
    if (manifest !== b.viewManifest) {
      this._index = manifest && this._view.model ? nodeIndex(threeAdapter(this._view.model.root), manifest) : null;
      this._viewFresh = true;
    }
    b.viewManifest = manifest;
    b.viewKey = key;
    b.viewsKey = vkey;
    this._views = orderViews(resolveViews({ manifest, haFloors, layoutViews: l.views, yamlViews: this._config.views, savedLevels }), l.view_order);
    return onlyViews ? 'views' : true;
  }

  // Per view: effective node visibility, primary storey, linked HA floors (cached until the next rebuild).
  _stateFor(v) {
    let st = this._viewStates.get(v.id);
    if (st) return st;
    const allIds = (this._floors || []).map((f) => f.id);
    const mb = this._mb;
    if (!mb || !this._index || !this._levels) {
      const allFloors = v.id === 'all' && !Array.isArray(v.floors);
      st = { effective: null, primary: null, floors: Array.isArray(v.floors) ? [...v.floors] : allFloors ? allIds : [], allFloors, overview: allFloors };
    } else {
      const effective = resolveVisibility(this._index, v.rules);
      const primary = primaryLevel(this._index, effective, mb.manifest.levels);
      const allFloors = !Array.isArray(v.floors) && v.id === 'all' && v.source !== 'model';
      const floors = Array.isArray(v.floors) ? [...v.floors] : allFloors ? allIds : defaultFloors(primary, this._levels.levelFloor);
      st = { effective, primary, floors, allFloors, overview: isOverview(this._index, effective, mb.manifest.levels) };
    }
    this._viewStates.set(v.id, st);
    return st;
  }

  currentView() {
    return this._views.find((v) => v.id === this._viewId) || null;
  }

  // Zoom pivot of the active view (view zoom_to > card zoom_to > centre).
  _applyZoomTo() {
    if (this._view) this._view.setZoomTo(zoomToFor(this.currentView(), this._config));
  }

  viewIndex() {
    return this._index || null;
  }

  // Floors, model node visibility and cut for the active view.
  _applyViewVisibility() {
    const vw = this._view, v = this.currentView(), section = this._sectionActive();
    const st = section ? this._sectionState() : this._viewState;
    if (section) this._applySectionPlane();
    else if (vw.sectionClip) vw.setSection(null);
    if (!v || !st) {
      this._floor = 'all';
      vw.setVisibleFloors('all');
      vw.applyModelVisibility(null, null);
      vw.setCut(undefined);
      return;
    }
    const visible = st.allFloors || (!st.floors.length && v.id === 'all') ? 'all' : st.floors;
    this._floor = visible === 'all' ? 'all' : st.floors[0] || 'all';
    vw.setVisibleFloors(visible);
    if (this._index && vw.model && st.effective) {
      vw.applyModelVisibility(this._index, st.effective);
      if (section) { vw.setCut(null); return; }
      const floors = st.floors.map((id) => this._floors.find((f) => f.id === id)).filter(Boolean);
      vw.setCut(viewCut(v, { tagged: vw.isTagged(), floors }));
    } else {
      vw.applyModelVisibility(null, null);
      vw.setCut(undefined);
    }
  }

  // Devices follow the view's visible rooms / linked floors (model only; without one the floor rules apply).
  _applyMarkerStates() {
    const vw = this._view, mb = this._mb, L = this._levels;
    const st = this._sectionActive() ? this._sectionState() : this._viewState;
    if (!mb || !this._index || !vw.model || !st || !st.effective || !L || this._floorOnly || !this._positions) {
      vw.setMarkerStates(null);
      return;
    }
    const roomByArea = new Map();
    for (const r of this._modelRooms || []) if (r.area_id && !roomByArea.has(r.area_id)) roomByArea.set(r.area_id, r.modelId);
    const roomLevel = new Map(mb.manifest.rooms.map((r) => [r.id, r.level]));
    const visibleRooms = new Set();
    this._index.nodes.forEach((n, i) => {
      if (st.effective[i] && n.tag && (n.tag.kind === 'room' || n.tag.kind === 'zone')) visibleRooms.add(n.tag.id);
    });
    const ctx = {
      levelOrder: L.levelOrder, primaryOrder: st.primary ? L.levelOrder[st.primary] ?? null : null,
      visibleRooms, viewFloors: new Set(st.floors), overview: st.overview,
    };
    const byId = new Map(this._markers.map((m) => [m.id, m]));
    const states = new Map();
    const outdoor = exteriorShown(this._index, st.effective, mb.manifest.levels);
    for (const [id, p] of this._positions) {
      const m = byId.get(id);
      // the live mower is outdoors: shown wherever an exterior level shows
      if (p.live && outdoor !== null) { states.set(id, { shown: outdoor, faded: false }); continue; }
      // pins (and the mower without exterior levels) are roomless: the room / zone under them, else their HA floor
      const roomId = !m ? null : p.auto === false || p.live
        ? roomAt([p.x, p.y], p.floorId, this._zones, L.levelFloor, visibleRooms) : roomByArea.get(m.areaId) || null;
      states.set(id, deviceState({
        roomId, roomLevelId: roomId ? roomLevel.get(roomId) : undefined, markerFloorId: p.floorId, floorLevelId: L.floorLevel[p.floorId],
      }, ctx));
    }
    vw.setMarkerStates(states);
  }

  // A view's cameras in card world (model cameras follow the model alignment).
  viewCamera(v) {
    return cameraToCard(v, this._view.model ? (p) => this._view.modelPointToWorld(p) : null);
  }

  viewTopCamera(v) {
    return topCameraToCard(v, this._view.model ? this._modelAlign() : null);
  }

  // Chip switch. The camera moves only for a view with its own camera (no model: frame the floor, as before).
  _setView(id, { instant = false } = {}) {
    const v = this._views.find((x) => x.id === id);
    if (!v) return;
    const wasSection = this._section;
    this._popup.close();
    this._section = false;
    this._sectionPreview = null;
    this._viewId = id;
    this._floorOnly = null;
    this._viewState = this._stateFor(v);
    this._applyViewVisibility();
    if (this._labelKeyNow() !== this._labelKey) this._pushStructure();
    this._applyMarkerStates();
    this._applyZoomTo();
    if (this._mode === 'top') {
      // top view: its own camera when saved, else keep the current one (no model: frame the floor)
      if (v.camera_top) this._view.setTopCamera(this.viewTopCamera(v), { instant });
      else if (!this._view.model) this._view.fit({ instant });
    } else if (v.camera) this._view.setCamera(this.viewCamera(v), { instant });
    else if (!this._view.model || wasSection) this._view.fit({ instant });
    this._syncToolbar();
    if (this._editing) this._edit.onViewChanged();
  }

  // First view after load / model change: its saved camera, else frame it.
  _initialCamera() {
    if (this._view.size.w <= 1) return; // _resize retries once the card has a size
    this._fitted = true;
    const v = this.currentView();
    if (v && v.camera && this._mode === '3d') this._view.setCamera(this.viewCamera(v), { instant: true });
    else {
      this._view.fit({ instant: true });
      if (v && v.camera_top && this._mode === 'top') this._view.setTopCamera(this.viewTopCamera(v), { instant: true });
    }
  }

  // Reset view: the view's saved camera (3D incl. its rotation centre; top: camera_top), else frame it.
  _resetCamera() {
    if (this._section) this.setSection(false, { camera: false });
    const v = this.currentView();
    if (this._mode === 'top') {
      if (v && v.camera_top) this._view.setTopCamera(this.viewTopCamera(v));
      else this._view.fit();
    } else this._view.resetCamera(this.viewCamera(v));
  }

  // ---------- side section ----------
  _sectionActive() {
    if (this._section && (!this._mb || !this._index || !this._view.model)) this._dropSection(); // model gone: fully off
    return this._section && this._mode === '3d' && !this._floorOnly;
  }

  // Section off without touching visibility or camera (callers re-apply what they need).
  _dropSection() {
    this._section = false;
    this._sectionPreview = null;
    if (this._view.sectionClip) this._view.setSection(null);
    if (this._sectionBtn) this._sectionBtn.classList.remove('on');
  }

  // "Show all" while the section is on: every node, all floors, overview device rules.
  _sectionState() {
    const effective = this._index.nodes.map(() => true);
    return {
      effective, primary: primaryLevel(this._index, effective, this._mb.manifest.levels),
      floors: (this._floors || []).map((f) => f.id), allFloors: true, overview: true,
    };
  }

  // A view's cut plane in card world (the active view: the Views tab preview while sliding wins).
  sectionPlaneNow(v = this.currentView()) {
    const box = this._view.sectionBox();
    if (!box || !v) return null;
    if (this._sectionPreview && v.id === this._viewId) return this._sectionPreview;
    return sectionPlane(v, box, (p) => this._view.modelPlaneToWorld(p));
  }

  _applySectionPlane() {
    const plane = this.sectionPlaneNow();
    this._view.setSection(plane);
  }

  // Section off and back at the view's camera at once (before saving or re-centring the camera).
  leaveSection() {
    if (!this._section) return false;
    this.setSection(false, { camera: false });
    const v = this.currentView();
    if (v && v.camera) this._view.setCamera(this.viewCamera(v), { instant: true });
    else this._view.fit({ instant: true });
    return true;
  }

  // Toggle the side section. Off returns to the view's visibility and (camera: true) its camera.
  setSection(on, { camera = true } = {}) {
    if (this._popup) this._popup.close();
    if (on) {
      if (this._mode !== '3d' || !this._view.model || !this._index) return;
      const was = this._section;
      this._section = true;
      this._applyViewVisibility();
      this._applyMarkerStates();
      const plane = this.sectionPlaneNow(), box = this._view.sectionBox();
      if (!was && plane && box) this._view.setCamera(sectionCamera(plane, box));
    } else {
      if (!this._section) return;
      this._section = false;
      this._sectionPreview = null;
      this._applyViewVisibility();
      this._applyMarkerStates();
      if (camera) this._resetCamera();
    }
    this._syncToolbar();
  }

  // Views tab: show this plane while the slider moves (turns the section on); null drops the preview.
  // aim: also move the camera to look at the new cut.
  previewSection(id, plane, { aim = false } = {}) {
    if (id !== this._viewId || this._mode !== '3d') return;
    this._sectionPreview = plane || null;
    if (!plane) { if (this._section) this._applySectionPlane(); return; }
    if (!this._section) { this.setSection(true); return; }
    this._view.setSection(plane);
    const box = this._view.sectionBox();
    if (aim && box) this._view.setCamera(sectionCamera(plane, box));
  }

  // Merge a patch into layout.views[id] and save (rules replace the stored list).
  saveViewPatch(id, patch) {
    if ('section' in patch && id === this._viewId) this._sectionPreview = null; // the saved plane takes over
    const l = this._layout;
    const views = l.views || {};
    this._commit({ ...l, views: { ...views, [id]: { ...(views[id] || {}), ...patch } } });
  }

  // Object bindings, recomputed only when the model, layout.objects / groups or the existence of
  // a candidate entity changed. True when the set of bound entities (= hidden markers) changed.
  _syncBindings() {
    const model = this._objects && this._objects.model;
    const objs = model ? model.manifest.objects : [];
    const l = this._layout || {}, lo = l.objects || NONE, groups = l.groups || NONE, states = this._hass.states;
    const exists = objs.map((o) => {
      const e = lo[o.id] && lo[o.id].entity !== undefined ? lo[o.id].entity : (o.suggest || {}).entity;
      return e && states[e] ? 1 : 0;
    }).join('') + '|' + Object.values(groups).map((g) => (g && g.entity && states[g.entity] ? 1 : 0)).join('');
    const key = [model, lo, groups, exists];
    if (this._bindKey && key.every((x, i) => x === this._bindKey[i])) return false;
    this._bindKey = key;
    this._bindings = bindObjects(objs, lo, states);
    this._groups = effectiveGroups(groups, states); // controllers HA doesn't know are ignored
    this._objects.setBindings(this._bindings, this._groups);
    const bound = new Set();
    for (const b of this._bindings.values()) if (b.entity && !b.hidden) bound.add(b.entity);
    // the mower marker depends on whether the mower object is bound (its entity may stay bound by the dock)
    const mower = this._objects.mowerBound();
    const changed = bound.size !== this._boundEntities.size || [...bound].some((e) => !this._boundEntities.has(e)) || mower !== this._mowerObjectBound;
    this._boundEntities = bound;
    this._mowerObjectBound = mower;
    return changed;
  }

  // Lamps and the light pool for the current states and view (cheap when nothing changed).
  _updateObjects() {
    const layer = this._objects;
    if (!layer || !layer.model || !this._hass || !this._config) return;
    layer.update(this._hass.states, { visibleLevel: this._levelShown(), lightsOn: this._config.lights !== 'off' });
  }

  _levelShown() {
    const levels = (this._objects.model && this._objects.model.manifest.levels) || [];
    return (id) => { const lv = levels.find((x) => x.id === id); return !lv || nodeShown(lv.node); };
  }

  // Object taps: view mode; in edit mode only on the Objects tab.
  _objectTapsOn() {
    return !this._editing || (this._edit && this._edit.tab === 'objects');
  }

  // The nearest tappable object (visible, bound, not hidden, level shown) within radius px of a client point.
  _objectHit(x, y, radius, all = false) {
    const layer = this._objects;
    this._hitWarning = false;
    if (!all && this._hass) { // the warning sprite stands for the mower object (or the mower marker)
      const w = this._view.warningWorld(), p = w && this._view.projectWorld(w);
      if (p && Math.hypot(p[0] - x, p[1] - y) <= radius) {
        this._hitWarning = true;
        return (layer && layer.mowerId()) || WARN_ID;
      }
    }
    if (!layer || !layer.model || !this._hass) return null;
    const groups = this._groups || {};
    const levelShown = this._levelShown();
    const pts = [];
    for (const a of layer.anchors()) {
      const o = layer.objectAt(a.id);
      const b = o && o.binding;
      if (!all && (!b || b.hidden || (!b.missing && !actionTarget(o.obj, b, groups) && !this._objectHasOwnActions(a.id, o)))) continue;
      if (!levelShown(o.obj.level) || !nodeShown(o.obj.node)) continue;
      const p = this._view.projectWorld(a.world);
      if (p) pts.push({ id: a.id, x: p[0], y: p[1], world: a.world, node: o.obj.node });
    }
    // nearest first; one hidden behind visible model geometry (a lamp behind a facade wall) is skipped
    const byId = new Map(pts.map((p) => [p.id, p]));
    for (const id of screenByDistance(pts, x, y, radius)) {
      const p = byId.get(id);
      if (!this._view.pointHidden(p.world, p.node)) return id;
    }
    return null;
  }

  // Tap = moved < 5 px; hold 500 ms (not moved) = hold action. Orbit still starts from the canvas.
  _objectDown(e, canvas) {
    if (this._gesture) { this._endGesture(); return; } // a second finger: pinch / orbit, no tap
    const path = e.composedPath();
    if (this._popup.closedBy === e) { // this tap closed the popup: no object or marker tap (orbit may start)
      if (e.target !== canvas && !path.some((n) => n.classList && n.classList.contains('toolbar'))) e.stopPropagation();
      return;
    }
    if (!this._objectTapsOn() || e.button !== 0 || !e.isPrimary) return;
    if ((this._popup.el && path.includes(this._popup.el)) || path.some((n) => n.classList && n.classList.contains('toolbar'))) return;
    const id = this._objectHit(e.clientX, e.clientY, e.pointerType === 'touch' ? OBJECT_HIT_PX.touch : OBJECT_HIT_PX.mouse, this._editing);
    if (!id) return; // markers and the model as before
    if (e.target !== canvas) e.stopPropagation(); // the object wins over a marker under the finger
    const g = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, long: false };
    // edit mode (Objects tab): a tap selects the object's row; no hold action
    g.warn = this._hitWarning;
    if (!this._editing && !g.warn) {
      g.timer = setTimeout(() => {
        g.long = true;
        g.timer = null;
        this._runObjectAction(id, 'hold');
      }, LONG_PRESS_MS);
    }
    g.move = (ev) => {
      if (ev.pointerId === g.pointerId && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) >= CLICK_SLOP_PX) this._endGesture();
    };
    g.up = (ev) => {
      if (ev.pointerId !== g.pointerId) return;
      const tap = !g.long && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < CLICK_SLOP_PX;
      this._endGesture();
      if (tap) {
        if (g.warn) { if (id === WARN_ID) this._moreInfo(this._mowerStateEntity()); else this._openObjectPopup(id); } // the warning always opens the mower popup
        else if (this._editing) this._edit.selectObject(id);
        else this._taps.tap(`object:${id}`, !!this._objectActions(id).double_tap, () => this._runObjectAction(id, 'tap'), () => this._runObjectAction(id, 'double_tap'));
      }
    };
    g.cancel = () => this._endGesture();
    g.menu = (ev) => ev.preventDefault(); // a touch hold opens no context menu
    window.addEventListener('pointermove', g.move, true);
    window.addEventListener('pointerup', g.up, true);
    window.addEventListener('pointercancel', g.cancel, true);
    window.addEventListener('contextmenu', g.menu, true);
    this._gesture = g;
  }

  _endGesture() {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    clearTimeout(g.timer);
    window.removeEventListener('pointermove', g.move, true);
    window.removeEventListener('pointerup', g.up, true);
    window.removeEventListener('pointercancel', g.cancel, true);
    // the contextmenu of a touch hold follows the pointerup
    setTimeout(() => window.removeEventListener('contextmenu', g.menu, true), 400);
  }

  // Objects tab "Test": the tap toggle (own entity, else the group controller). False when nothing can be toggled.
  testObject(id) {
    const o = this._objects && this._objects.objectAt(id);
    if (!o || !this._hass) return false;
    const target = actionTarget(o.obj, o.binding, this._groups || {}, this._hass.states);
    const st = target && this._hass.states[target];
    if (!st || st.state === 'unavailable' || st.state === 'unknown') return false;
    this._callService(...toggleCall(target));
    return true;
  }

  // Resolved actions of an object: type defaults < model fp.ui < layout ui (Objects tab) < YAML actions.
  _objectActions(id, o = this._objects && this._objects.objectAt(id)) {
    if (!o) return resolveActions({});
    const entity = (o.binding && o.binding.entity) || null;
    const reg = entity && this._hass && this._hass.entities && this._hass.entities[entity];
    return resolveActions({
      modelUi: o.obj.ui, layoutUi: (((this._layout && this._layout.objects) || {})[id] || {}).ui, yaml: this._config.actions,
      kind: 'object', id, entityId: entity, deviceId: (reg && reg.device_id) || null, typeDefaults: typeOf(o.obj.type).defaults,
    });
  }

  // An unbound object is still tappable when an action needs no entity (navigate, url, perform-action, assist).
  _objectHasOwnActions(id, o) {
    const a = this._objectActions(id, o);
    return [a.tap, a.hold, a.double_tap].some((x) => x && (['navigate', 'url', 'perform-action', 'assist'].includes(x.action) || x.entity));
  }

  _markerActions(m) {
    return resolveActions({
      yaml: this._config.actions, kind: 'marker', id: m.id, entityId: m.entityId, deviceId: m.deviceId,
      typeDefaults: { tap_action: { action: TAP_TOGGLE.has(m.domain) ? 'toggle' : 'more-info' }, hold_action: { action: 'more-info' } },
    });
  }

  // toggle / more-info on the object's entity (own, else the group controller); nothing usable
  // (missing / unavailable): the popup says so.
  _runObjectAction(id, which) {
    const o = this._objects.objectAt(id);
    if (!o || !this._hass) return;
    const action = this._objectActions(id, o)[which];
    if (!action || action.action === 'none') return;
    const target = actionTarget(o.obj, o.binding, this._groups || {}, this._hass.states);
    const st = target && this._hass.states[target];
    const usable = st && st.state !== 'unavailable' && st.state !== 'unknown';
    const onTarget = (action.action === 'toggle' || action.action === 'more-info') && !action.entity;
    if (action.action === 'popup' || (onTarget && !usable)) this._openObjectPopup(id, o);
    else this._runAction(action, { entity: target, objectId: id });
  }

  _openObjectPopup(id, o = this._objects.objectAt(id)) {
    const a = o && this._objects.anchors().find((x) => x.id === id);
    if (a) this._popup.open(o.obj, a.world);
  }

  _runMarkerAction(m, which) {
    const action = this._markerActions(m)[which];
    if (!action || action.action === 'none' || !this._hass) return;
    this._runAction(action.action === 'popup' ? { ...action, action: 'more-info' } : action, { entity: m.entityId });
  }

  // Runs one HA action (after the in-card confirmation when it asks for one).
  _runAction(action, ctx) {
    const call = actionCall(action, { entity: ctx.entity || null, userId: (this._hass && this._hass.user && this._hass.user.id) || null });
    if (call.kind === 'none') return;
    if (call.kind === 'error') { this._toast(call.message); return; }
    if (call.confirm) this._confirm(call.confirm, () => this._execCall(call, ctx));
    else this._execCall(call, ctx);
  }

  _execCall(call, ctx) {
    switch (call.kind) {
      case 'service':
        this._callService(call.domain, call.service, call.data, call.target);
        break;
      case 'more-info': this._moreInfo(call.entityId); break;
      case 'navigate': navigate(call.path, call.replace); break;
      case 'url':
        if (call.newTab) window.open(call.url, '_blank', 'noopener');
        else window.location.assign(call.url);
        break;
      case 'assist':
        // HA's frontend runs actions fired as hass-action (opens the Assist dialog)
        this.dispatchEvent(new CustomEvent('hass-action', { detail: { config: { tap_action: call.action }, action: 'tap' }, bubbles: true, composed: true }));
        break;
      case 'popup':
        if (ctx.objectId) this._openObjectPopup(ctx.objectId);
        else if (ctx.entity) this._moreInfo(ctx.entity);
        break;
      default:
    }
  }

  // hass.callService with a failure (rejected promise or a throw) shown as a toast, never unhandled.
  _callService(domain, service, data, target) {
    if (!this._hass) return;
    const fail = (err) => this._toast((err && err.message) || 'Action failed');
    try {
      const p = target ? this._hass.callService(domain, service, data, target) : this._hass.callService(domain, service, data);
      if (p && typeof p.catch === 'function') p.catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  // A short message at the bottom of the stage (e.g. an action missing a field).
  _toast(text) {
    if (!this._toastEl) return;
    this._toastEl.textContent = text;
    this._toastEl.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toastEl.hidden = true; }, 4000);
  }

  // In-card confirmation (never a browser dialog). OK runs ok(); Cancel, Esc or a new one drops it.
  _confirm(text, ok) {
    this._closeConfirm();
    const el = document.createElement('div');
    el.className = 'fp-confirm';
    el.setAttribute('role', 'dialog');
    el.innerHTML = '<div class="fp-confirm-text"></div><div class="fp-confirm-btns"><button data-c="no">Cancel</button><button data-c="yes" class="primary">OK</button></div>';
    el.querySelector('.fp-confirm-text').textContent = text;
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'contextmenu', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const c = e.target.dataset && e.target.dataset.c;
      if (!c) return;
      this._closeConfirm();
      if (c === 'yes') ok();
    });
    this._confirmKey = (e) => { if (e.key === 'Escape') this._closeConfirm(); };
    window.addEventListener('keydown', this._confirmKey);
    this._confirmEl = el;
    this._stage.append(el);
    el.querySelector('[data-c=yes]').focus();
  }

  _closeConfirm() {
    if (!this._confirmEl) return;
    window.removeEventListener('keydown', this._confirmKey);
    this._confirmEl.remove();
    this._confirmEl = null;
  }

  _buildMarkers() {
    const h = this._hass;
    // a device bound to a model object has no marker: the object is the control (glow sprite too).
    // With group_by: device the marker stands for the device's primary entity, so a bound primary
    // light hides the whole device marker (its other entities, e.g. a power sensor, included).
    const bound = this._boundEntities;
    this._markers = buildMarkers(h, this._layout, { group_by: this._config.group_by }).filter((m) => !bound.has(m.entityId));
    this._positions = markerPositions(this._markers, { ...this._layout, rooms: this._allRooms() }, h, this._floors, (pin, fid) => this._attachAt(pin, fid));
    if (this._surfacePass(false)) this._scheduleSurfaces(); // cached surface spots now, new ones after this update

    // the mower's device marker follows the live position instead of being auto placed
    const cfg = this._layout.mower;
    this._mowerMarkerId = null;
    this._view.mowerMarkerId = null;
    const mowerObject = !!(this._objects && this._objects.mowerBound());
    if (cfg && cfg.entity) {
      const reg = h.entities && h.entities[cfg.entity];
      const devId = reg && reg.device_id;
      let mm = this._markers.find((m) => (devId ? m.deviceId === devId : m.entityId === cfg.entity));
      if (mowerObject) {
        // the mower model replaces the mower marker
        if (mm) { this._markers = this._markers.filter((m) => m !== mm); this._positions.delete(mm.id); }
        mm = null;
      } else if (!mm) {
        const st = h.states[cfg.entity];
        mm = { id: 'mower:' + cfg.entity, entityId: cfg.entity, domain: cfg.entity.split('.')[0],
          name: (st && st.attributes.friendly_name) || cfg.entity, entities: [], secondaryId: null };
        this._markers.push(mm);
      }
      if (mm) {
        this._mowerMarkerId = mm.id;
        this._view.mowerMarkerId = mm.id;
        const live = this._mowerLive;
        if (live && live.floorId) this._positions.set(mm.id, { x: live.x, y: live.y, z: this._mowerZ(live.x, live.y, live.floorId), floorId: live.floorId, auto: false, live: true });
        else this._positions.delete(mm.id);
      }
    }

    this._markerEls.clear();
    const list = [];
    for (const m of this._markers) {
      const p = this._positions.get(m.id);
      if (!p) continue;
      const element = this._markerElement(m);
      this._markerEls.set(m.id, element);
      list.push({ id: m.id, element, ...p });
    }
    this._view.setMarkers(list);
    this._applyMarkerStates();
  }

  // ---------- auto-placed markers on the model's surfaces ----------
  // Placement inputs of the model surfaces: id, merge state, alignment, floor elevations ('' = no model).
  _surfaceModelKey() {
    const v = this._view, m = v && v.model;
    if (!m || !this._floors) return '';
    const g = v.modelGroup, r = (x) => Math.round(x * 1000) / 1000;
    return [m.id, v.mergeStats ? v.mergeStats.merged : '-', g.position.toArray().map(r).join(), r(g.rotation.y), r(g.scale.x),
      this._floors.map((f) => f.id + ':' + r(v.floorElevation(f.id))).join()].join('|');
  }

  // Auto-placed markers (never pins) move onto the nearest model surface of their type: walls for
  // wall / corner / door devices, the ceiling for the ceiling grid, the floor for floor-standing ones.
  // Results are cached per model placement and computed point; compute = false only applies cached
  // ones (the rebuild path), compute = true works through the rest in a ~10 ms slice and moves the
  // markers. Returns true when points are still waiting.
  _surfacePass(compute) {
    const pos = this._positions, vw = this._view;
    if (!pos || !this._markers || !vw) return false;
    const key = this._surfaceModelKey();
    if (key && (!this._surf || this._surf.key !== key)) this._surf = { key, map: new Map() };
    const t0 = performance.now();
    let rooms = null, pending = false, moved = false;
    for (const m of this._markers) {
      const p = pos.get(m.id);
      if (!p || !p.auto) continue;
      const base = p.base || p;
      const kind = key ? surfaceKind(m.domain, m.deviceClass) : null;
      let target = base;
      if (kind) {
        if (!rooms) rooms = this._allRooms();
        const room = rooms.find((r) => r.area_id === m.areaId);
        const k = surfaceKey(kind, p.floorId, base, room ? room.id : '');
        let s = this._surf.map.get(k);
        if (s === undefined) {
          if (!compute || performance.now() - t0 > 10) { pending = true; continue; }
          const elev = vw.floorElevation(p.floorId);
          const floor = this._floors.find((f) => f.id === p.floorId);
          // ceiling / floor rays stay on the device's floor (never the floor above, never through a stair opening)
          const hits = surfaceSearch(kind, base.z, floor && floor.height)
            .flatMap((g) => vw.surfaceRays(worldOf({ ...base, z: g.from }, elev), g.dirs, g.max));
          // stay with the room: an open plan must not send a device to a wall across the house
          const accept = kind === 'wall' && room ? (w) => nearPolygon([w[0], -w[2]], room.polygon, 0.5) : null;
          const c = chooseSurface(kind, hits, { accept });
          s = c ? planOf(c.point, elev) : null;
          this._surf.map.set(k, s);
        }
        if (s) target = s;
      }
      if (target.x === p.x && target.y === p.y && target.z === p.z) continue;
      const next = { ...p, x: target.x, y: target.y, z: target.z };
      if (target === base) delete next.base;
      else next.base = { x: base.x, y: base.y, z: base.z };
      pos.set(m.id, next);
      if (compute) vw.moveMarker(m.id, next.x, next.y, next.z, next.floorId);
      moved = true;
    }
    if (compute && moved) this._refreshStates(); // light glows follow
    return pending;
  }

  // Compute surface spots after the current update (model loaded, merged, realigned, markers rebuilt).
  _scheduleSurfaces() {
    if (this._surfJob) return;
    this._surfJob = setTimeout(() => {
      this._surfJob = null;
      if (!this.isConnected || !this._view) return;
      if (this._surfacePass(true)) this._scheduleSurfaces();
    }, 0);
  }

  // Plan position of a marker attached to a model object (its anchor + offset), null when the object is not there.
  _attachAt(pin, floorId) {
    const a = this._objects && this._objects.anchorOf(pin.attach);
    return a ? attachedPosition(a, pin.offset, this._view.floorElevation(floorId)) : null;
  }

  // Attached markers follow their object (mower pose, model placement): move the ones that moved.
  _refreshAttached() {
    const pins = (this._layout && this._layout.pins) || {};
    if (!this._positions || !this._view) return;
    for (const [id, pos] of this._positions) {
      const pin = pins[id];
      if (!pin || !pin.attach) continue;
      const at = this._attachAt(pin, pos.floorId);
      if (!at) {
        if (!pos.attached) continue;
        // the object vanished: back to the pin's stored (fallback) position
        const z = pin.z ?? 1.2;
        this._positions.set(id, { x: pin.x, y: pin.y, z, floorId: pos.floorId, auto: false });
        this._view.moveMarker(id, pin.x, pin.y, z, pos.floorId);
        continue;
      }
      if (pos.attached && Math.abs(at.x - pos.x) < 1e-6 && Math.abs(at.y - pos.y) < 1e-6 && Math.abs(at.z - pos.z) < 1e-6) continue;
      this._positions.set(id, { ...pos, x: at.x, y: at.y, z: at.z, attached: pin.attach });
      this._view.moveMarker(id, at.x, at.y, at.z, pos.floorId);
    }
  }

  _markerElement(m) {
    const el = document.createElement('div');
    el.className = 'fp-marker ' + m.domain;
    el.innerHTML = '<div class="fp-dot"><ha-icon></ha-icon></div><div class="fp-val"></div>';
    el.title = m.name;
    let start = null, timer = null, long = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      if (this._editing) {
        this._edit.markerDown(m, e);
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();
      start = [e.clientX, e.clientY];
      long = false;
      timer = setTimeout(() => { long = true; this._runMarkerAction(m, 'hold'); }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) >= CLICK_SLOP_PX) cancel();
    });
    el.addEventListener('pointerup', (e) => {
      const wasClick = start && !long && timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) < CLICK_SLOP_PX;
      cancel();
      start = null;
      if (wasClick) this._taps.tap(`marker:${m.id}`, !!this._markerActions(m).double_tap, () => this._runMarkerAction(m, 'tap'), () => this._runMarkerAction(m, 'double_tap'));
    });
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  _refreshStates() {
    const h = this._hass;
    const glows = [];
    for (const m of this._markers) {
      const el = this._markerEls.get(m.id);
      if (!el) continue;
      const st = h.states[m.entityId];
      el.classList.toggle('active', isActive(st));
      el.classList.toggle('unavailable', !st || st.state === 'unavailable');
      const icon = el.querySelector('ha-icon');
      const ic = m.id === this._mowerMarkerId ? 'mdi:robot-mower' : iconFor(h, m.entityId);
      if (icon.getAttribute('icon') !== ic) icon.setAttribute('icon', ic);
      const own = displayValue(h, m.entityId);
      el.querySelector('.fp-val').textContent = own || (m.secondaryId ? displayValue(h, m.secondaryId) : '');
      const name = st && st.attributes.friendly_name;
      el.title = m.name + (name && name !== m.name ? ' – ' + name : '');

      if (m.domain === 'light') {
        const g = lightGlow(st);
        el.style.setProperty('--fp-light', g && st.attributes.rgb_color ? `rgb(${g.rgb.join(',')})` : '');
        const p = this._positions.get(m.id);
        if (g && p) glows.push({ id: m.id, x: p.x, y: p.y, floorId: p.floorId, ...g });
      }
    }
    this._view.setGlows(glows);
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  // One HA floor (edit mode): the view linked to just that floor, else that floor on its own
  // with the model's level rules. Frames the floor.
  _setFloor(id) {
    const vis = this._views.filter((v) => !v.hidden);
    // a storey view linked to just that floor wins over an overview (Exterior) linked to it
    const only = (v) => { const f = this._stateFor(v).floors; return f.length === 1 && f[0] === id; };
    const match = id === 'all' ? vis.find((v) => v.id === 'all')
      : vis.find((v) => only(v) && !this._stateFor(v).overview) || vis.find(only);
    if (match) {
      this._setView(match.id);
      if (this._view.model && !match.camera) this._view.fit();
      return;
    }
    if (this._section) this._dropSection();
    this._floorOnly = id;
    this._floor = id;
    this._view.setVisibleFloor(id);
    this._view.applyModelVisibility(null, null);
    this._view.setCut(undefined);
    this._view.setMarkerStates(null);
    this._view.fit();
    this._syncToolbar();
  }

  _setMode(mode) {
    this._popup.close();
    if (mode !== '3d' && this._section) this.setSection(false, { camera: false });
    this._mode = mode;
    this._view.setMode(mode);
    const v = this.currentView(), own = v && !this._floorOnly ? v : null;
    if (mode === 'top' && own && own.camera_top) this._view.setTopCamera(this.viewTopCamera(own), { instant: true });
    // back in 3D: the view's saved camera, else the camera before Top (setMode framed it otherwise)
    else if (mode === '3d') {
      const cam = (own && own.camera && this.viewCamera(own)) || this._view.lastCamera3d;
      if (cam) this._view.setCamera(cam, { instant: true });
    }
    this._syncToolbar();
    if (this._editing && this._edit.tab === 'views') this._edit.render();
  }

  _paintDayBtn() {
    const icon = { auto: 'mdi:theme-light-dark', day: 'mdi:white-balance-sunny', night: 'mdi:weather-night' }[this._skyMode];
    const el = this._dayBtn.querySelector('ha-icon');
    if (el && el.getAttribute('icon') !== icon) el.setAttribute('icon', icon);
    this._dayBtn.title = `Day / night: ${this._skyMode}`;
  }

  // Auto reads sun.sun; setSky only when night moved > 0.01 or the sun > 1 degree since the last call.
  // Sun / moon sprites: with the sun change, else the moon at most every 60 s (option sky_bodies).
  _applySky(force) {
    const v = this._view;
    if (!v || !v.model) return;
    const north = v.model.north || 0, rot = this._modelAlign().rotation || 0;
    let sky = { night: 0, sunDir: null }, sunBody = null, auto = false;
    if (this._skyMode === 'night') sky = { night: 1, sunDir: null };
    else if (this._skyMode === 'day') sunBody = { dir: sunVector(...DAY_SUN, north, rot) };
    else {
      auto = true;
      const a = this._hass && this._hass.states && this._hass.states['sun.sun'];
      const el = a ? Number(a.attributes.elevation) : NaN, az = a ? Number(a.attributes.azimuth) : NaN;
      if (Number.isFinite(el) && Number.isFinite(az)) {
        const dir = sunVector(az, el, north, rot);
        sky = { night: nightFactor(el), sunDir: clampSunDir(dir), sun: sunStrength(el) };
        sunBody = { dir };
      }
    }
    const l = this._skyLast;
    const same = !force && l && Math.abs(l.night - sky.night) <= 0.01 && Math.abs((l.sun ?? 1) - (sky.sun ?? 1)) <= 0.01 && !!l.sunDir === !!sky.sunDir
      && (!sky.sunDir || Math.acos(Math.max(-1, Math.min(1, l.sunDir[0] * sky.sunDir[0] + l.sunDir[1] * sky.sunDir[1] + l.sunDir[2] * sky.sunDir[2]))) <= Math.PI / 180);
    const now = this._now();
    if (same && !(auto && now - (this._moonAt ?? -Infinity) >= MOON_EVERY_MS)) return;
    if (!same) {
      this._skyLast = sky;
      this._daylight = sky.night < 0.5;
      v.setSky(sky);
    }
    let moonBody = null;
    if (this._skyMode === 'night') moonBody = { dir: sunVector(...NIGHT_MOON, north, rot), phase: 0.4, illumination: 0.8 };
    else if (auto) {
      const c = this._hass && this._hass.config;
      const m = c ? moonPosition(now, Number(c.latitude), Number(c.longitude)) : null;
      if (m) moonBody = { dir: sunVector(m.azimuth, m.elevation, north, rot), phase: m.phase, illumination: m.illumination, latitude: Number(c.latitude) };
    }
    this._moonAt = now;
    v.setSkyBodies({ sun: sunBody, moon: moonBody, north: sunVector(0, 0, north, rot), on: this._config.sky_bodies !== false });
  }

  // Current time; tests set window.__demoNow (Date or ms).
  _now() {
    const t = typeof window !== 'undefined' ? window.__demoNow : undefined;
    if (t !== undefined && t !== null) return t instanceof Date ? t.getTime() : Number(t);
    return Date.now();
  }

  _syncToolbar() {
    const hasModel = !!(this._view && this._view.model);
    // without a model: one chip per floor plus All (not while editing), shown with 2+ floors
    const views = this._views.filter((v) => !v.hidden && (hasModel || !this._editing || v.id !== 'all'));
    const show = hasModel ? views.length > 1 : this._views.filter((v) => !v.hidden && v.id !== 'all').length > 1;
    this._chips.innerHTML = '';
    if (show) {
      for (const v of views) {
        const btn = document.createElement('button');
        btn.className = 'chip' + (v.id === this._viewId && !this._floorOnly ? ' on' : '');
        btn.dataset.view = v.id;
        btn.textContent = v.label;
        this._chips.append(btn);
      }
    }
    for (const btn of this.shadowRoot.querySelectorAll('.seg button')) btn.classList.toggle('on', btn.dataset.mode === this._mode);
    this._dayBtn.hidden = !(this._view && this._view.model);
    if (this._section && (!this._mb || !this._index || !hasModel)) this._dropSection();
    if (this._sectionBtn) {
      this._sectionBtn.hidden = !(this._view && this._view.model && this._mode === '3d');
      this._sectionBtn.classList.toggle('on', !!this._section);
    }
    this._paintDayBtn();
    this._editBtn.hidden = !(this._hass && this._hass.user && this._hass.user.is_admin);
    this._editBtn.querySelector('span').textContent = this._editing ? 'Done' : 'Edit';
    if (this._empty && this._editing) this._empty.hidden = true;
  }
}

if (!customElements.get('floorplan3d-card')) {
  customElements.define('floorplan3d-card', Floorplan3dCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'floorplan3d-card',
    name: 'Floorplan 3D',
    description: '3D floorplan with automatically placed devices',
    preview: false,
  });
  console.info(`%c floorplan3d-card ${VERSION} `, 'background:#03a9f4;color:#fff;border-radius:3px');
}
