import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessstelleWerte, WagoKartenangaben } from '../src/api';
import { MS_12 } from '../src/test/vergleichFixtures';
import {
  antwort, schritt, stundenDes, tagSchritt, tagesgrenzen, viertelstundenDes, voll,
} from '../src/test/werteKarteFixtures';

const TAG = '2027-01-15';
/** A8: Rücksetzung per WAGO-I/O-CHECK an EK-3, 09:12 — und die vier Meldungen der Box daneben. */
const EREIGNISSE: Record<number, Array<{ id: string; art: string; von: string; bis: string | null }>> = {
  9: [
    { id: 'e1', art: 'counter_reset', von: `${TAG}T08:12:00Z`, bis: null },
    { id: 'e2', art: 'range_limit', von: `${TAG}T08:20:00Z`, bis: null },
  ],
  11: [{ id: 'e3', art: 'device_restart', von: `${TAG}T10:05:00Z`, bis: null }],
  13: [{ id: 'e4', art: 'frozen_source', von: `${TAG}T12:30:00Z`, bis: null }],
  15: [{ id: 'e5', art: 'layout_changed', von: `${TAG}T14:40:00Z`, bis: null }],
};

/**
 * Der Tag der Abnahme A8 im Raster der Route. Die Ereignisse hängen an den Schritten, in die ihr
 * Zeitpunkt fällt; die Stunden 9 und 10 sind Lücke — ein Marker erklärt sie, er füllt sie nicht.
 */
function werteMitMarkern(raster: string): MessstelleWerte {
  const g = tagesgrenzen(TAG);
  if (raster === 'tag') {
    return antwort(MS_12, 'tag', g.von, g.bis, [tagSchritt(TAG, {
      ...voll(548.3, 96), erhalten: 88, abdeckung_prozent: 92, zustand: 'unvollständig',
      fassung: 'endgueltig', ereignisse: Object.values(EREIGNISSE).flat(),
    })]);
  }
  const je = (teiler: number) => (_b: string, i: number) =>
    (i >= 9 * teiler && i < 11 * teiler
      ? { menge: null, zustand: 'keine Werte' as const, erhalten: 0, erwartet: 1, abdeckung_prozent: 0 }
      : voll(Math.round((28 + Math.sin(i / teiler) * 9) * 10) / (10 * teiler), 4 / teiler));
  const felder = raster === 'viertelstunde' ? viertelstundenDes(TAG, je(4)) : stundenDes(TAG, je(1));
  const teiler = raster === 'viertelstunde' ? 4 : 1;
  const werte = felder.map((s, i) => schritt({ ...s, ereignisse: EREIGNISSE[Math.floor(i / teiler)] ?? [] }));
  return antwort(MS_12, raster === 'viertelstunde' ? 'viertelstunde' : 'stunde', g.von, g.bis, werte);
}

function karte(over: Partial<WagoKartenangaben> = {}): WagoKartenangaben {
  return { slot: 5, anwenderskalierung: false, register35: 0, version: 3, kartenwechsel: null,
    variante: 25001, controllerKennung: 8212, ...over };
}

async function buehne(page: import('@playwright/test').Page, stand: WagoKartenangaben,
  posts: unknown[] = []) {
  // Die gestellte Cloud MERKT SICH den Eintrag: nach dem Wechsel liest die Fläche den neuen Stand.
  let aktuell = stand;
  await page.route('**/api/v1/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (p.endsWith('/wago/kartenwechsel')) {
      posts.push(route.request().postDataJSON());
      aktuell = karte({ anwenderskalierung: null, register35: null, version: aktuell.version + 1,
        kartenwechsel: `${TAG}T08:30:00Z` });
      body = aktuell;
    } else if (p.endsWith('/wago')) body = aktuell;
    else if (p.includes('/werte')) {
      body = werteMitMarkern(new URL(route.request().url()).searchParams.get('raster') ?? 'stunde');
    }
    else if (p.endsWith('/standorte')) body = { standorte: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/** Die vier Kunden-Überschriften der neuen Marker plus die Rücksetzung aus A8. */
const MARKER_WOERTER = ['Zähler zurückgesetzt', 'Bereichsbegrenzung', 'Neustart des Geräts',
  'Werte eingefroren', 'Aufbau geändert'];

test('A8/A10: Marker im Verlauf, Hebel nur aus Belegen, Dialog „Karte getauscht"', async ({ page }, info) => {
  const breite = info.project.name.includes('mobile') ? 375 : 1440;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 900 : 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const posts: unknown[] = [];
  // Ohne Beleg: dokumentierte Karte, kein Hebel.
  await buehne(page, karte({ anwenderskalierung: true, register35: 4 }), posts);
  await page.goto('/e2e/wago-karte.html');
  const bilder = process.env.WAGO_BILDER;
  if (bilder) mkdirSync(bilder, { recursive: true });

  // (1) Der Verlauf spricht jede der fünf Arten — in Kundenwörtern, nie im Vertragswort.
  const werte = page.getByTestId('werte-sektion').or(page.locator('.vp-mss-werte')).first();
  for (const wort of MARKER_WOERTER) await expect(werte.getByText(wort, { exact: false }).first()).toBeVisible();
  for (const roh of ['counter_reset', 'range_limit', 'frozen_source', 'device_restart', 'layout_changed']) {
    await expect(page.getByText(roh, { exact: false })).toHaveCount(0);
  }
  if (bilder) await page.screenshot({ path: join(bilder, `verlauf-marker-${breite}.png`), fullPage: true });

  // (2) Ohne Beleg steht kein Hebel da — ein Dauerhinweis wäre eine Vermutung.
  const abschnitt = page.getByTestId('wago-karte');
  await expect(abschnitt).toContainText('Steckplatz: 5');
  // Das aus der Steuerung gelesene Soll: nur Anzeige, kein Bedienelement.
  await expect(abschnitt).toContainText('Kartenvariante: 25001');
  await expect(abschnitt).toContainText('Controller-Kennung: 8212');
  await expect(page.getByTestId('wago-hebel')).toHaveCount(0);
  if (bilder) await abschnitt.screenshot({ path: join(bilder, `karte-ohne-beleg-${breite}.png`) });

  // (3) Der Dialog: Zeitpunkt, freiwilliger Endstand, Prüfaufgabe.
  await page.getByTestId('wago-karte-tauschen').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('das Gerät bleibt');
  await page.getByTestId('wago-endstand').fill('6.184,37');
  await expect(page.getByTestId('wago-pruefaufgabe')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  if (bilder) await page.screenshot({ path: join(bilder, `dialog-${breite}.png`) });
  await page.getByTestId('wago-kartenwechsel-speichern').click();
  const folgen = page.getByTestId('wago-kartenwechsel-folgen');
  await expect(folgen).toContainText('zählt nicht als Verbrauch');
  await expect(folgen).toContainText('6.184,37 kWh');
  expect(posts).toHaveLength(1);
  if (bilder) await page.screenshot({ path: join(bilder, `dialog-folgen-${breite}.png`) });
  await page.getByRole('button', { name: 'Schließen', exact: true }).last().click();

  // (4) Nach dem Eintrag trägt der Beleg den Hebel — die Angabe ist wieder offen.
  const hebel = page.getByTestId('wago-hebel');
  await expect(hebel).toContainText('Wandler und Anwenderskalierung prüfen');
  await expect(abschnitt).toContainText('Anwenderskalierung: nicht erfasst');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  if (bilder) await abschnitt.screenshot({ path: join(bilder, `karte-mit-beleg-${breite}.png`) });
  expect(errors).toEqual([]);
});
