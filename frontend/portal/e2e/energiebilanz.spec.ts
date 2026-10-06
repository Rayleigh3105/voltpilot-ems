import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Anlage › Verlauf › Energiebilanz (UEMS AP-13 IP-8 = AP-10 IP-14; Konzept Auswerten a1 §6.9) bei 375 und 1440 px auf der
 * Bühne `startansicht.html?ansicht=bilanz` (Referenzunternehmen Ahrenberg, Uhr 05.11.2026 09:00): Antwortsatz, Zwei-Teile-
 * Balken mit drei Zeilen und die Unterzähler (O5 Halle 2, Oktober), der Verbrauch in der Anlage mit Erzeugung und Speicher
 * (O6 Halle 1), „mindestens …“ und „—“ ohne Wert (O7, Tag 04.11.2026), die Live-Zeile nur mit Zahl (O8), der Leerzustand
 * ohne Hauptzähler, „Als eigene Messstelle führen“ mit und ohne Recht, die Abzweige benannt. Kein Querlauf am Dokument,
 * Tippflächen ≥ 44 px, kein Geld, keine Konsolenfehler; Prozentzahlen nur aus dem Zwilling der Bewertung.
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
      // Konzept a1 §6.9: sichtbare Prozentzahlen stehen nur als Anteil („x % des Bezugs“, Antwortsatz), nie am Balken.
      prozent: [...(flaeche?.innerText ?? '').matchAll(/[\d,]+\s%(?: des (?:Bezugs|Verbrauchs))?/g)].map((x) => x[0]),
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
  expect(m.prozent.filter((p) => !/ des (Bezugs|Verbrauchs)$/.test(p) && !/^\d+,\d\s%$/.test(p)), `${name} ${breite}: Prozentzahl ohne Bezug`).toEqual([]);
  expect(fehler, `${name} ${breite}: Konsolenfehler`).toEqual([]);
  return m;
}

const zahl = (page: Page, art: string) => page.getByTestId(`zahl-${art}`).first();
const antwort = (page: Page) => page.getByTestId('energiebilanz-antwort');
const woraus = async (page: Page) => {
  await page.getByTestId('energiebilanz-woraus').locator('summary').click();
  return page.getByTestId('energiebilanz-woraus');
};
const nb = (s: string) => s.replace(/ (kWh|kW)\b/g, `${String.fromCharCode(160)}$1`);

