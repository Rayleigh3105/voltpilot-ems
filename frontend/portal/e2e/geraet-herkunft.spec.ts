import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { JETZT_C1, JETZT_GR4, JETZT_VOR_A5 } from '../src/test/geraetHerkunftFixtures';

/**
 * Die ergänzte Geräteseite (UEMS AP-04 IP-12) bei 375 und 1440 px: die ECHTE
 * `GeraetSeiteSection` mit aufgeklappter Sektion „Komponenten“ — Karte „Gerät“,
 * Karte „Einstellungen“, Messkanäle — und der Dialog „Ändern ab …“ mit der
 * Folgen-Karte des Abnahmefalls A5. Kein Querlauf der Seite, des Dialogs oder
 * eines einzelnen Elements — GEMESSEN, nicht behauptet.
 *
 * Die Uhr steht auf dem Stand der Referenz (`page.clock.setFixedTime`): GR-4
 * am 20.11.2026, zwei Tage nach dem Zählerwechsel; C-1 am 25.01.2027, der
 * Wandler 400/5 A ist eingetragen und gilt ab 01.02.2027.
 *
 * Mit `GERAET_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und die Messwerte
 * (`messung-<fall>-<breite>.json`) ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.GERAET_BILDER;
const BREITEN = [375, 1440] as const;

const FAELLE = {
  gr4: { frage: 'fall=gr4', jetzt: JETZT_GR4 },
  ek2: { frage: 'fall=ek2', jetzt: JETZT_C1 },
  vorA5: { frage: 'fall=ek2&vor=a5', jetzt: JETZT_VOR_A5 },
} as const;

async function oeffne(page: Page, breite: number, fall: keyof typeof FAELLE) {
  await page.clock.setFixedTime(new Date(FAELLE[fall].jetzt));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.goto(`/e2e/geraet-herkunft.html?${FAELLE[fall].frage}`);
  const sektion = page.getByTestId('sektion-komponenten');
  await sektion.locator(':scope > summary').click();
  await expect(sektion.getByTestId('geraet-karte')).toBeVisible();
  await expect(sektion.getByTestId('geraet-messkanaele')).toBeVisible();
  await expect(sektion.getByTestId('geraet-einstellungen').getByRole('status')).toHaveCount(0);
  return fehler;
}

/** Querlauf in px: Seite, Dialog-Körper und jedes Element über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Kinder einer eigenen Scrollfläche (die Chip-Leiste des Rahmens) zählen über deren Maß.
      .filter(({ el }) => !el.closest('.vp-rahmen-chips'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody, .vp-modal .dfoot')] as HTMLElement[];
    const neu = [...document.querySelectorAll('.vp-gh, .vp-einst')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      karten: neu.length ? Math.max(...neu.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string, fehler: string[]) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.karten ?? 0, `${name} ${breite}: neue Karten`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(fehler, `${name} ${breite}: Konsolenfehler`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  if (await page.locator('.vp-modal').count()) {
    const hoehe = await page.evaluate(() => {
      const oben = [...document.querySelectorAll('.vp-modal')].at(-1) as HTMLElement;
      const k = oben.querySelector('.dbody') as HTMLElement;
      const kopf = (oben.querySelector('.dhead') as HTMLElement).offsetHeight;
      const fuss = (oben.querySelector('.dfoot') as HTMLElement | null)?.offsetHeight ?? 0;
      return kopf + k.scrollHeight + fuss + 8;
    });
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: Math.max(vorher.height, hoehe) });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
    await page.setViewportSize(vorher);
  } else {
    // Die Sektion aus dem Bild der ganzen Seite geschnitten: ein Element-Bild
    // wartet auf „stabil“, und die klebende Chip-Leiste stünde darüber.
    const box = await page.getByTestId('sektion-komponenten').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: true, clip: box });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
  }
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    // Die echte Geräteseite lädt viel; der Dialog-Fall klickt sich durch zwei Kalender.
    test.setTimeout(120_000);

    test('GR-4 nach dem Zählerwechsel: Z-5b, Vorgänger Z-5a, Kanäle „speist MS-06 (führend)“', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'gr4');
      const sektion = page.getByTestId('sektion-komponenten');
      await expect(sektion.getByText('Zähler Z-5b')).toBeVisible();
      await expect(sektion.getByTestId('geraet-vorgaenger').getByText('ausgebaut am 18.11.2026, 10:40 Uhr')).toBeVisible();
      await expect(sektion.getByText('speist MS-06 (führend)')).toHaveCount(2);
      await messeUndFotografiere(page, breite, 'gr4', fehler);
    });

    test('EK-2 am Controller C-1: 250/5 A gilt, 400/5 A angekündigt — Historie offen', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'ek2');
      const einst = page.getByTestId('geraet-einstellungen');
      await expect(einst.getByText('Ab 01.02.2027: 400/5 A')).toBeVisible();
      await einst.getByText('Historie (2 Fassungen)').click();
      await expect(einst.getByText('eingetragen am 25.01.2027, 09:00 Uhr von Ines Kaltenbach')).toBeVisible();
      await messeUndFotografiere(page, breite, 'ek2', fehler);
    });

    test('„Ändern ab …“ an EK-2 am 19.01.2027: die Folgen-Karte des Abnahmefalls A5', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'vorA5');
      await page.getByRole('button', { name: 'Ändern ab …' }).click();
      const dialog = page.getByTestId('einstellung-aendern');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Primär (A)').fill('400');
      await dialog.getByRole('combobox', { name: 'Datum' }).click();
      await page.getByRole('button', { name: 'Nächster Monat' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
      const uhr = dialog.getByRole('combobox', { name: 'Uhrzeit' });
      await uhr.fill('08:00');
      await uhr.press('Enter');
      await dialog.getByText('Die Änderung am Gerät geschah schon früher').click();
      await dialog.getByRole('combobox', { name: 'Tatsächlich am' }).click();
      await page.getByRole('gridcell', { name: '20', exact: true }).first().click();
      await dialog.getByLabel('Begründung (optional)').fill('Wandler SG07–SG10 getauscht');
      const folgen = dialog.getByTestId('einstellung-folgen');
      await expect(folgen.getByText('Werte vor dem 01.02.2027, 08:00 Uhr bleiben unverändert.')).toBeVisible();
      await expect(folgen.getByText(/^Der Zeitraum vom 20\.01\.2027 bis 01\.02\.2027, 08:00 Uhr ist mit 250\/5 A erfasst\./)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ab 01.02.2027, 08:00 Uhr eintragen' })).toBeVisible();
      await messeUndFotografiere(page, breite, 'dialog-a5', fehler);
    });
  });
}
