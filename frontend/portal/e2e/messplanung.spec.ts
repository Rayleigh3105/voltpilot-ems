import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { kostenstellenAhrenberg, ohneProzesse, ohneVerteilung, protokollMs10, prozesseAhrenberg } from '../src/test/messstelleSeiteFixtures';
import { MB1_WORTLAUT, MS23_ID, ms23, ms23Zeile } from '../src/test/messplanungFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import { antwort, MS_10, stundenDes, tagSchritt, viertelstundenDes } from '../src/test/werteKarteFixtures';
import { verschiebe } from '../src/picker/datum';

/**
 * Messplanung (UEMS AP-16 IP-20, §5.3 Schritte 1–3, R5) bei 375 px und 1440 px.
 *
 * - Bühne `e2e/bewertung.html?stand=voll&messplanung=…` (die ECHTE Schale, `BewertungPage`, `EnergieeinsatzSeite` und
 *   der ECHTE Messstellen-Dialog; Routen aus `src/test/messplanungBuehne.ts`): an EE-8 den Bedarf MB-1 erfassen,
 *   „Messstelle einrichten“ → Dialog mit G-1 und Wirkenergie · Bezug vorbelegt → MS-23 eingerichtet, „Später binden“ →
 *   der Bedarf ist eingelöst, „keine Datenquelle seit 27.11.2026“ (nie 0); verwerfen mit Pflicht-Begründung; aus der
 *   Rest-Zeile erfassen; die Liste je Standort.
 * - Bühne `e2e/messstelle-seite.html?id=<MS-23>` (die ECHTE `MessstelleSeite`, Cloud per `page.route`): „geplant für
 *   EE-8 Gebäudetechnik Halle 1“ unter „Keine Datenquelle“.
 * - AP-16 P1 (Befund IP-20): einen offenen Bedarf bearbeiten (Struktur: Ort als ID, Größe aus dem Katalog), sein
 *   Protokoll lesen, und im ECHTEN Register (`messstelle-seite.html?wirt=1`) der Filter „Nur geplant für einen
 *   Energieeinsatz“ (`geplantFuerEinsatz=true`).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente. `IP20_BILDER=<Ordner>` legt je Fall ein Bild ab.
 */

const expect = baseExpect.configure({ timeout: 30_000 });
const BILDER = process.env.IP20_BILDER;
const AM_27_11 = new Date('2026-11-27T09:00:00Z');
const SATZ_EINGELOEST =
  'Messbedarf MB-1: Lüftung, Beleuchtung und Allgemeinstrom Halle 1 — eingelöst durch MS-23 Halle 1 Allgemein (keine Datenquelle seit 27.11.2026).';

async function oeffne(page: Page, pfad: string, breite: number) {
  await page.clock.setFixedTime(AM_27_11);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(pfad);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueber = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-mss *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueber: [...new Set(ueber)] };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueber, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  // Das Modal blendet ein: erst nach dem Ende aller Animationen fotografieren. Eine abgebrochene Animation (die
  // Auswahlliste schließt) verwirft ihr `finished` mit AbortError — sie ist dann ebenso vorbei.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const vp = page.viewportSize();
  if (ganz && vp && vp.width < 720) {
    const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path, fullPage: ganz });
}

const modal = (page: Page) => page.locator('.vp-modal');
const picker = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });

async function waehle(page: Page, feld: string, option: RegExp) {
  const f = picker(page, feld);
  await f.click();
  const id = await f.getAttribute('id');
  const liste: Locator = id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
  await liste.getByRole('option', { name: option }).first().click();
}

