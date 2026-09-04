// HARNESS · Bewegung P1 (`data/vp-motion-konzept-m1`, Paket P1).
//
// Playwright-Rig gegen den laufenden Dev-Server. jsdom sieht weder Maske noch
// Frames, deshalb ist DIES der Beweis, dass der Einstieg ehrlich ist: es haelt
// die Aufdeck-Animation an definierten Zeitpunkten AN und fotografiert sie.
// Ausgewertet wird mit `analyze-frames.py` daneben — jede aufgedeckte Spalte
// muss schon ihre ENDGUELTIGE Hoehe haben.
//
// Es ist reines Werkzeug: nichts davon laeuft in Produktion, und der Portal-Code
// traegt keinen Haken dafuer.
//   node e2e/motion-lab/shoot.mjs --vw 375 --out DIR --pages name=hash,... [--cpu 4]
//   node e2e/motion-lab/shoot.mjs --vw 1440 --out DIR --frames name=hash --sel .vp-chart --times 0,80,160,240,320,400
//   node e2e/motion-lab/shoot.mjs --url file.html --out DIR --name x --vw 375 [--frames-css sel --times ...]
import { chromium } from 'playwright';
import fs from 'node:fs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
// ⚠ NIE auf 5173 festnageln: laeuft eine zweite Spur, antwortet dort DEREN
// Portal, und der Beweis waere ueber fremden Code gefuehrt. `--port` (bzw.
// VP_PORT) zeigt auf den Dev-Server DIESES Arbeitsbaums.
const PORT = arg('port', process.env.VP_PORT || '5173');
const APP = `http://localhost:${PORT}`;
const has = (k) => process.argv.includes('--' + k);
const vw = Number(arg('vw', '1440')); const out = arg('out', '.'); fs.mkdirSync(out, { recursive: true });
const cpu = Number(arg('cpu', '1'));
const browser = await chromium.launch({ headless: true });
// `--reduced` schaltet `prefers-reduced-motion: reduce` — der EINE Schalter.
const reduced = has('reduced') ? { reducedMotion: 'reduce' } : {};
const ctx = await browser.newContext(vw <= 500
  ? { viewport: { width: vw, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...reduced }
  : { viewport: { width: vw, height: 900 }, deviceScaleFactor: 1, ...reduced });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
async function login() {
  await page.goto(`${APP}/`);
  await page.waitForTimeout(3000);
  const btn = page.getByRole('button', { name: 'Anmelden' });
  if (await btn.count()) await btn.first().click();
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', 'demo'); await page.fill('#password', 'demo');
  await page.click('#kc-login');
  await page.waitForFunction(() => location.hash.startsWith('#/'), null, { timeout: 20000 });
  await page.waitForTimeout(2000);
}
const base = arg('url', null);
if (!base) await login();
const wait = Number(arg('wait', '6000'));
if (has('pages')) {
  for (const pair of arg('pages').split(',')) {
    const [name, hash] = pair.split('=');
    await page.goto(`${APP}/#/${hash}`); await page.waitForTimeout(wait);
    await page.screenshot({ path: `${out}/${name}-${vw}.png` });
    if (has('full')) await page.screenshot({ path: `${out}/${name}-${vw}-full.png`, fullPage: true });
    console.log('shot', name, vw, await page.evaluate(() => document.documentElement.clientWidth));
  }
}
if (has('frames') || has('frames-css')) {
  const sel = arg('sel', '.vp-chart'); const times = arg('times', '0,100,200,300,400').split(',').map(Number);
  let name = arg('name', 'frames');
  if (has('frames')) { const [n, hash] = arg('frames').split('='); name = n; await page.goto(`${APP}/#/${hash}`); }
  else await page.goto(base);
  await page.waitForTimeout(wait);
  const idx = Number(arg('idx', '0'));
  const loc = page.locator(sel).nth(idx);
  await loc.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
  // Das ENDBILD zuerst: `analyze-frames.py` misst jede aufgedeckte Spalte
  // gegen genau dieses, nicht gegen den letzten (schon fast fertigen) Frame.
  await loc.screenshot({ path: `${out}/${name}-tFINAL.png` });
  // Reveal frames: re-trigger the entry animation and pause at t.
  for (const t of times) {
    await loc.evaluate((el, t) => { el.getAnimations().forEach((a) => a.cancel()); el.classList.remove('is-entering'); void el.offsetWidth; el.classList.add('is-entering'); const a = el.getAnimations()[0]; if (a) { a.pause(); a.currentTime = t; } }, t);
    await page.waitForTimeout(80);
    await (has('shot-page') ? page : loc).screenshot({ path: `${out}/${name}-t${String(t).padStart(4, '0')}.png` });
  }
  await loc.evaluate((el) => { el.getAnimations().forEach((a) => a.cancel()); el.classList.remove('is-entering'); });
  // ⚠ ZWEITES Endbild NACH den Frames. Die Flaechen holen im Betrieb nach
  // (Fahrplan/Marktpreise pollen), und aendern sich die Daten zwischen Endbild
  // und Frames, misst der Vergleich diese AENDERUNG statt des Einstiegs - genau
  // so ist einmal eine einzelne Spalte als "waechst aus der Null" erschienen,
  // die im naechsten Lauf verschwand. Stimmen die zwei Endbilder nicht ueberein,
  // ist der Lauf KEIN gueltiger Messwert und `analyze-frames.py` sagt das.
  await loc.screenshot({ path: `${out}/${name}-zFINAL2.png` });
  console.log('frames', name, times.join(','));
}
if (has('run')) {
  // Arbitrary in-page script (file) returning JSON → stdout.
  const code = fs.readFileSync(arg('run'), 'utf8');
  if (has('goto')) { await page.goto(arg('goto')); await page.waitForTimeout(wait); }
  const fn = new Function('return (' + code + ')')();
  const r = await page.evaluate(fn);
  console.log(JSON.stringify(r));
}
await browser.close();
