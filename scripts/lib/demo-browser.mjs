// Shared by the headless checks: a static server for the repo and a Chrome page on the demo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

export const root = path.resolve(import.meta.dirname, '../..');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png' };

function findChrome() {
  const chrome = process.env.CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found, set CHROME_PATH');
  return chrome;
}

// Static server + headless Chrome. Returns { browser, base, close }.
export async function launch() {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    // validators like a real static server (the card's model cache versions URL models by them)
    const st = fs.statSync(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': st.size,
      etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, 'last-modified': st.mtime.toUTCString() });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }).listen(0);
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const close = async () => { await browser.close(); server.closeAllConnections(); server.close(); }; // no keep-alive socket holds the process
  return { browser, base: `http://localhost:${server.address().port}`, close };
}

// A page that records errors and console warnings (GPU driver chatter excluded).
export async function newPage(browser, viewport = { width: 1400, height: 560 }) {
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (['error', 'warn', 'warning'].includes(m.type()) && !m.location().url?.endsWith('favicon.ico') && !m.location().url?.startsWith('https://brands.home-assistant.io/') && !m.text().includes('GL Driver Message')) errors.push(m.type() + ': ' + m.text());
  });
  await page.setViewport({ deviceScaleFactor: 1, ...viewport });
  return { page, errors };
}

// Integration logos without the network: brands.home-assistant.io answered with a test badge (an SVG
// with the platform's initial); platform "nobrand" 404s (badge hidden), shelly has no dark_icon (fallback).
export const brandRequests = [];
const BRAND_COLORS = { hue: '#1e88e5', shelly: '#00897b', zwave_js: '#6d4c41', zha: '#8e24aa', cast: '#e53935', tado: '#fb8c00', sunseeker: '#43a047' };
export async function interceptBrands(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const m = /^https:\/\/brands\.home-assistant\.io\/_\/([^/]+)\/(icon|dark_icon)\.png/.exec(req.url());
    if (!m) { req.continue(); return; }
    const [, platform, kind] = m;
    brandRequests.push(`${platform}/${kind}`);
    if (platform === 'nobrand' || (platform === 'shelly' && kind === 'dark_icon')) { req.respond({ status: 404, contentType: 'text/plain', body: 'not found' }); return; }
    const fill = BRAND_COLORS[platform] || '#757575', fg = kind === 'dark_icon' ? '#111' : '#fff';
    req.respond({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' },
      body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${fill}"/><text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="${fg}">${platform[0].toUpperCase()}</text></svg>` });
  });
}

// demo/index.html?query; test mode (?test=1, cheaper rendering) unless test is false.
export function demoUrl(base, query = {}, { test = true } = {}) {
  const q = new URLSearchParams(Object.entries({ ...(test ? { test: '1' } : {}), ...query }).filter(([, v]) => v !== undefined));
  return `${base}/demo/index.html?${q}`;
}

// Markers on the first card and two rendered frames after that.
export async function waitForDemo(page) {
  await page.waitForFunction(() => {
    const c = document.querySelector('floorplan3d-card');
    return c && c.shadowRoot && c.shadowRoot.querySelectorAll('.fp-marker').length > 0 && c._view && c._view.stats.frames > 0;
  }, { timeout: 30000 }); // a loaded machine can take > 10 s for the first frame
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Opens the demo and waits for markers. Returns { page, errors, close, browser, base }.
// opts.brands: answer integration logo requests locally (interceptBrands); opts.test: false = real look.
export async function openDemo(query = {}, viewport = { width: 1400, height: 560 }, opts = {}) {
  const { browser, base, close } = await launch();
  try {
    const { page, errors } = await newPage(browser, viewport);
    if (opts.brands) await interceptBrands(page);
    await page.goto(demoUrl(base, query, { test: opts.test !== false }), { waitUntil: 'load', timeout: 120000 });
    await waitForDemo(page);
    return { page, errors, close, browser, base };
  } catch (e) {
    await close();
    throw e;
  }
}