/** Die Messstellen-Seite von MS-23: eingerichtet an G-1 ohne Quelle, eingelöst für EE-8. */
async function cloudMs23(page: Page) {
  const m = ms23();
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const pfad = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/messstellen') {
      const r = ahrenbergRegister();
      const register = [...r.register, ms23Zeile()];
      const geplant = url.searchParams.get('geplantFuerEinsatz') === 'true';
      const zeilen = geplant ? register.filter((z) => (z.geplant_fuer_einsaetze ?? []).length > 0) : register;
      return json({ ...r, stichtag: '2026-11-27', zeitpunkt: '2026-11-27T09:00:00Z', register: zeilen,
        messstellen: [...r.messstellen, m].filter((x) => zeilen.some((z) => z.id === x.id)) });
    }
    if (pfad === '/api/v1/unternehmen/prozesse') return json({ stichtag: null, prozesse: prozesseAhrenberg() });
    if (pfad === '/api/v1/unternehmen/kostenstellen') return json({ stichtag: null, kostenstellen: kostenstellenAhrenberg() });
    if (pfad === '/api/v1/standorte') return json(ahrenbergHeute());
    if (pfad.endsWith('/orte')) return json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach());
    if (pfad === `/api/v1/messstellen/${MS23_ID}`) return json(m);
    if (pfad.endsWith('/prozesse')) return json(ohneProzesse(m));
    if (pfad.endsWith('/verteilung')) return json(ohneVerteilung(m));
    if (pfad.endsWith('/aenderungen')) return json(protokollMs10());
    if (pfad.endsWith('/ablesungen')) return json([]);
    // Werte eines Tages: ohne Quelle „keine Werte“ je Schritt (Grund keine_quelle) — nie eine 0.
    if (pfad.endsWith('/werte')) {
      const von = url.searchParams.get('von') ?? '';
      const raster = url.searchParams.get('raster');
      if (!von || url.searchParams.get('bis') !== von) return json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404);
      const leer = () => ({ zustand: 'keine Werte' as const, grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null, versionen: null });
      const werte = raster === 'stunde' ? stundenDes(von, leer) : raster === 'viertelstunde' ? viertelstundenDes(von, leer) : [tagSchritt(von, leer())];
      const ms = { ...MS_10, id: MS23_ID, kennzeichen: 'MS-23', name: 'Halle 1 Allgemein' };
      return json(antwort(ms, raster === 'stunde' || raster === 'viertelstunde' ? raster : 'tag', `${von}T00:00:00+01:00`, `${verschiebe(von, 1)}T00:00:00+01:00`, werte, false));
    }
    if (pfad.endsWith('/quellen')) {
      return json({
        messstelle_id: m.id, kennzeichen: m.kennzeichen, stichtag: '2026-11-27T09:00:00Z', quellen: [],
        groessen: [{ groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand', hauptgroesse: true, lebenszyklus: 'aktiv',
          fuehrend: null, vergleich: [], zeitstrahl: [] }],
      });
    }
    return json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404);
  });
}

