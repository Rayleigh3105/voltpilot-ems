import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Anlage › Verlauf › Energiebilanz (UEMS AP-13 IP-8 = AP-10 IP-14, E7 = A) bei 375 und 1440 px auf der Bühne
 * `startansicht.html?ansicht=bilanz` (Referenzunternehmen Ahrenberg, Uhr 05.11.2026 09:00): B1 (O5 Halle 2, Oktober),
 * O6 (Halle 1 mit Abfluss und zwei Speicher-Zeilen), O7 (Tag 04.11.2026 — „mindestens …“ und „— keine Werte“), O8
 * (Live-Zeile mit Stand, veraltet mit Grund), B2 (Balken ohne Prozentzahl), der Leerzustand ohne Hauptzähler, „Rest
 * anlegen“ mit und ohne Recht. Kein Querlauf am Dokument, Tippflächen ≥ 44 px, kein Geld, keine Konsolenfehler.
 *
 * Mit `ENERGIEBILANZ_BILDER=<Ordner>` legt der Lauf je Fall die Fläche als Bild und die Messwerte ab.
 */

const BILDER = process.env.ENERGIEBILANZ_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-11-05T08:00:00Z');
const ST1 = '5a1d0000-0000-4000-8000-000000000001';

async function oeffne(page: Page, query: string, breite: number, fehler: string[]) {
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  // `bild=unternehmen`: die Bühne mit allen drei Anlagen (die Vorgabe `einzel` kennt nur Halle 1).
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&ansicht=bilanz&${query}`);
  await expect(page.getByTestId('energiebilanz')).toBeVisible();
  await expect(page.getByText('Wird geladen …')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const rand = doc.clientWidth;
    const draussen = [...document.querySelectorAll('.vp-main *')]
      .filter((el) => !el.closest('.vp-bereich-tabs, .vp-sr-only'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > rand + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const flaeche = document.querySelector<HTMLElement>('[data-testid="energiebilanz"]');
    const kleine = [...(flaeche?.querySelectorAll<HTMLElement>('button, a, summary') ?? [])]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ text: el.textContent?.trim() ?? el.getAttribute('aria-label'), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44);
    const reiter = [...document.querySelectorAll('.vp-bereich-tabs [role="tab"]')].map((el) =>
      el.textContent?.trim(),
    );
    return {
      dokument: doc.scrollWidth - doc.clientWidth,
      draussen,
      kleine,
      reiter,
      hoehe: Math.round(flaeche?.getBoundingClientRect().height ?? 0),
      euro: /€|\bEUR\b|Erlös/.test(document.querySelector('.vp-main')?.textContent ?? ''),
      // Sichtbar, ohne die zugeklappte Herkunft: nirgends eine Prozentzahl (B2).
      prozent: /%/.test(flaeche?.innerText ?? ''),
    };
  });
}

async function ablegen(page: Page, name: string, breite: number, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m, null, 2));
  await page.mouse.move(0, 0);
  await page.getByTestId('energiebilanz').screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
}

async function pruefeRahmen(page: Page, name: string, breite: number, fehler: string[]) {
  const m = await messe(page);
  expect(m.dokument, `${name} ${breite}: Querlauf des Dokuments`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (breite < 721) expect(m.kleine, `${name} ${breite}: Tippflächen`).toEqual([]);
  expect(m.euro, `${name} ${breite}: Geld auf der Fläche`).toBe(false);
  expect(m.prozent, `${name} ${breite}: Prozentzahl sichtbar`).toBe(false);
  expect(fehler, `${name} ${breite}: Konsolenfehler`).toEqual([]);
  return m;
}

const zahl = (page: Page, art: string) => page.getByTestId(`zahl-${art}`).first();
const nb = (s: string) => s.replace(/ (kWh|kW)\b/g, `${String.fromCharCode(160)}$1`);

for (const breite of BREITEN) {
  test(`B1 · O5 Halle 2, Oktober 2026 bei ${breite} px: vier Zeilen der Route, Balken je Unterzähler, Herkunft`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    await expect(page.getByTestId('energiebilanz-zeitraum')).toHaveText('Oktober 2026');
    await expect(page.getByTestId('energiebilanz-zone')).toHaveText('Zeiten in Europe/Berlin');
    await expect(zahl(page, 'zufluss')).toHaveText(nb('36.900 kWh'));
    await expect(page.getByTestId('zeile-abfluss')).toHaveCount(0);
    await expect(zahl(page, 'zugeordnet')).toHaveText(nb('33.100 kWh'));
    await expect(zahl(page, 'rest')).toHaveText(nb('3.800 kWh'));
    await expect(page.getByTestId('zeile-rest')).toContainText('Halle 2 nicht zugeordnet (MS-15)');
    // B2: vier Unterzähler, vier Balken, keine Prozentzahl.
    await expect(page.getByTestId('zeile-zugeordnet').locator('.vp-share')).toHaveCount(4);
    await expect(page.getByTestId('energiebilanz-live')).toHaveText(/^jetzt: 1,6.kW nicht zugeordnet · Stand \d\d:\d\d$/);
    const m = await pruefeRahmen(page, 'b1-halle2-oktober', breite, fehler);
    expect(m.reiter.slice(0, 2), `${breite}: Reiter des Verlaufs`).toEqual(['Energie', 'Energiebilanz']); // erster Reiter heißt seit main 763b87f39 „Energie“
    await ablegen(page, 'b1-halle2-oktober', breite, m);

    // Die Herkunfts-Karte des Rests (AP-10 §5.6).
    await page.getByTestId('herkunft-rest').locator('summary').click();
    await expect(page.getByTestId('herkunft-rest')).toContainText('verteilt 100 % an Kostenstelle 4300');
    await expect(page.getByTestId('herkunft-rest')).toContainText('Version 1');
    await expect(page.getByTestId('herkunft-rest')).toContainText('Ladepunkt Parkplatz Halle 2 (MS-14) · Zugeordnet · gemessen');
    if (BILDER) await page.getByTestId('zeile-rest').screenshot({ path: join(BILDER, `b1-herkunft-rest-${breite}.png`) });
  });

  /**
   * UEMS AP-13 IP-11 (D1/D2): die Bilanz-Zeilen bekommen ihre Kanten. Jeder Unterzähler führt auf seine
   * Messstellen-Seite MIT der Periode der Bilanz; die Kostenstelle der Verteilung auf ihre Karte.
   */
  test(`IP-11 · O5 bei ${breite} px: jeder Unterzähler ein Sprung mit Periode, die Kostenstelle ihre Karte`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    const teile = page.getByTestId('zeile-zugeordnet').locator('a.vp-eb-teil-sprung');
    await expect(teile).toHaveCount(4);
    for (const href of await teile.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      expect(href).toMatch(/^#\/portfolio\/messstellen\/MS-\d+\?periode=2026-10$/);
    }
    // Gemessen wird der Rahmen am ZUGEKLAPPTEN Bild — wie in O5: die Herkunft darf ihre Prozentzahl nennen.
    const m = await pruefeRahmen(page, 'ip11-spruenge', breite, fehler);
    await ablegen(page, 'ip11-spruenge', breite, m);
    if (BILDER) await page.getByTestId('zeile-zugeordnet').screenshot({ path: join(BILDER, `ip11-zugeordnet-${breite}.png`) });

    await page.getByTestId('herkunft-rest').locator('summary').click();
    const ks = page.getByTestId('herkunft-rest').locator('a', { hasText: '4300' });
    await expect(ks).toHaveAttribute(
      'href',
      '#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01&kostenstelle=4300',
    );
    // Die Eingänge der Herkunft springen ebenfalls — jeder mit SEINER Version.
    await expect(page.getByTestId('herkunft-rest').locator('a', { hasText: /^MS-\d+$/ }).first()).toHaveAttribute(
      'href',
      /^#\/portfolio\/messstellen\/MS-\d+\?periode=2026-10(&version=\d+)?$/,
    );
  });

  test(`O6 Halle 1, Oktober 2026 bei ${breite} px: Abfluss und die Speicher-Anteile als zwei Zeilen`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-1', breite, fehler);
    await expect(zahl(page, 'zufluss')).toHaveText(nb('150.400 kWh'));
    await expect(zahl(page, 'abfluss')).toHaveText(nb('11.020 kWh'));
    await expect(zahl(page, 'zugeordnet')).toHaveText(nb('84.800 kWh'));
    await expect(zahl(page, 'rest')).toHaveText(nb('54.580 kWh'));
    await expect(page.getByTestId('zeile-zufluss').getByTestId('teil-MS-04')).toContainText('negativer Anteil');
    await expect(page.getByTestId('zeile-abfluss').getByTestId('teil-MS-04')).toContainText('positiver Anteil');
    const m = await pruefeRahmen(page, 'o6-halle1-oktober', breite, fehler);
    await ablegen(page, 'o6-halle1-oktober', breite, m);
  });

  test(`O7 Tag 04.11.2026 bei ${breite} px: „mindestens … (MS-14 fehlt)“ und „— keine Werte“`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    await page.getByRole('tab', { name: 'Tag' }).click();
    await expect(page.getByTestId('energiebilanz-zeitraum')).toHaveText('04.11.2026');
    await expect(zahl(page, 'zufluss')).toHaveText(nb('1.200 kWh'));
    await expect(zahl(page, 'zugeordnet')).toHaveText(nb('mindestens 1.055 kWh (MS-14 fehlt)'));
    await expect(zahl(page, 'rest')).toHaveText('—');
    await expect(page.getByTestId('zeile-rest')).toContainText('keine Werte');
    await expect(page.getByTestId('energiebilanz')).not.toContainText('145');
    const ms14 = page.getByTestId('teil-MS-14');
    await expect(ms14).toContainText('keine Werte');
    await expect(ms14.locator('.vp-share')).toHaveCount(0);
    expect(page.url()).toContain('energiebilanz?periode=tag&am=2026-11-04');
    const m = await pruefeRahmen(page, 'o7-tag-mindestens', breite, fehler);
    await ablegen(page, 'o7-tag-mindestens', breite, m);
  });

  test(`O8 veraltet bei ${breite} px: ein Strich mit dem Grund, nie die Teilsumme`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&live=veraltet', breite, fehler);
    await expect(page.getByTestId('energiebilanz-live')).toHaveText('jetzt: — · Ladepunkt Parkplatz Halle 2 meldet sich gerade nicht');
    const m = await pruefeRahmen(page, 'o8-live-veraltet', breite, fehler);
    await ablegen(page, 'o8-live-veraltet', breite, m);
  });

  test(`Leerzustand ohne Hauptzähler bei ${breite} px: kein Reiter, der Weg nur mit Recht`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&bilanz=ohne-hz', breite, fehler);
    const leer = page.getByTestId('energiebilanz-leer');
    await expect(leer).toContainText('Kein Hauptzähler');
    await expect(leer).toContainText('Diese Anlage hat keinen Hauptzähler in der elektrischen Stellung.');
    await expect(leer.getByRole('link', { name: 'Stellung eintragen' })).toHaveAttribute('href', `#/standort/${ST1}/messstellen`);
    await expect(page.getByTestId('energiebilanz-hauptzaehler')).toHaveCount(0);
    const m = await pruefeRahmen(page, 'leer-ohne-hauptzaehler', breite, fehler);
    expect(m.reiter, `${breite}: ohne Hauptzähler kein Reiter`).not.toContain('Energiebilanz');
    await ablegen(page, 'leer-ohne-hauptzaehler', breite, m);
  });

  test(`Rest anlegen bei ${breite} px: nur mit Recht, und nie zweimal`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&rest=vorschlag', breite, fehler);
    const vorschlag = page.getByTestId('rest-vorschlag');
    await expect(vorschlag).toContainText('Vorschlag: „Werk Ahrenberg – Halle 2 nicht zugeordnet“ anlegen.');
    const m = await pruefeRahmen(page, 'rest-vorschlag', breite, fehler);
    await ablegen(page, 'rest-vorschlag', breite, m);
    await vorschlag.getByRole('button', { name: 'Rest anlegen' }).click();
    await expect(page.getByTestId('energiebilanz-rueckmeldung')).toHaveText('MS-15 „Werk Ahrenberg – Halle 2 nicht zugeordnet“ ist angelegt.');
    await expect(page.getByTestId('rest-vorschlag')).toHaveCount(0);
    await expect(page.getByTestId('zeile-rest')).toContainText('Halle 2 nicht zugeordnet (MS-15)');
    expect(await page.evaluate(() => (window as unknown as { __restAnlegen: unknown[] }).__restAnlegen.length)).toBe(1);
    if (BILDER) await page.getByTestId('energiebilanz').screenshot({ path: join(BILDER, `rest-angelegt-${breite}.png`) });
  });

  test(`Rest anlegen ohne Recht bei ${breite} px: kein Knopf, der Satz sagt, wer es darf`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&rest=vorschlag&person=CB', breite, fehler);
    const vorschlag = page.getByTestId('rest-vorschlag');
    await expect(vorschlag).toContainText('Eine Messstelle für den Rest legt an, wer berechnete Messstellen anlegen darf.');
    await expect(vorschlag.getByRole('button')).toHaveCount(0);
    const m = await pruefeRahmen(page, 'rest-ohne-recht', breite, fehler);
    await ablegen(page, 'rest-ohne-recht', breite, m);
  });
}
