// Badge DOM shared by markers and the object popup: logo (lazy <img>), status dot, battery chip.
import { brandUrl } from './badges.js';

// platforms whose icon.png failed: never requested again (no broken image, no repeated 404s)
const failed = new Set();
const darkFailed = new Set();


function setLogo(box, platform, dark) {
  let img = box.querySelector('img.fp-logo');
  if (!platform || failed.has(platform)) { if (img) img.remove(); return; }
  const useDark = dark && !darkFailed.has(platform);
  const src = brandUrl(platform, useDark);
  if (!img) {
    img = document.createElement('img');
    img.className = 'fp-logo';
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      const p = img.dataset.platform;
      if (img.dataset.dark === '1') { darkFailed.add(p); img.dataset.dark = '0'; img.src = brandUrl(p, false); return; }
      failed.add(p);
      img.remove();
    });
    box.prepend(img);
  }
  if (img.dataset.platform === platform && img.dataset.dark === (useDark ? '1' : '0')) return;
  img.dataset.platform = platform;
  img.dataset.dark = useDark ? '1' : '0';
  img.title = platform;
  img.src = src;
}

function setPart(box, cls, show, text) {
  let el = box.querySelector('.' + cls);
  if (!show) { if (el) el.remove(); return null; }
  if (!el) { el = document.createElement('span'); el.className = cls; box.append(el); }
  if (text !== undefined && el.textContent !== text) el.textContent = text;
  return el;
}

const STATUS_TITLE = { green: 'On / has a value', grey: 'Off / idle', red: 'Unavailable', yellow: 'Low battery or a problem' };

// info: badgeInfo() result; host gets its badges (created on first use). Skips work when nothing changed.
export function applyBadges(host, info, dark) {
  const sig = info ? `${info.sig}|${dark ? 1 : 0}` : '';
  if (host._fpBadgeSig === sig) return;
  host._fpBadgeSig = sig;
  setLogo(host, info && info.platform, dark);
  const dot = setPart(host, 'fp-status', !!(info && info.status));
  if (dot) { dot.dataset.status = info.status; dot.title = STATUS_TITLE[info.status] || ''; }
  setPart(host, 'fp-batt', !!(info && info.battery !== null && info.battery !== undefined), info && info.battery !== null ? `${info.battery} %` : '');
}

export function resetBrandFailures() { failed.clear(); darkFailed.clear(); }