for (const breite of BREITEN) {
  test(`B1 · O5 Halle 2, Oktober 2026 bei ${breite} px: Antwort, Zwei-Teile-Balken, Unterzähler, Herkunft`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    await expect(page.getByTestId('energiebilanz-zeitraum')).toHaveText('Oktober 2026');
    await expect(antwort(page)).toHaveText(nb('89,7 % des Bezugs messen eigene Zähler; 3.800 kWh laufen ohne eigenen Zähler.').replace(' %', `${String.fromCharCode(160)}%`));
    await expect(page.getByText('Hauptzähler Netzbezug Halle 2 (MS-10) · Oktober 2026')).toBeVisible();
    await expect(page.getByTestId('zeile-ganz')).toContainText('Bezug laut Hauptzähler');
    await expect(zahl(page, 'ganz')).toHaveText(nb('36.900 kWh'));
    await expect(page.getByTestId('zeile-erfasst')).toContainText('durch 4 Zähler erfasst');
    await expect(zahl(page, 'erfasst')).toHaveText(nb('33.100 kWh'));
    await expect(zahl(page, 'ohne')).toHaveText(nb('3.800 kWh'));
    await expect(page.getByTestId('energiebilanz-rest-messstelle')).toHaveText('geführt als Messstelle Halle 2 nicht zugeordnet (MS-15)');
    // Zwei Teile eines Ganzen: die Breiten sind die Anteile des Zwillings (89,7 / 10,3), ohne Etikett am Balken.
    const breiten = await page.getByTestId('energiebilanz-balken').locator('i').evaluateAll((is) => is.map((i) => (i as HTMLElement).style.flexGrow));
    expect(breiten).toEqual(['89.7', '10.3']);
    await expect(page.getByTestId('energiebilanz-balken')).toHaveText('');
    // Die Unterzähler nach Menge, mit ihrem Anteil am Bezug.
    const reihen = page.getByTestId('energiebilanz-unterzaehler').locator('li');
    await expect(reihen).toHaveCount(4);
    await expect(reihen.first()).toContainText('60,7 % des Bezugs');
    await expect(page.getByTestId('energiebilanz-live')).toHaveText(/^jetzt 1,6.kW ohne eigenen Zähler · Stand \d\d:\d\d$/);
    await expect(page.getByTestId('energiebilanz-fuss')).toHaveText(nb('Netzanschluss NA-2 · vereinbart 200 kW · Zeiten: Europe/Berlin (Werk Ahrenberg)'));
    const m = await pruefeRahmen(page, 'b1-halle2-oktober', breite, fehler);
    expect(m.reiter.slice(0, 2), `${breite}: Reiter des Verlaufs`).toEqual(['Energie', 'Energiebilanz']); // erster Reiter heißt seit main 763b87f39 „Energie“
    await ablegen(page, 'b1-halle2-oktober', breite, m);

    // „Woraus gerechnet“: die Herkunft des Teils ohne eigenen Zähler (AP-10 §5.6), zugeklappt.
    const w = await woraus(page);
    await expect(w.getByTestId('herkunft-abfluss')).toHaveCount(0);
    await expect(w.getByTestId('herkunft-rest')).toContainText('verteilt 100 % an Kostenstelle 4300');
    await expect(w.getByTestId('herkunft-rest')).toContainText('Version 1');
    await expect(w.getByTestId('herkunft-rest')).toContainText('Ladepunkt Parkplatz Halle 2 (MS-14) · Durch Zähler erfasst · gemessen');
    if (BILDER) await w.screenshot({ path: join(BILDER, `b1-woraus-${breite}.png`) });
  });

  /**
   * UEMS AP-13 IP-11 (D1/D2): jeder Unterzähler führt auf seine Messstellen-Seite MIT der Periode der Bilanz; die
   * Kostenstelle der Verteilung auf ihre Karte.
   */
  test(`IP-11 · O5 bei ${breite} px: jeder Unterzähler ein Sprung mit Periode, die Kostenstelle ihre Karte`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    const teile = page.getByTestId('energiebilanz-unterzaehler').locator('a.vp-bil-reihe');
    await expect(teile).toHaveCount(4);
    for (const href of await teile.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      expect(href).toMatch(/^#\/portfolio\/messstellen\/MS-\d+\?periode=2026-10$/);
    }
    const m = await pruefeRahmen(page, 'ip11-spruenge', breite, fehler);
    await ablegen(page, 'ip11-spruenge', breite, m);

    const w = await woraus(page);
    const ks = w.getByTestId('herkunft-rest').locator('a', { hasText: '4300' });
    await expect(ks).toHaveAttribute(
      'href',
      '#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01&kostenstelle=4300',
    );
    // Die Eingänge der Herkunft springen ebenfalls - jeder mit SEINER Version.
    await expect(w.getByTestId('herkunft-rest').locator('a', { hasText: /^MS-\d+$/ }).first()).toHaveAttribute(
      'href',
      /^#\/portfolio\/messstellen\/MS-\d+\?periode=2026-10(&version=\d+)?$/,
    );
  });

  test(`O6 Halle 1, Oktober 2026 bei ${breite} px: Verbrauch in der Anlage, Speicher-Anteile als zwei Eingänge`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-1', breite, fehler);
    await expect(page.getByTestId('zeile-ganz')).toContainText('Verbrauch in der Anlage');
    await expect(zahl(page, 'ganz')).toHaveText(nb('139.380 kWh'));
    await expect(page.getByTestId('zeile-ganz')).toContainText(nb('was hineinkommt (150.400 kWh) minus was hinausgeht (11.020 kWh)'));
    await expect(zahl(page, 'erfasst')).toHaveText(nb('84.800 kWh'));
    await expect(zahl(page, 'ohne')).toHaveText(nb('54.580 kWh'));
    await expect(antwort(page)).toContainText('des Verbrauchs messen eigene Zähler');
    const m = await pruefeRahmen(page, 'o6-halle1-oktober', breite, fehler);
    await ablegen(page, 'o6-halle1-oktober', breite, m);
    const w = await woraus(page);
    await expect(w.getByTestId('herkunft-zufluss')).toContainText('Speicher entladen');
    await expect(w.getByTestId('herkunft-abfluss')).toContainText('Speicher laden');
  });

  test(`O7 Tag 04.11.2026 bei ${breite} px: „mindestens … (MS-14 fehlt)“ und „—“ ohne Wert`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2', breite, fehler);
    await page.getByRole('tab', { name: 'Tag' }).click();
    await expect(page.getByTestId('energiebilanz-zeitraum')).toHaveText('04.11.2026');
    await expect(antwort(page)).toHaveText('Für 04.11.2026 fehlen Werte von Ladepunkt Parkplatz Halle 2 (MS-14) - darum bleibt offen, wie viel ohne eigenen Zähler läuft.');
    await expect(zahl(page, 'ganz')).toHaveText(nb('1.200 kWh'));
    await expect(zahl(page, 'erfasst')).toHaveText(nb('mindestens 1.055 kWh (MS-14 fehlt)'));
    await expect(zahl(page, 'ohne')).toHaveText('—');
    await expect(page.getByTestId('zeile-ohne')).toContainText('keine Werte');
    await expect(page.getByTestId('energiebilanz-balken')).toHaveCount(0);
    await expect(page.getByTestId('energiebilanz')).not.toContainText('145');
    const ms14 = page.getByTestId('teil-MS-14');
    await expect(ms14).toContainText('—');
    await expect(ms14).not.toContainText('%');
    expect(page.url()).toContain('energiebilanz?periode=tag&am=2026-11-04');
    const m = await pruefeRahmen(page, 'o7-tag-mindestens', breite, fehler);
    await ablegen(page, 'o7-tag-mindestens', breite, m);
  });

  test(`O8 veraltet bei ${breite} px: keine Live-Zeile, nie die Teilsumme`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&live=veraltet', breite, fehler);
    await expect(antwort(page)).toBeVisible();
    await expect(page.getByTestId('energiebilanz-live')).toHaveCount(0);
    await expect(page.getByTestId('energiebilanz')).not.toContainText('meldet sich gerade nicht');
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

  test(`Als eigene Messstelle führen bei ${breite} px: nur mit Recht, und nie zweimal`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&rest=vorschlag', breite, fehler);
    const vorschlag = page.getByTestId('rest-vorschlag');
    await expect(vorschlag).toContainText(
      'Als Messstelle „Werk Ahrenberg – Halle 2 nicht zugeordnet“ bekommt dieser Teil eine eigene Zeile in Verbrauch und lässt sich einem Bereich zuordnen.',
    );
    const m = await pruefeRahmen(page, 'rest-vorschlag', breite, fehler);
    await ablegen(page, 'rest-vorschlag', breite, m);
    await vorschlag.getByRole('button', { name: 'Als eigene Messstelle führen' }).click();
    await expect(page.getByTestId('energiebilanz-rueckmeldung')).toHaveText('MS-15 „Werk Ahrenberg – Halle 2 nicht zugeordnet“ ist angelegt.');
    await expect(page.getByTestId('rest-vorschlag')).toHaveCount(0);
    await expect(page.getByTestId('energiebilanz-rest-messstelle')).toContainText('nicht zugeordnet (MS-15)');
    expect(await page.evaluate(() => (window as unknown as { __restAnlegen: unknown[] }).__restAnlegen.length)).toBe(1);
    if (BILDER) await page.getByTestId('energiebilanz').screenshot({ path: join(BILDER, `rest-angelegt-${breite}.png`) });
  });

  /** Konzept Auswerten a1, Befund 3: Abzweige ohne Vorgänger zählen nicht mit und werden benannt, nie still weggelassen. */
  test(`Abzweige außerhalb der Bilanz bei ${breite} px: benannt, ein Kennzeichen bricht nie um`, async ({ page }) => {
    const fehler: string[] = [];
    // AZ-7/AZ-8 stehen nicht im Register der Bühne: ohne Namen steht nur das Kennzeichen (nie geraten).
    await oeffne(page, 'an=AN-1&ausserhalb=AZ-7,AZ-8', breite, fehler);
    const satz = page.getByTestId('energiebilanz-ausserhalb');
    await expect(satz).toHaveText('2 Zähler hängen als Abzweig neben dem Hauptzähler und zählen hier nicht mit: AZ-7, AZ-8.');
    // Die Zahl ohne eigenen Zähler bleibt die der Stellung: die Abzweige gehen weder in „erfasst“ noch in den Rest ein.
    await expect(zahl(page, 'ohne')).toHaveText(nb('54.580 kWh'));
    // Je Kennzeichen eine Zeilenbox und kein Umbruch erlaubt - auch dort, wo der Satz gerade nicht am Bindestrich bricht.
    const zeilen = await satz
      .locator('.vp-bil-kz')
      .evaluateAll((els) => els.map((el) => [el.textContent, el.getClientRects().length, getComputedStyle(el).whiteSpace]));
    expect(zeilen).toEqual([
      ['AZ-7', 1, 'nowrap'],
      ['AZ-8', 1, 'nowrap'],
    ]);
    const m = await pruefeRahmen(page, 'ausserhalb-halle1', breite, fehler);
    await ablegen(page, 'ausserhalb-halle1', breite, m);
  });

  test(`Als eigene Messstelle führen ohne Recht bei ${breite} px: kein Knopf, der Satz sagt, wer es darf`, async ({ page }) => {
    const fehler: string[] = [];
    await oeffne(page, 'an=AN-2&rest=vorschlag&person=CB', breite, fehler);
    const vorschlag = page.getByTestId('rest-vorschlag');
    await expect(vorschlag).toContainText('Eine eigene Messstelle für diesen Teil legt an, wer berechnete Messstellen anlegen darf.');
    await expect(vorschlag.getByRole('button')).toHaveCount(0);
    const m = await pruefeRahmen(page, 'rest-ohne-recht', breite, fehler);
    await ablegen(page, 'rest-ohne-recht', breite, m);
  });
}
