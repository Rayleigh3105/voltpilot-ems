import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * UEMS AP-15 IP-23 — die Karte „Gemeinsame Steuerung“ unter Anlage → Technik und das Einrichten in sechs Fragen, bei
 * 375 und 1440 px, auf der eigenen Bühne `e2e/gemeinsame-steuerung.html` (echte Komponente, gestellte Routen; die
 * geteilte `startansicht` bleibt unberührt). Zahlen aus der Referenzdatei 1.5: Grenzen 100/550 kW, Vorbehalt 473 kW,
 * Ergebnis Einspeisung 40/60 kW und Bezug 0/77 kW, beide „passt“. Frage 6 kommt aus der Vorschau (schreibt nichts),
 * erst „Absenden“ schreibt (§5.2 Nr. 6/7); die Karte zeigt in Kraft die WIRKSAMEN Anteile der Route. Mit `GS_BILDER=<Ordner>` legt der Lauf je Lage
 * und Breite ein Bild für die Ansicht ab. Die Spec importiert keine Fixtures (sie laden `api.ts`).
 */

const BILDER = process.env.GS_BILDER;
// 13:40 in Europe/Berlin — die Bühne setzt den letzten Herzschlag von Box Verwaltung 30 min davor (A1: „seit 13:10“).
const JETZT = new Date('2027-06-15T11:40:00Z');

async function oeffne(page: Page, breite: number, query: string) {
  await page.clock.setFixedTime(JETZT);
  // Für die Aufnahmen höher, damit die Folge ohne Rollen ganz im Bild steht; die Prüfungen gelten in beiden Höhen.
  await page.setViewportSize({ width: breite, height: BILDER ? 1900 : breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/gemeinsame-steuerung.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
}

/** Die Karte; am Telefon ist sie zugeklappt und wird aufgeklappt. */
async function karte(page: Page, breite: number): Promise<Locator> {
  const abschnitt = page.locator('#technik-gemeinsam');
  await expect(abschnitt).toBeVisible();
  if (breite < 720) await abschnitt.getByRole('button', { name: /Gemeinsame Steuerung/ }).first().click();
  const k = page.getByTestId('gemeinsame-steuerung');
  await expect(k).toBeVisible();
  return k;
}

async function bild(ziel: Locator, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await ziel.page().waitForTimeout(250);
  await ziel.screenshot({ path: join(BILDER, `${name}.png`) });
}

const modal = (page: Page) => page.locator('.vp-modal').last();

const geschrieben = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gsGeschrieben: () => unknown }).__gsGeschrieben());
const vorschauen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gsVorschauen: () => number }).__gsVorschauen());

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

