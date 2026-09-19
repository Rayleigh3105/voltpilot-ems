import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

type Antwort = { status: number; contentType: string; body: string };
type Stand = { antworten: Record<string, Antwort> };
type Aufnahme = {
  stand: string;
  faelle: {
    u1: Stand;
    u2: { vorBestaetigung: Stand; nachBestaetigung?: Stand };
  };
};

const PHASE = process.env.BUEHNE_PHASE;
const QUELLE = process.env.BUEHNE_ANTWORTEN;
const BILDER = process.env.BUEHNE_BILDER;
if (PHASE !== 'vorher' && PHASE !== 'nachher') throw new Error('BUEHNE_PHASE muss vorher oder nachher sein');
if (!QUELLE || !BILDER) throw new Error('BUEHNE_ANTWORTEN und BUEHNE_BILDER sind Pflicht');
const aufnahme = JSON.parse(readFileSync(QUELLE, 'utf8')) as Aufnahme;
mkdirSync(BILDER, { recursive: true });

function passend(antworten: Record<string, Antwort>, methode: string, url: URL): Antwort | undefined {
  return antworten[`${methode} ${url.pathname}${url.search}`];
}

async function mitAntworten(page: Page, fall: 'u1' | 'u2') {
  let bestaetigt = false;
  const unbekannt = new Set<string>();
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const methode = request.method();
    const vor = fall === 'u1' ? aufnahme.faelle.u1 : aufnahme.faelle.u2.vorBestaetigung;
    const nach = fall === 'u2' ? aufnahme.faelle.u2.nachBestaetigung : undefined;
    const stand = bestaetigt && nach ? nach : vor;
    const antwort = passend(stand.antworten, methode, url) ?? passend(vor.antworten, methode, url);
    if (!antwort) {
      unbekannt.add(`${methode} ${url.pathname}${url.search}`);
      await route.fulfill({ status: 599, contentType: 'application/json', body: '{"message":"Antwort nicht aufgezeichnet"}' });
      return;
    }
    if (methode === 'POST' && url.pathname === '/api/v1/standorte/vorschlag/bestaetigen') bestaetigt = true;
    await route.fulfill({ status: antwort.status, contentType: antwort.contentType, body: antwort.body });
  });
  return unbekannt;
}

async function oeffnen(page: Page, fall: 'u1' | 'u2', breite: 375 | 1440) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto(`/e2e/buehne-vorher-nachher.html?fall=${fall}#/uebersicht`);
  // Zwei getrennte Portal-Builds starten ihre Endlos-Pulse zu leicht verschiedenen Zeitpunkten.
  // Die Bühne friert ausschließlich Bewegung ein, damit der Pixelvergleich Inhalt und Layout misst.
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await expect(page.locator('.vp-main')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  return fehler;
}

for (const breite of [375, 1440] as const) {
  test(`U1 ${PHASE} ${breite}`, async ({ page }) => {
    const unbekannt = await mitAntworten(page, 'u1');
    const fehler = await oeffnen(page, 'u1', breite);
    await expect(page.getByText('Werk Ahrenberg – Halle 1').first()).toBeVisible();
    await page.screenshot({ path: join(BILDER, `u1-${PHASE}-${breite}.png`) });
    expect([...unbekannt]).toEqual([]);
    expect(fehler).toEqual([]);
  });

  test(`U2 ${PHASE} ${breite}`, async ({ page }) => {
    const unbekannt = await mitAntworten(page, 'u2');
    const fehler = await oeffnen(page, 'u2', breite);
    if (PHASE === 'vorher') {
      await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
      await page.screenshot({ path: join(BILDER, `u2-vorher-${breite}.png`) });
    } else {
      await expect(page.getByText('Noch nicht zugeordnet').first()).toBeVisible();
      await expect(page.getByText('3 Anlagen', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(BILDER, `u2-nachher-karte-${breite}.png`) });

      await page.getByRole('button', { name: 'Standorte einrichten' }).click();
      const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
      await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
      const strassen = dialog.getByLabel('Straße und Hausnummer *');
      const plz = dialog.getByLabel('PLZ');
      const orte = dialog.getByLabel('Ort *');
      for (let i = 0; i < await strassen.count(); i++) {
        await strassen.nth(i).fill(i === 2 ? 'Werkstrasse 8' : `Industriestrasse ${4 + i}`);
        await plz.nth(i).fill(i === 2 ? '84123' : '84347');
        await orte.nth(i).fill(i === 2 ? 'Lindach' : 'Ahrenberg');
      }
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `u2-nachher-vorschau-${breite}.png`) });

      await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
      await page.screenshot({ path: join(BILDER, `u2-nachher-bestaetigt-${breite}.png`) });
    }
    expect([...unbekannt]).toEqual([]);
    expect(fehler).toEqual([]);
  });
}
