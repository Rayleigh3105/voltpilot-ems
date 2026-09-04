/**
 * Browser-Beweis fuer Bewegungs-Programm P0 (jsdom sieht keine `@property`).
 *
 * Er misst dreierlei am LAUFENDEN Portal, je einmal normal und einmal mit
 * emulierter reduzierter Bewegung:
 *   (a) die Familie loest auf (`--vp-motion-chart` == "0.4s", kein `calc(...)`)
 *   (b) der EINE Schalter nullt alles, und die benannten Loops stehen
 *   (c) Portfolio + Cockpit bei ECHTEN 375 und 1440 ohne Ueberlauf
 *
 * Aufruf (Dev-Server auf 5173):  node e2e/motion-p0/proof.mjs [--shots DIR]
 */
import { chromium, webkit } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.VP_BASE || 'http://127.0.0.1:5173/';
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > -1 ? process.argv[shotsIdx + 1] : null;
const ENGINE = process.argv.includes('--webkit') ? webkit : chromium;
const NAME = process.argv.includes('--webkit') ? 'WebKit' : 'Chromium';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TOKENS = [
  '--vp-motion-scale', '--vp-motion-fast', '--vp-motion-base', '--vp-motion-enter',
  '--vp-motion-exit', '--vp-motion-page', '--vp-motion-chart', '--vp-motion-chart-update',
  '--vp-motion-stagger', '--vp-motion-distance', '--vp-c-motion',
];
/** Die benannten Loops, die der EINE Block anhalten muss. */
const LOOPS = ['.vp-flow-on', '.vp-flow-rev', '.vp-boot-spinner', '.vp-spinner',
  '.vp-auth-flow .spoke', '.vp-flowport.accepts', '.vp-ustate-busy .vp-ustate-dot',
  '.vp-fleet-dot', '.vp-skeleton'];

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.fill('#username', 'demo');
    await page.fill('#password', 'demo');
    await page.click('#kc-login');
    await page.waitForURL((u) => u.host === '127.0.0.1:5173', { timeout: 25000 });
  } catch {
    /* schon angemeldet */
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Wo sind wir gelandet, und was steht auf der Fläche? */
async function lage(page) {
  return page.evaluate(() => ({
    hash: location.hash || '(leer)',
    titel: document.querySelector('h1, h2')?.textContent?.trim().slice(0, 60) ?? null,
    karten: document.querySelectorAll('.vp-card, .vp-ck-block').length,
    charts: document.querySelectorAll('.vp-chart, canvas').length,
  }));
}

async function tokenLesen(page, tokens) {
  return page.evaluate((ts) => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const t of ts) out[t] = cs.getPropertyValue(t).trim();
    return out;
  }, tokens);
}

async function loopsLesen(page, sel) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).animationName : null;
    }
    return out;
  }, sel);
}

async function ueberlauf(page) {
  return page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const ueber = [...document.querySelectorAll('*')]
      .filter((e) => e.getBoundingClientRect().right > cw + 1)
      .slice(0, 5)
      .map((e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().slice(0, 40)}`);
    return { clientWidth: cw, scrollWidth: document.documentElement.scrollWidth, ueber };
  });
}

const ERG = { engine: NAME, normal: {}, reduziert: {}, layout: [] };

const browser = await ENGINE.launch();

// --- (a) normal -----------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await page.goto(`${BASE}#/anlage/00000000-0000-0000-0000-000000000012`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  ERG.normal.lage = await lage(page);
  ERG.normal.tokens = await tokenLesen(page, TOKENS);
  ERG.normal.loops = await loopsLesen(page, LOOPS);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1440-normal.png`, fullPage: false });
  await ctx.close();
}

// --- (b) reduziert --------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await login(page);
  await page.goto(`${BASE}#/anlage/00000000-0000-0000-0000-000000000012`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  ERG.reduziert.lage = await lage(page);
  ERG.reduziert.tokens = await tokenLesen(page, TOKENS);
  ERG.reduziert.loops = await loopsLesen(page, LOOPS);
  await ctx.close();
}

// --- (c) Layout bei 375 und 1440 -----------------------------------------
for (const w of [375, 1440]) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: w === 375 ? 812 : 900 },
    deviceScaleFactor: w === 375 ? 3 : 1,
    isMobile: w === 375,
    hasTouch: w === 375,
  });
  const page = await ctx.newPage();
  await login(page);
  await page.goto(`${BASE}#/anlage/00000000-0000-0000-0000-000000000012`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const o = await ueberlauf(page);
  ERG.layout.push({ breite: w, seite: 'cockpit', ...o, lage: await lage(page) });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}-cockpit.png` });
  await page.goto(`${BASE}#/portfolio`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const o2 = await ueberlauf(page);
  ERG.layout.push({ breite: w, seite: 'portfolio', ...o2, lage: await lage(page) });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}-nachher.png`, fullPage: false });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(ERG, null, 1));