for (const breite of [375, 1440]) {
  test(`AP-15 IP-23 · ${breite} px: die Karte erscheint nur an einer steuernden Anlage mit mehr als einer Box`, async ({ page }) => {
    await oeffne(page, breite, 'anlage=an2');
    await expect(page.getByTestId('gs-ohne-karte')).toBeVisible();
    await expect(page.locator('#technik-gemeinsam')).toHaveCount(0);
    await oeffne(page, breite, 'boxen=1');
    await expect(page.getByTestId('gs-ohne-karte')).toBeVisible();
    await expect(page.locator('#technik-gemeinsam')).toHaveCount(0);
    await oeffne(page, breite, 'lage=nicht_eingerichtet');
    const k = await karte(page, breite);
    await expect(k).toContainText('Diese Anlage hat 2 Boxen.');
    await expect(k.getByRole('button', { name: 'Gemeinsame Steuerung einrichten' })).toBeVisible();
    await expect(k.getByRole('button', { name: /scharf/i })).toHaveCount(0);
    await bild(page.locator('#technik-gemeinsam'), `karte-nicht-eingerichtet-${breite}`);
  });

  test(`AP-15 IP-23 · ${breite} px: Einrichten in sechs Fragen — Ahrenberg ergibt 40/60 und 0/77, passt`, async ({ page }) => {
    await oeffne(page, breite, 'lage=nicht_eingerichtet');
    const k = await karte(page, breite);
    await k.getByRole('button', { name: 'Gemeinsame Steuerung einrichten' }).click();
    const m = modal(page);
    const weiter = m.getByRole('button', { name: 'Weiter' });

    await expect(m.getByText('Frage 1 von 6 · Welche Boxen steuern mit?')).toBeVisible();
    await expect(m.getByRole('checkbox', { name: /Box Halle 1/ })).toBeChecked();
    await expect(m.getByRole('checkbox', { name: /Box Verwaltung/ })).toBeChecked();
    await bild(m, `frage-1-${breite}`);
    await weiter.click();

    await expect(m.getByText('Frage 2 von 6 · Welche Box misst am Netzanschluss?')).toBeVisible();
    await weiter.click();
    await expect(m.getByText('Bitte die Datenquelle des Netzzählers wählen.')).toBeVisible();
    await waehle(page, m.getByRole('combobox', { name: 'Datenquelle des Netzzählers', exact: true }), /^DQ-2/);
    await bild(m, `frage-2-${breite}`);
    await weiter.click();

    await expect(m.getByText('Frage 3 von 6 · Grenzen am Netzanschluss')).toBeVisible();
    await expect(m.locator('.vp-gs-grenzen')).toContainText('100 kW');
    await expect(m.locator('.vp-gs-grenzen')).toContainText('550 kW');
    await bild(m, `frage-3-${breite}`);
    await weiter.click();

    await expect(m.getByText(/^Frage 4 von 6/)).toBeVisible();
    await expect(m.getByLabel(/Verbrauch, den keine Box steuert/)).toHaveValue('473');
    // AP-15 Folge von IP-19: der Vorschlag aus den Messwerten enthält nicht, was hinter einem Abgangszähler liegt
    await expect(m.getByText(/enthält nicht, was hinter dem Zähler einer mitsteuernden Box liegt/)).toBeVisible();
    await weiter.click();
    await expect(m.getByText('Bitte „Keine“ wählen oder die Erzeuger eintragen.')).toBeVisible();
    await waehle(page, m.getByRole('combobox', { name: 'Gibt es solche Erzeuger?', exact: true }), /^Keine/);
    await bild(m, `frage-4-${breite}`);
    await weiter.click();

    await expect(m.getByText(/^Frage 5 von 6/)).toBeVisible();
    const halle1 = m.getByTestId('gs-box-frage').filter({ hasText: 'Box Halle 1' });
    const verwaltung = m.getByTestId('gs-box-frage').filter({ hasText: 'Box Verwaltung' });
    await expect(verwaltung.getByTestId('gs-geraet')).toHaveCount(7);
    await expect(m.getByRole('button', { name: 'Einrichten' })).toHaveCount(0);
    await weiter.click();
    // Der Speicher hat im Bestand keine Nennleistung — die Lücke steht an seinem Feld, gefragt und geschrieben wird nichts.
    await expect(halle1.getByTestId('gs-geraet').filter({ hasText: 'Batteriespeicher' })).toContainText('Bitte die Nennleistung in kW angeben.');
    expect(await geschrieben(page)).toBeNull();
    expect(await vorschauen(page)).toBe(0);
    await halle1.getByLabel(/Batteriespeicher 200 kWh · Bezug/).fill('100');
    await waehle(page, halle1.getByRole('combobox', { name: 'Bekommt diese Box das Signal des Netzbetreibers?', exact: true }), /^Ja/);
    await waehle(page, verwaltung.getByRole('combobox', { name: 'Zähler dieser Box', exact: true }), /^DQ-10/);
    // mit eigenem Zähler: das Ungeregelte dahinter, Vorgabe 0 (DQ-10 wie in Ahrenberg); an der führenden Box nicht
    await expect(verwaltung.getByLabel(/Verbrauch hinter diesem Zähler/)).toHaveValue('0');
    await expect(halle1.getByLabel(/Verbrauch hinter diesem Zähler/)).toHaveCount(0);
    await waehle(page, verwaltung.getByRole('combobox', { name: 'Bekommt diese Box das Signal des Netzbetreibers?', exact: true }), /^Nein/);
    await bild(m, `frage-5-${breite}`);
    await weiter.click();

    // Frage 6 VOR dem Schreiben: das Ergebnis des Entwurfs aus der Vorschau, noch ist nichts gespeichert
    await expect(m.getByText('Frage 6 von 6 · Ergebnis')).toBeVisible();
    await expect(m.getByTestId('gs-ergebnis-entwurf')).toHaveText('Noch ist nichts gespeichert. Mit „Absenden“ richten Sie die Gemeinsame Steuerung so ein.');
    expect(await vorschauen(page)).toBe(1);
    expect(await geschrieben(page)).toBeNull();
    const ein = m.getByTestId('gs-richtung-einspeisung');
    const bez = m.getByTestId('gs-richtung-bezug');
    await expect(ein).toContainText('Box Halle 1: 40 kW');
    await expect(ein).toContainText('Box Verwaltung: 60 kW');
    await expect(bez).toContainText('Box Halle 1: 0 kW');
    await expect(bez).toContainText('Box Verwaltung: 77 kW');
    await expect(ein).toContainText('Passt die Anlage zur Grenze? Ja — die Anlage passt zur Grenze am Netzanschluss.');
    await expect(bez).toContainText('Passt die Anlage zur Grenze? Ja — die Anlage passt zur Grenze am Netzanschluss.');
    await expect(m.getByTestId('gs-hinweis')).toHaveText([
      'Box Verwaltung braucht ein Update für die gemeinsame Steuerung.',
      /^Am Gerät PV-Wechselrichter Verwaltung 60 kW ist kein sicherer Rückfallwert hinterlegt — es zählt mit seiner vollen Leistung\./,
      'Der Ladepark hängt an einer Box, die den Netzanschluss nicht sieht: er bekommt fest 77 kW. An Box Halle 1 bekäme er, was am Anschluss frei ist.',
      'Die Ladepunkte müssen an der Box hängen, die das Signal des Netzbetreibers bekommt.',
    ]);
    await bild(m, `frage-6-${breite}`);

    // Der Rückfallwert lässt sich gleich am Gerät hinterlegen (PUT …/komponenten/{id}/rueckfall); das Ergebnis wird
    // neu gerechnet und bleibt ein Entwurf.
    const rueckfall = m.getByTestId('gs-hinweis').filter({ hasText: 'kein sicherer Rückfallwert' });
    await rueckfall.getByLabel('Sicherer Rückfallwert (kW)').fill('30');
    await rueckfall.getByRole('button', { name: 'Am Gerät hinterlegen' }).click();
    await expect(m.getByTestId('gs-hinweis').filter({ hasText: 'kein sicherer Rückfallwert' })).toHaveCount(0);
    expect(await vorschauen(page)).toBe(2);
    expect(await geschrieben(page)).toBeNull();

    // §5.2 Nr. 7: Absenden ist ein eigener Schritt — erst jetzt geht das PUT
    await m.getByRole('button', { name: 'Absenden' }).click();
    await expect(m.getByText('Abgesendet', { exact: true })).toBeVisible();
    await expect(m.getByTestId('gs-ergebnis-zustand')).toHaveText('Eingerichtet · wird geprüft. VoltPilot prüft die Anlage mit einer kurzen Messung und schaltet sie frei.');
    await expect(m.getByTestId('gs-abgesendet')).toContainText('An den Boxen hat sich nichts geändert.');
    const koerper = await geschrieben(page) as {
      mitglieder: { rolle: string; vorgabe_signal: string; geraete: unknown[] }[]; ungesteuerte_erzeuger: unknown; vorbehalt: unknown;
    };
    expect(koerper.mitglieder.map((x) => [x.rolle, x.vorgabe_signal, x.geraete.length])).toEqual([['fuehrt', 'ja', 2], ['steuert_mit', 'nein', 7]]);
    expect(koerper.mitglieder.every((x) => !('ungeregelt' in x))).toBe(true);
    expect(koerper.ungesteuerte_erzeuger).toBe('keine');
    expect(koerper.vorbehalt).toEqual({ bezug_kw: 473 });
    await bild(m, `abgesendet-${breite}`);

    await m.getByRole('button', { name: 'Fertig' }).click();
    await expect(page.getByTestId('gs-zustand')).toHaveText('Eingerichtet · wird geprüft. VoltPilot prüft die Anlage mit einer kurzen Messung und schaltet sie frei.');
    await expect(page.getByTestId('gs-box').nth(1)).toContainText('Box Verwaltung steuert mit, sobald VoltPilot freischaltet · vorgesehener Anteil: Einspeisung 60 kW · Bezug 77 kW');
    await bild(page.locator('#technik-gemeinsam'), `karte-wird-geprueft-${breite}`);
  });

  test(`AP-15 Folge IP-19 · ${breite} px: ein per API erklärtes Ungeregeltes hinter dem Abgang bleibt beim Speichern`, async ({ page }) => {
    await oeffne(page, breite, 'lage=nicht_eingerichtet&ungeregelt=50');
    const k = await karte(page, breite);
    await k.getByRole('button', { name: 'Gemeinsame Steuerung einrichten' }).click();
    const m = modal(page);
    const weiter = m.getByRole('button', { name: 'Weiter' });
    await weiter.click();
    await waehle(page, m.getByRole('combobox', { name: 'Datenquelle des Netzzählers', exact: true }), /^DQ-2/);
    await weiter.click();
    await weiter.click();
    await waehle(page, m.getByRole('combobox', { name: 'Gibt es solche Erzeuger?', exact: true }), /^Keine/);
    await weiter.click();
    await expect(m.getByText(/^Frage 5 von 6/)).toBeVisible();
    const halle1 = m.getByTestId('gs-box-frage').filter({ hasText: 'Box Halle 1' });
    const verwaltung = m.getByTestId('gs-box-frage').filter({ hasText: 'Box Verwaltung' });
    await halle1.getByLabel(/Batteriespeicher 200 kWh · Bezug/).fill('100');
    await waehle(page, verwaltung.getByRole('combobox', { name: 'Zähler dieser Box', exact: true }), /^DQ-10/);
    const feld = verwaltung.getByLabel(/Verbrauch hinter diesem Zähler/);
    await expect(feld).toHaveValue('50');
    await expect(verwaltung).toContainText('kein Gebäudeverteiler, keine Geräte ohne Freigabe, nichts einer anderen Box');
    await bild(verwaltung, `frage-5-ungeregelt-${breite}`);
    await weiter.click();
    await expect(m.getByText('Frage 6 von 6 · Ergebnis')).toBeVisible();
    await m.getByRole('button', { name: 'Absenden' }).click();
    await expect(m.getByText('Abgesendet', { exact: true })).toBeVisible();
    const koerper = await geschrieben(page) as { mitglieder: { rolle: string; ungeregelt?: unknown }[] };
    expect(koerper.mitglieder.map((x) => [x.rolle, x.ungeregelt ?? null])).toEqual([
      ['fuehrt', null],
      ['steuert_mit', [{ richtung: 'bezug', hoechstwert_kw: 50 }]],
    ]);
  });

  test(`AP-15 IP-23 · ${breite} px: Ausfall-Satz — Box Verwaltung antwortet nicht, die Grenze bleibt eingehalten`, async ({ page }) => {
    await oeffne(page, breite, 'lage=anteile_aktiv&ausfall=verwaltung');
    const k = await karte(page, breite);
    await expect(k.getByTestId('gs-zustand')).toHaveText('Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung höchstens 100 kW · Bezug höchstens 550 kW');
    await expect(k.getByTestId('gs-ausfall')).toHaveText(
      'Box Verwaltung antwortet seit 13:10 nicht. Die Grenze am Netzanschluss bleibt eingehalten; ihre Geräte laufen mit ihren sicheren Vorgabewerten.',
    );
    await bild(page.locator('#technik-gemeinsam'), `ausfall-a1-${breite}`);
    await oeffne(page, breite, 'lage=anteile_aktiv&ausfall=beide');
    const k2 = await karte(page, breite);
    await expect(k2.getByTestId('gs-ausfall').first()).toHaveText('Beide Boxen sind nicht verbunden. Die Grenze am Netzanschluss halten sie selbst ein.');
  });

  test(`AP-15 IP-23 · ${breite} px: aktiv, angehalten und vom Betreiber angehalten — Anhalten mit Recht, kein Scharfschalten`, async ({ page }) => {
    await oeffne(page, breite, 'lage=anteile_aktiv&gebunden=32760&kwh=0');
    const k = await karte(page, breite);
    await expect(k.getByTestId('gs-box')).toHaveText([
      'Box Halle 1 führt die Anlage · regelt am Netzanschluss',
      /^Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 60 kW · Bezug 77 kW/,
    ]);
    await expect(k.getByTestId('gs-erst-anhalten')).toBeVisible();
    await expect(k.getByTestId('gs-ausfall')).toHaveCount(0);
    await expect(k.getByRole('button', { name: 'Gemeinsame Steuerung ändern' })).toHaveCount(0);
    await bild(page.locator('#technik-gemeinsam'), `karte-aktiv-${breite}`);
    await k.getByRole('button', { name: 'Anhalten' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Box Halle 1 steuert allein; alle Boxen halten weiter ihren Anteil.');
    await dialog.getByRole('button', { name: 'Anhalten' }).click();
    await expect(k.getByTestId('gs-zustand')).toHaveText('Gemeinsame Steuerung angehalten. Box Halle 1 steuert allein; alle Boxen halten weiter ihren Anteil.');
    await expect(k.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
    await expect(k.getByRole('button', { name: 'Gemeinsame Steuerung ändern' })).toBeVisible();
    await bild(page.locator('#technik-gemeinsam'), `karte-angehalten-${breite}`);

    await oeffne(page, breite, 'lage=angehalten_betreiber');
    const k2 = await karte(page, breite);
    await expect(k2.getByTestId('gs-betreiber')).toContainText('Fortsetzen kann nur VoltPilot');
    await expect(k2.getByRole('button', { name: 'Fortsetzen' })).toHaveCount(0);
    await bild(page.locator('#technik-gemeinsam'), `karte-betreiber-${breite}`);

    await oeffne(page, breite, 'lage=erklaert');
    const k3 = await karte(page, breite);
    await expect(k3.getByTestId('gs-zustand')).toHaveText('Gemeinsame Steuerung eingerichtet');
    await bild(page.locator('#technik-gemeinsam'), `karte-eingerichtet-${breite}`);
  });

  test(`AP-15 IP-23 · ${breite} px: der Betreiber weicht beim Scharfschalten ab — die Karte zeigt die wirksamen Anteile`, async ({ page }) => {
    await oeffne(page, breite, 'lage=anteile_aktiv&wirksam=abweichend');
    const k = await karte(page, breite);
    await expect(k.getByTestId('gs-box').nth(1)).toHaveText(/^Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 70 kW · Bezug 72 kW/);
    await expect(k).not.toContainText('Einspeisung 60 kW');
    await bild(page.locator('#technik-gemeinsam'), `karte-aktiv-abweichend-${breite}`);
    await k.getByRole('button', { name: 'Anhalten' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Anhalten' }).click();
    await expect(k.getByTestId('gs-zustand')).toContainText('Gemeinsame Steuerung angehalten.');
    await expect(k.getByTestId('gs-box').nth(1)).toHaveText(/^Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 70 kW · Bezug 72 kW/);
  });

  test(`AP-15 IP-23 · ${breite} px: Verlust-Zeile — kWh nur als Untergrenze, sonst die Stunden (Varianten A und B)`, async ({ page }) => {
    const faelle = [
      ['A', 0, 'Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.'],
      ['A', 160.8, 'Heute mindestens 160 kWh nicht erzeugt, weil diese Box den Netzanschluss nicht sieht.'],
      ['B', 0, 'Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.'],
      ['B', 160.8, 'Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht — mindestens 160 kWh nicht erzeugt.'],
    ] as const;
    for (const [variante, kwh, satz] of faelle) {
      await oeffne(page, breite, `lage=anteile_aktiv&gebunden=32760&kwh=${kwh}&variante=${variante}`);
      const k = await karte(page, breite);
      await expect(k.getByTestId('gs-verlust')).toHaveText(satz);
      await bild(k.getByTestId('gs-box').nth(1), `verlust-${variante}-${kwh > 0 ? 'kwh' : 'null'}-${breite}`);
    }
  });
}