for (const breite of [375, 1440]) {
  test.describe(`Messplanung bei ${breite} px`, () => {
    test('Bedarf → Messstelle → „keine Datenquelle“: erfassen an EE-8, einlösen über den Messstellen-Dialog, nie 0', async ({ page }) => {
      await oeffne(page, '/e2e/bewertung.html?stand=voll&messplanung=1&ee=EE-8', breite);
      const karte = page.getByTestId('messplanung-einsatz');
      await expect(karte.getByTestId('messplanung-leer')).toBeVisible();
      await karte.getByRole('button', { name: 'Messbedarf erfassen' }).click();

      // Schritt 1 (§5.3): Wortlaut, Ort, Größe; Frist bleibt optional.
      await modal(page).getByLabel('Was soll gemessen werden?').fill(MB1_WORTLAUT);
      await waehle(page, 'Ort (optional)', /^Halle 1\s*Gebäude/);
      await waehle(page, 'Größe (optional)', /^Wirkenergie/);
      await waehle(page, 'Richtung', /^Bezug/);
      await ablegen(page, `ip20-erfassen-${breite}`);
      await ohneQuerlauf(page, `erfassen-${breite}`);
      await modal(page).getByRole('button', { name: 'Messbedarf erfassen' }).click();

      const mb1 = page.getByTestId('messbedarf-MB-1');
      await expect(mb1.getByTestId('messbedarf-zustand')).toHaveText('offen');
      await expect(mb1).toContainText('G-1 Halle 1 · Wirkenergie · Bezug · erfasst 27.11.2026 · Ines Kaltenbach');
      await ablegen(page, `ip20-liste-${breite}`);

      // Schritt 2: der Sprung in den ECHTEN Messstellen-Dialog — Größe und Ort vorbelegt.
      await mb1.getByRole('button', { name: 'Messstelle einrichten' }).click();
      await expect(modal(page).getByLabel('Kennzeichen')).toHaveValue('MS-23');
      await expect(picker(page, 'Hauptgröße *')).toContainText('Wirkenergie');
      await expect(picker(page, 'Richtung *')).toContainText('Bezug');
      await ablegen(page, `ip20-einloesen-sprung-${breite}`);
      await modal(page).getByLabel('Name *').fill('Halle 1 Allgemein');
      await waehle(page, 'Wertart *', /^Zählerstand/);
      await modal(page).getByRole('button', { name: 'Weiter: Zuordnung' }).click();
      await expect(picker(page, 'Ort')).toContainText('Halle 1');
      await ablegen(page, `ip20-einloesen-ort-${breite}`);
      await ohneQuerlauf(page, `einloesen-ort-${breite}`);
      await modal(page).getByRole('button', { name: 'Weiter: Quelle' }).click();
      await modal(page).getByRole('button', { name: 'Später binden' }).click();
      await expect(modal(page)).toContainText('keine Datenquelle');
      await modal(page).getByRole('button', { name: 'Schließen' }).first().click();

      // Das Kennzeichen kommt zurück: eingelöst durch MS-23, keine Datenquelle seit …, keine Zahl.
      await expect(mb1.getByTestId('messbedarf-satz')).toHaveText(SATZ_EINGELOEST);
      await expect(mb1.getByTestId('messbedarf-zustand')).toHaveText('eingelöst');
      await expect(mb1.getByTestId('messbedarf-messstelle')).toHaveText('MS-23');
      await expect(mb1.getByRole('button', { name: 'Messstelle einrichten' })).toHaveCount(0);
      await mb1.scrollIntoViewIfNeeded();
      await ablegen(page, `ip20-eingeloest-${breite}`);
      await ohneQuerlauf(page, `eingeloest-${breite}`);
    });

    test('verwerfen: nur mit Begründung — der Bedarf bleibt lesbar', async ({ page }) => {
      await oeffne(page, '/e2e/bewertung.html?stand=voll&messplanung=mb1&ee=EE-8', breite);
      const mb1 = page.getByTestId('messbedarf-MB-1');
      await mb1.getByRole('button', { name: 'Verwerfen' }).click();
      await modal(page).getByRole('button', { name: 'Verwerfen' }).click();
      await expect(modal(page)).toContainText('Bitte begründen Sie, warum der Bedarf verworfen wird.');
      await expect(modal(page).getByLabel('Begründung')).toBeFocused();
      await modal(page).getByLabel('Begründung').fill('Zähler wirtschaftlich nicht sinnvoll');
      await ablegen(page, `ip20-verwerfen-${breite}`);
      await modal(page).getByRole('button', { name: 'Verwerfen' }).click();
      await expect(mb1.getByTestId('messbedarf-zustand')).toHaveText('verworfen');
      await expect(mb1.getByTestId('messbedarf-satz')).toHaveText('Verworfen am 27.11.2026: ‚Zähler wirtschaftlich nicht sinnvoll‘');
      await expect(mb1).toContainText(MB1_WORTLAUT);
      await mb1.scrollIntoViewIfNeeded();
      await ablegen(page, `ip20-verworfen-${breite}`);
      await ohneQuerlauf(page, `verworfen-${breite}`);
    });

    test('Rest-Zeile und Liste je Standort: aus „Rest Halle 1“ einen Bedarf an EE-8 erfassen; beide stehen unter Werk Ahrenberg', async ({ page }) => {
      await oeffne(page, '/e2e/bewertung.html?stand=voll&messplanung=mb1', breite);
      const liste = page.getByTestId('messplanung-standorte');
      await expect(liste.getByTestId('messbedarf-MB-1')).toBeVisible();
      await expect(liste.getByTestId('messplanung-standort-Werk Ahrenberg')).toContainText('EE-8 Gebäudetechnik Halle 1');
      await liste.scrollIntoViewIfNeeded();
      await ablegen(page, `ip20-liste-standort-${breite}`);

      await page.getByTestId('messabdeckung-einsaetze').getByTestId('messabdeckung-rest-erfassen').first().click();
      await expect(modal(page).getByLabel('Was soll gemessen werden?')).toHaveValue(/^Rest Halle 1: 54\.580\s?kWh \(39,2\s?% der Anlage\) — keinem Energieeinsatz zugeordnet$/);
      await expect(picker(page, 'Ort (optional)')).toContainText('Werk Ahrenberg');
      await waehle(page, 'Energieeinsatz', /^EE-8 Gebäudetechnik Halle 1/);
      await ablegen(page, `ip20-rest-erfassen-${breite}`);
      await ohneQuerlauf(page, `rest-erfassen-${breite}`);
      await modal(page).getByRole('button', { name: 'Messbedarf erfassen' }).click();
      await expect(liste.getByTestId('messbedarf-MB-2')).toContainText('Rest Halle 1');
      await expect(liste.getByTestId('messplanung-standort-Werk Ahrenberg').getByTestId('messbedarf-zum-einsatz')).toHaveCount(2);
      await ohneQuerlauf(page, `liste-standort-${breite}`);
    });

    test('AP-16 P1: MB-1 bearbeiten — vorbelegt aus dem Wortlaut, gespeichert mit Struktur; das Protokoll nennt vorher → nachher', async ({ page }) => {
      await oeffne(page, '/e2e/bewertung.html?stand=voll&messplanung=mb1&ee=EE-8', breite);
      const karte = page.getByTestId('messplanung-einsatz');
      const mb1 = karte.getByTestId('messbedarf-MB-1');
      await mb1.getByRole('button', { name: 'Bearbeiten' }).click();
      await expect(modal(page).getByTestId('messbedarf-bearbeiten')).toBeVisible();
      await expect(modal(page).getByLabel('Was soll gemessen werden?')).toHaveValue(MB1_WORTLAUT);
      await expect(picker(page, 'Ort (optional)')).toContainText('Halle 1');
      await expect(picker(page, 'Größe (optional)')).toContainText('Wirkenergie');
      await waehle(page, 'Ort (optional)', /^Halle 1 Nord\s*Bereich/);
      await ablegen(page, `ap16-bearbeiten-${breite}`);
      await ohneQuerlauf(page, `bearbeiten-${breite}`);
      await modal(page).getByRole('button', { name: 'Speichern' }).click();
      await expect(modal(page)).toHaveCount(0);
      await expect(mb1).toContainText('Halle 1 Nord');
      await expect(mb1.getByTestId('messbedarf-zustand')).toHaveText('offen');

      await mb1.getByRole('button', { name: 'Protokoll' }).click();
      const protokoll = modal(page).getByTestId('messbedarf-protokoll');
      await expect(protokoll.getByTestId('messbedarf-protokoll-eintrag')).toHaveCount(2);
      await expect(protokoll.getByTestId('messbedarf-protokoll-eintrag').nth(1)).toContainText('bearbeitet');
      await expect(protokoll.getByTestId('messbedarf-protokoll-eintrag').nth(1)).toContainText(/Ort: „G-1“ → „B-\d+“/);
      await ablegen(page, `ap16-protokoll-${breite}`);
      await ohneQuerlauf(page, `protokoll-${breite}`);
    });

    test('AP-16 P1: im Register „Nur geplant für einen Energieeinsatz“ — nur MS-23, die Adresse fragt geplantFuerEinsatz=true', async ({ page }) => {
      await cloudMs23(page);
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/api/v1/messstellen') anfragen.push(new URL(r.url()).search);
      });
      await oeffne(page, '/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen', breite);
      const schalter = page.getByTestId('register-filter-geplant');
      await expect(schalter).toHaveText('Nur geplant für einen Energieeinsatz (1)');
      await schalter.click();
      await expect(schalter).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => anfragen.some((q) => q.includes('geplantFuerEinsatz=true'))).toBe(true);
      await expect(page.getByText('MS-23').first()).toBeVisible();
      await expect(page.getByText('MS-21')).toHaveCount(0);
      await ablegen(page, `ap16-register-geplant-${breite}`);
      await ohneQuerlauf(page, `register-geplant-${breite}`);
    });

    test('Messstellen-Seite: „geplant für EE-8 …“ unter „Keine Datenquelle“ — ohne Wert, nie 0', async ({ page }) => {
      await cloudMs23(page);
      await oeffne(page, `/e2e/messstelle-seite.html?id=${MS23_ID}`, breite);
      const kopf = page.locator('.vp-mss-kopf');
      await expect(kopf.getByTestId('messstelle-geplant-fuer')).toHaveText('geplant für EE-8 Gebäudetechnik Halle 1');
      await expect(kopf).toContainText(/keine Datenquelle/i);
      await expect(kopf).not.toContainText(/\b0\s?kWh/);
      await ablegen(page, `ip20-messstelle-geplant-${breite}`);
      await ohneQuerlauf(page, `messstelle-geplant-${breite}`);
    });
  });
}
