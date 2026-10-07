// Section runner for the long headless checks: one browser and one demo page per process; every
// section gets a fresh demo by an in-page reset (window.__demoReset) instead of a page load.
//   --shard k/n   run every n-th section group, starting at the k-th
//   --only a,b    run these section groups only
//   --jobs N      (parent run) shards run in parallel as child processes, N at a time (default 3)
import { spawn } from 'node:child_process';
import { launch, newPage, demoUrl, waitForDemo } from './demo-browser.mjs';

export function parseArgs(argv) {
  const out = { shard: null, only: null, jobs: 3, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a.startsWith('--shard')) {
      const m = /^(\d+)\/(\d+)$/.exec(val() || '');
      if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error('--shard k/n expected');
      out.shard = [+m[1], +m[2]];
    } else if (a.startsWith('--only')) out.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--jobs')) out.jobs = Math.max(1, Number(val()) || 1);
    else if (a === '--list') out.list = true;
  }
  return out;
}

// Groups (in declaration order) this process runs.
export function selectGroups(groups, { shard, only }) {
  if (only) {
    const unknown = only.filter((n) => !groups.some((g) => g.name === n));
    if (unknown.length) throw new Error(`unknown section group(s): ${unknown.join(', ')} (known: ${groups.map((g) => g.name).join(', ')})`);
    return groups.filter((g) => only.includes(g.name));
  }
  if (shard) return groups.filter((g, i) => i % shard[1] === shard[0] - 1);
  return groups;
}

export class Sections {
  constructor() {
    this.groups = [];
  }

  // name: section name; group: section group name (shard / --only unit); query, viewport: the demo for
  // it (query null: no demo, a blank page for the section's own use).
  // before: sync setup run before the demo is (re)loaded for it.
  add(name, { group, query = {}, viewport = { width: 1400, height: 560 }, before = null }, fn) {
    let g = this.groups.find((x) => x.name === group);
    if (!g) this.groups.push((g = { name: group, sections: [] }));
    g.sections.push({ name, query, viewport, before, fn });
  }

  // Group order (round-robin shards take every n-th): balances the shards by their run times.
  order(names) {
    const rank = (g) => { const i = names.indexOf(g.name); return i < 0 ? names.length : i; };
    this.groups.sort((a, b) => rank(a) - rank(b));
  }

  // Parent run (no --shard / --only, jobs > 1): the shards as child processes. -> exit code
  async runShards(script, jobs) {
    const n = Math.min(jobs, this.groups.length);
    const t0 = Date.now();
    const runOne = (k) => new Promise((resolve) => {
      const child = spawn(process.execPath, [script, '--shard', `${k}/${n}`], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      // lines streamed as they come, prefixed with the shard
      const pipe = (stream) => {
        let rest = '';
        stream.on('data', (d) => {
          const lines = (rest + d).split('\n');
          rest = lines.pop();
          for (const l of lines) console.log(`[${k}/${n}] ${l}`);
        });
        stream.on('end', () => { if (rest) console.log(`[${k}/${n}] ${rest}`); });
      };
      pipe(child.stdout);
      pipe(child.stderr);
      child.on('close', (code) => {
        console.log(`[${k}/${n}] shard exit ${code}`);
        resolve(code);
      });
    });
    const codes = await Promise.all(Array.from({ length: n }, (_, i) => runOne(i + 1)));
    console.log(`all shards done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return codes.some((c) => c !== 0) ? 1 : 0;
  }

  // Runs the selected groups' sections in this process. section fn(s): s = { page, errors, browser, base }.
  async run(groups, { onError }) {
    const t0 = Date.now();
    const { browser, base, close } = await launch();
    let demo = null; // { page, errors } of the demo page, loaded once
    try {
      for (const g of groups) {
        const tg = Date.now();
        for (const sec of g.sections) {
          const ts = Date.now();
          try {
            if (sec.before) sec.before();
            if (sec.query === null) {
              await sec.fn({ browser, base });
            } else {
              if (!demo) {
                demo = await newPage(browser, sec.viewport);
                await demo.page.goto(demoUrl(base, sec.query), { waitUntil: 'load', timeout: 120000 });
              } else {
                await demo.page.setViewport({ deviceScaleFactor: 1, ...sec.viewport });
                await demo.page.evaluate((q) => window.__demoReset(q), { test: '1', ...sec.query });
              }
              await waitForDemo(demo.page);
              demo.errors.length = 0; // errors of an earlier section's leftovers are not this one's
              await sec.fn({ page: demo.page, errors: demo.errors, browser, base });
            }
          } catch (e) {
            onError(`${g.name}/${sec.name}`, e);
            // a broken page is not reused
            if (demo) { await demo.page.close().catch(() => {}); demo = null; }
          }
          console.log(`  [${g.name}/${sec.name}] ${((Date.now() - ts) / 1000).toFixed(1)} s`);
        }
        console.log(`[group ${g.name}] ${((Date.now() - tg) / 1000).toFixed(1)} s`);
      }
    } finally {
      await close();
    }
    console.log(`sections done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
