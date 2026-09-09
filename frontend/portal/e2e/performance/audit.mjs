// Local browser audit against a production build and the real demo API.
// No data writes: authentication and GET requests only. Timings are lab data.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve(process.env.VP_PERF_OUT ?? '/tmp/vp-portal-performance');
const roots = process.env.VP_PERF_BASELINE
  ? [['before', process.env.VP_PERF_BASELINE], ['after', 'dist']]
  : [['current', 'dist']];
const base = 'http://localhost:5173';
const sites = [
  ['Demo Site Berlin', '00000000-0000-0000-0000-000000000002'],
  ['Hof Lindenberg', '00000000-0000-0000-0000-000000000022'],
];
const widths = (process.env.VP_PERF_WIDTHS ?? '1440,375').split(',').map(Number);
const repeat = Number(process.env.VP_PERF_RUNS ?? 3);
const rows = [];
await mkdir(out, { recursive: true });
if (await fetch(base).then(() => true, () => false)) {
  throw new Error('Port 5173 is occupied; stop your own preview before running the audit.');
}
const browser = await chromium.launch({ headless: true });
let server;
try {
  for (const [version, root] of roots) {
    server = spawn(process.execPath, ['e2e/motion-p4/serve-proof.mjs', '5173', resolve(root)], {
      stdio: 'ignore',
    });
    for (let n = 0; n < 100; n++) {
      if (await fetch(base).then(r => r.ok, () => false)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const grant = await context.request.post('http://localhost:8081/realms/voltpilot/protocol/openid-connect/token', {
        form: { client_id: 'voltpilot-frontend', scope: 'openid', grant_type: 'password',
          username: process.env.VP_PERF_USER ?? 'demo', password: process.env.VP_PERF_PASSWORD ?? 'demo' },
      });
      if (!grant.ok()) throw new Error(`Local demo authentication failed (${grant.status()})`);
      await context.addInitScript((tokens) => {
        if (location.origin !== 'http://localhost:5173') return;
        if (!sessionStorage.getItem('vp.auth.tokens')) sessionStorage.setItem('vp.auth.tokens', JSON.stringify(tokens));
        performance.setResourceTimingBufferSize(3000);
        window.__perf = { tasks: [], shifts: [], events: [], lcp: [], badgeDelay: 0 };
        for (const [type, key] of [['longtask', 'tasks'], ['layout-shift', 'shifts'], ['event', 'events'], ['largest-contentful-paint', 'lcp']]) {
          try { new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__perf[key].push(entry.toJSON());
          }).observe({ type, buffered: true, durationThreshold: 16 }); } catch {}
        }
        const original = window.fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (/\/(interventions|entity-strategies)(\?|$)/.test(String(args[0])) && window.__perf.badgeDelay) {
            await new Promise(r => setTimeout(r, window.__perf.badgeDelay));
          }
          return response;
        };
        document.addEventListener('click', () => {
          if (window.__perf.clickAt == null) window.__perf.clickAt = performance.now();
        }, true);
      }, await grant.json());
      const page = await context.newPage();
      const errors = [];
      let requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('requestfinished', request => {
        if (!request.url().includes('/api/v1/')) return;
        const timing = request.timing();
        requests.push({ path: new URL(request.url()).pathname, ms: Math.round(timing.responseEnd) });
      });
      const cdp = await context.newCDPSession(page);
      if (width === 375) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(`${base}/#/anlage/${sites[0][1]}`);
      await page.locator('.vp-cockpit-stack').waitFor();
      await page.waitForTimeout(500);

      const collect = async (label, start, readyMs = null) => {
        const data = await page.evaluate(since => ({
          overflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          charts: document.querySelectorAll('canvas').length,
          firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          largestContentfulPaintMs: window.__perf.lcp.at(-1)?.startTime ?? null,
          longTasks: window.__perf.tasks.filter(e => e.startTime >= since).map(e => Math.round(e.duration)),
          interactionDurations: window.__perf.events.filter(e => e.startTime >= since && e.interactionId).map(e => e.duration),
          layoutShift: window.__perf.shifts.filter(e => e.startTime >= since && !e.hadRecentInput).reduce((sum,e) => sum+e.value,0),
        }), start);
        const row = { version, width, cpu: width === 375 ? 4 : 1, label, readyMs,
          requests: [...requests], errors: [...errors], ...data };
        rows.push(row);
        console.log(JSON.stringify({ version, width, label, readyMs, requests: requests.length, errors: errors.length, ...data }));
        requests = []; errors.length = 0;
      };
      await collect('authenticated boot', 0);

      for (const delay of [0, 1500]) {
        await page.evaluate(ms => { window.__perf.badgeDelay = ms; }, delay);
        for (let i = 0; i < repeat; i++) {
          const current = await page.locator('main h1').first().innerText();
          const target = current === sites[0][0] ? sites[1][0] : sites[0][0];
          await page.getByRole('combobox', { name: 'Anlage wechseln' }).click();
          const option = page.getByRole('option').filter({ hasText: target });
          await option.waitFor();
          requests = [];
          const start = await page.evaluate(() => { window.__perf.clickAt = null; return performance.now(); });
          await option.click();
          await page.waitForFunction(name => document.querySelector('main h1')?.textContent === name
            && !document.querySelector('.vp-anlage-pending') && document.querySelector('.vp-cockpit-stack'), target);
          const ready = await page.evaluate(() => Math.round(performance.now() - window.__perf.clickAt));
          await page.waitForTimeout(Math.max(500, delay + 200));
          await collect(`site switch, badge delay ${delay}ms, run ${i+1}`, start, ready);
        }
      }
      await page.evaluate(() => { window.__perf.badgeDelay = 0; });
      if (process.env.VP_PERF_SWEEP === '0') {
        await context.close();
        continue;
      }
      for (const [label, sub] of [['Cockpit', ''], ['Schedule', '/fahrplan'], ['Measurements', '/messwerte'],
        ['Earnings', '/erloese'], ['Market prices', '/marktpreise'], ['Weather', '/wetter'],
        ['Forecast', '/prognose'], ['Control', '/steuerung'], ['Devices', '/modell'], ['Settings', '/technik']]) {
        requests = [];
        const start = await page.evaluate(hash => { location.hash = hash; return performance.now(); }, `/anlage/${sites[0][1]}${sub}`);
        await page.waitForTimeout(2200);
        await collect(label, start);
        await page.screenshot({ path: `${out}/${version}-${width}-${label.replaceAll(' ', '-')}.png`, fullPage: true });
      }
      await context.close();
    }
    await new Promise(resolveExit => { server.once('exit', resolveExit); server.kill(); });
    server = null;
  }
} finally {
  server?.kill();
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify({ measuredAt: new Date().toISOString(),
    scope: 'Local production builds; existing demo data; mobile CPU 4x; badge delay is synthetic; no network throttle', rows }, null, 2));
}
