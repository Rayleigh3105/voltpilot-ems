import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { komponentenHalle1 } from '../src/test/messstelleDialogFixtures';
import { kostenstellenAhrenberg, prozesseAhrenberg, protokollMs06 } from '../src/test/messstelleSeiteFixtures';
import { ahrenbergDatenquellen, ahrenbergUemsGeraete } from '../src/test/datenquellenFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import {
  ANLAGE_AN1,
  JETZT,
  JETZT_NACH_WECHSEL,
  K1_ID,
  K3_ID,
  kanaeleK1,
  kanaeleK3,
  MS01_ID,
  MS06_ID,
  ms01,
  quellenMs01,
  quellenMs06,
} from '../src/test/quelleBindenFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';

const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * UEMS AP-04 IP-14 · „Quelle binden“ am echten Baustein (Bühnen `messstelle-seite.html` und
 * `geraet-herkunft.html`), alle Zahlen und Kennzeichen aus dem Referenzunternehmen Ahrenberg:
 *
 * - Q1 — die Quelle-Karte an MS-01: führend 312,4 kW und Vergleich 309,8 kW NEBENEINANDER (E3, A8).
 * - Q2 — „Quelle binden“: nur Passendes wählbar, das Übrige GRAU MIT GRUND.
 * - Q3 — „Vergleichsquelle hinzufügen“ mit ihrem Zweck.
 * - Q4 — die Historie an MS-06: Z-5a, die sichtbare Lücke, Z-5b.
 * - Q5 — „Als Messstelle verwenden“ an der Komponente: derselbe Dialog, andersherum.
 *
 * Misst bei jedem Bild: Dokument und Dialog 0 px Querlauf, kein Element über dem Rand.
 * `mobile-chromium` fährt 375 px (Pflicht des Reports), `desktop-chromium` 1440 px.
 * Mit `QUELLE_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild und `messung-*.json` ab.
 */

const BILDER = process.env.QUELLE_BILDER;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Gesendet {
  methode: string;
  pfad: string;
  body: unknown;
}

/** Die gestellte Cloud beider Bühnen — Ahrenberg, Stand 20.10.2026 bzw. nach dem Wechsel. */
async function cloud(page: Page, { nachWechsel = false } = {}): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pfad = url.pathname;
    const methode = req.method();
    if (methode !== 'GET') gesendet.push({ methode, pfad, body: req.postDataJSON() });

    if (pfad === '/api/v1/unternehmen/prozesse') return route.fulfill(json({ stichtag: null, prozesse: prozesseAhrenberg() }));
    if (pfad === '/api/v1/unternehmen/kostenstellen') {
      return route.fulfill(json({ stichtag: null, kostenstellen: kostenstellenAhrenberg() }));
    }
    if (pfad === '/api/v1/standorte') return route.fulfill(json(ahrenbergHeute()));
    // AP-13 IP-12 (L6): die Zuständigkeiten der Datenquellen und der Weg Gerät → Quelle (zwei Aufrufe je Anlage).
    const anlage = /^\/api\/v1\/sites\/([^/]+)\/(data-sources|geraete)$/.exec(pfad);
    if (anlage && methode === 'GET') {
      return route.fulfill(
        json(anlage[2] === 'data-sources' ? ahrenbergDatenquellen(anlage[1], new Date().toISOString()) : ahrenbergUemsGeraete(anlage[1])),
      );
    }
    if (pfad.endsWith('/orte')) return route.fulfill(json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    if (pfad === '/api/v1/messstellen' && methode === 'GET') {
      return route.fulfill(json(ahrenbergRegister({ stichtag: nachWechsel ? '2026-11-20' : '2026-10-20' })));
    }
    if (pfad.endsWith('/quellen') && methode === 'GET') {
      return route.fulfill(json(pfad.includes(MS06_ID) ? quellenMs06() : quellenMs01()));
    }
    if (pfad.endsWith('/quellen') && methode === 'POST') {
      return route.fulfill(json({ quelle: quellenMs01().quellen[2], beendet: null, rueckwirkung: { art: 'ab_jetzt', minuten: 0, abzeichen: null }, hinweise: [] }, 201));
    }
    if (pfad.endsWith('/entities')) return route.fulfill(json(komponentenHalle1()));
    const kanaele = /\/komponenten\/([^/]+)\/messkanaele$/.exec(pfad);
    if (kanaele) {
      return route.fulfill(json({
        site_id: ANLAGE_AN1,
        komponente: kanaele[1],
        inhaltsstand: '2026.09.16.1',
        messkanaele: kanaele[1] === K1_ID ? kanaeleK1() : kanaeleK3(),
      }));
    }
    const werte = /^\/api\/v1\/messstellen\/([^/]+)\/werte$/.exec(pfad);
    if (werte && methode === 'GET') return route.fulfill(json(tagesWerte(decodeURIComponent(werte[1]), url.searchParams)));
    if (pfad.endsWith('/prozesse') && methode === 'GET') return route.fulfill(json({ messstelle_id: MS01_ID, stichtag: null, prozesse: [] }));
    if (pfad.endsWith('/verteilung') && methode === 'GET') return route.fulfill(json({ messstelle_id: MS01_ID, stichtag: null, anteile: [] }));
    if (pfad.endsWith('/aenderungen')) return route.fulfill(json(protokollMs06()));
    if (/^\/api\/v1\/messstellen\/[^/]+$/.test(pfad) && methode === 'GET') return route.fulfill(json(ms01()));
    return route.fulfill(json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
  });
  return gesendet;
}

/**
 * Der Abschnitt „Werte“ über der Quelle-Karte braucht eine Antwort — sonst stünde im Bild ein
 * Ladefehler, und der Captain sähe im Foto etwas, das nicht zur Sache gehört. Eine schlichte
 * Tagesreihe in der Zeitzone des Standorts genügt; geprüft wird sie hier nicht.
 */
function tagesWerte(kennzeichen: string, p: URLSearchParams) {
  const von = p.get('von') ?? '2026-10-20';
  const bis = p.get('bis') ?? von;
  const m = kennzeichen === 'MS-06' ? { id: MS06_ID, name: 'Spritzguss SG01–SG06' } : { id: MS01_ID, name: 'Netzbezug Halle 1' };
  return {
    messstelle: { ...m, kennzeichen, art: 'gemessen', groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    raster: p.get('raster') ?? 'tag',
    von,
    bis,
    zeitzone: 'Europe/Berlin',
    zeitzone_herkunft: 'standort',
    version: null,
    quellen: [],
    werte: [
      {
        von: `${von}T00:00:00+02:00`,
        bis: `${bis}T00:00:00+02:00`,
        beschriftung: null,
        stunden: 24,
        tagesdauer: null,
        menge: 6120,
        mittel: null,
        min: null,
        max: null,
        zustand: 'vollständig',
        kennzeichen: [],
        erhalten: 96,
        erwartet: 96,
        abdeckung_prozent: 100,
        fassung: 'endgueltig',
        endgueltig_ab: `${von}T00:00:00+02:00`,
        gebildet_aus: 'viertelstunde',
        quelle: null,
        grund: null,
        ereignisse: [],
        herkunft: null,
        versionen: 1,
      },
    ],
  };
}

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-mss *, .vp-modal *, .vp-gh *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = document.querySelector('.vp-modal .dbody') as HTMLElement | null;
    return {
      dokument: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
      draussen,
      inhaltHoehe: koerper ? koerper.scrollHeight : null,
      sichtHoehe: koerper ? koerper.clientHeight : null,
    };
  }, breite);
}

async function ruhig(page: Page) {
  const modal = page.locator('.vp-modal');
  if (await modal.count()) await expect(modal.last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function messeUndFotografiere(page: Page, breite: number, name: string, { dialog = false } = {}) {
  await ruhig(page);
  const m = await messe(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  if (!dialog) {
    await page.screenshot({ path: join(BILDER, `${datei}.png`), fullPage: true });
    return;
  }
  const vorher = page.viewportSize()!;
  if (m.inhaltHoehe && m.sichtHoehe && m.inhaltHoehe > m.sichtHoehe) {
    await page.setViewportSize({ width: breite, height: vorher.height + (m.inhaltHoehe - m.sichtHoehe) + 40 });
    await ruhig(page);
  }
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  await page.setViewportSize(vorher);
}

/** Die Liste DIESES Felds — eine eben geschlossene blendet noch aus und steht solange im DOM. */
async function listeVon(page: Page, feld: Locator): Promise<Locator> {
  await feld.click();
  const id = await feld.getAttribute('id');
  return id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
}

const breiteFuer = (projekt: string) => (projekt.startsWith('mobile') ? 375 : 1440);

async function oeffne(page: Page, breite: number, id: string, opt: { nachWechsel?: boolean } = {}) {
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page, opt);
  await page.goto(`/e2e/messstelle-seite.html?id=${id}`);
  return gesendet;
}

test('Q1 · A8 — die Quelle-Karte zeigt beide Werte NEBENEINANDER, ohne jede Bewertung', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await oeffne(page, breite, MS01_ID);

  await expect(page.getByRole('heading', { level: 1, name: 'Netzbezug Halle 1' })).toBeVisible();
  const karte = page.getByTestId('quelle-karte');
  const leistung = karte.getByTestId('quelle-groesse-Wirkleistung|Bezug');
  await expect(leistung.getByText('Nebengröße · Wirkleistung · Bezug')).toBeVisible();
  const werte = leistung.getByTestId('quelle-werte').locator('li');
  await expect(werte).toHaveCount(2);
  await expect(werte.nth(0)).toContainText('312,4');
  await expect(werte.nth(0)).toContainText('Netzzähler Halle 1 · GR-2 · Wirkleistung');
  await expect(werte.nth(0)).toContainText('liest den Bezugs-Teil des Werts');
  await expect(werte.nth(1)).toContainText('309,8');
  await expect(werte.nth(1)).toContainText('Vergleich · Plausibilität');
  await expect(leistung.getByText('Beide Werte stehen nebeneinander; keiner ersetzt den anderen. Liefern beide eine Monatsmenge, steht darunter die Abweichung gegen Ihre Toleranz — ohne Ursache.')).toBeVisible();

  // E3 — sie stehen wirklich NEBENEINANDER, nicht untereinander: gleiche Oberkante, verschiedene Spalte.
  const a = await werte.nth(0).boundingBox();
  const b = await werte.nth(1).boundingBox();
  expect(Math.abs(a!.y - b!.y), 'gleiche Zeile').toBeLessThan(2);
  expect(b!.x, 'zweite Spalte').toBeGreaterThan(a!.x + a!.width - 2);

  // Die Hauptgröße hat keine Vergleichsquelle — der Leerzustand sagt es und nennt den Weg.
  const haupt = karte.getByTestId('quelle-groesse-Wirkenergie|Bezug');
  await expect(haupt).toContainText('Keine Vergleichsquelle.');
  await expect(haupt.getByRole('button', { name: 'Vergleichsquelle hinzufügen' })).toBeVisible();

  // AP-13 IP-12 (L6): die führende Quelle nennt die Box, die ihr Gerät liest — aus der Zuständigkeit
  // der Datenquelle (GR-2 → DQ-2 → Box Halle 1). Die Vergleichsquelle hängt an GR-1 (DQ-1, dieselbe Box).
  await expect(werte.nth(0).locator('.vp-qk-box')).toHaveText('gelesen von Box Halle 1 seit 12.03.2024');
  await expect(haupt.getByTestId('quelle-werte').locator('li').first().locator('.vp-qk-box')).toHaveText(
    'gelesen von Box Halle 1 seit 12.03.2024',
  );
  await messeUndFotografiere(page, breite, 'q1-quelle-karte');
});

test('Q2 · „Quelle binden“ — was nicht passt, steht GRAU mit seinem Grund', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  const gesendet = await oeffne(page, breite, MS01_ID);
  const leistung = page.getByTestId('quelle-groesse-Wirkleistung|Bezug');
  await expect(leistung).toBeVisible();

  // An der Hauptgröße läuft eine Quelle — dort steht „Quelle binden“ NICHT. Wir nehmen den
  // Vergleichs-Einstieg derselben Größe: derselbe Dialog, dieselbe Auswahl mit denselben Gründen.
  await leistung.getByRole('button', { name: 'Vergleichsquelle hinzufügen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vergleichsquelle hinzufügen' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('quelle-ziel')).toContainText('MS-01 · Wirkleistung · Bezug · kW · Momentanwert');

  // Angeboten werden NUR die Komponenten der eigenen Anlage — MS-01 ist Hauptzähler von AN-1.
  const komponenten = await listeVon(page, dialog.getByRole('combobox', { name: 'Komponente' }));
  await expect(komponenten.getByRole('option')).toHaveCount(2);
  await komponenten.getByRole('option', { name: /Netzzähler Halle 1/ }).click();
  const messwerte = await listeVon(page, dialog.getByRole('combobox', { name: 'Messwert' }));
  const zeilen = messwerte.getByRole('option');
  await expect(zeilen).toHaveCount(4);
  await expect(zeilen.nth(0)).toContainText('Wirkleistung');
  await expect(zeilen.nth(0)).toContainText('liest den Bezugs-Teil des Werts');
  await expect(zeilen.nth(0)).not.toHaveAttribute('aria-disabled', 'true');
  // Die drei anderen verschwinden nicht — sie sind grau und sagen warum.
  for (const i of [1, 2, 3]) {
    await expect(zeilen.nth(i)).toHaveAttribute('aria-disabled', 'true');
    await expect(zeilen.nth(i)).toContainText('nicht liefern');
  }
  await messeUndFotografiere(page, breite, 'q2-messwert-ausgegraut', { dialog: true });

  await zeilen.nth(0).click();
  const zweck = await listeVon(page, dialog.getByRole('combobox', { name: 'Zweck *' }));
  await expect(zweck.getByRole('option')).toHaveCount(3);
  await zweck.getByRole('option', { name: /Plausibilität/ }).click();
  await expect(dialog.getByTestId('quelle-folgen')).toContainText('vergleicht ab');
  await expect(dialog.getByTestId('quelle-folgen')).toContainText('Beide Werte stehen nebeneinander; keiner ersetzt den anderen. Liefern beide eine Monatsmenge, steht darunter die Abweichung gegen Ihre Toleranz — ohne Ursache.');
  await messeUndFotografiere(page, breite, 'q3-vergleichsquelle-zweck', { dialog: true });

  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.getByTestId('quelle-gebunden')).toBeVisible();
  expect(gesendet.map((g) => `${g.methode} ${g.pfad}`)).toEqual([`POST /api/v1/messstellen/${MS01_ID}/quellen`]);
  expect(gesendet[0].body).toMatchObject({
    groesse: { groesse: 'Wirkleistung', richtung: 'Bezug' },
    komponente: K3_ID,
    kanal: 'sunspec.model_203.w',
    rolle: 'vergleich',
    zweck: 'Plausibilität',
    anteil: 'positiv',
  });
});

test('Q4 · die Historie an MS-06 — Z-5a, die sichtbare Lücke, Z-5b', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await oeffne(page, breite, MS06_ID, { nachWechsel: true });

  const karte = page.getByTestId('quelle-groesse-Wirkenergie|Bezug');
  await expect(karte.getByText('Historie (3)')).toBeVisible();
  await karte.getByText('Historie (3)').click();
  const zeilen = karte.locator('.vp-qk-h');
  await expect(zeilen).toHaveCount(3);
  await expect(zeilen.nth(0)).toContainText('GR-4 Z-5b');
  await expect(zeilen.nth(0)).toContainText('gilt heute');
  await expect(zeilen.nth(1)).toContainText('Lücke');
  await expect(zeilen.nth(1)).toContainText('18.11.2026, 10:40 Uhr bis 18.11.2026, 10:47 Uhr');
  await expect(zeilen.nth(2)).toContainText('GR-4 Z-5a');
  await messeUndFotografiere(page, breite, 'q4-historie-luecke');
});

test('Q5 · „Als Messstelle verwenden“ an der Komponente — derselbe Dialog, andersherum', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/geraet-herkunft.html?fall=gr4');

  // Die Sektion „Komponenten“ ist zugeklappt — wie auf der echten Geräteseite.
  const sektion = page.getByTestId('sektion-komponenten');
  await sektion.locator(':scope > summary').click();
  const kanaele = sektion.getByTestId('geraet-messkanaele');
  await expect(kanaele).toBeVisible();
  // Nur der Messwert, den noch keine Messstelle FÜHREND liest, trägt den Einstieg.
  const knopf = page.getByTestId('als-messstelle-verwenden');
  await expect(knopf).toHaveCount(1);
  await knopf.click();

  const dialog = page.getByRole('dialog', { name: 'Quelle binden' });
  await expect(dialog).toBeVisible();
  // Die Kundenwörter, nie das Katalogwort `counter`.
  await expect(dialog.getByTestId('quelle-messwert')).toHaveText('Wirkenergie Abgabe · Zählerstand · kWh · alle 15 min');
  const ziele = await listeVon(page, dialog.getByRole('combobox', { name: 'Messstelle und Messgröße' }));
  const zeilen = ziele.getByRole('option');
  await expect(zeilen.first()).toContainText('MS-02 · Netzeinspeisung Halle 1');
  // Eine Größe, die diesen Messwert nicht nehmen kann, steht ebenfalls da — grau, mit Grund.
  const gesperrt = zeilen.filter({ hasText: 'MS-01' }).first();
  await expect(gesperrt).toHaveAttribute('aria-disabled', 'true');
  await expect(gesperrt).toContainText('nicht liefern');
  await messeUndFotografiere(page, breite, 'q5-als-messstelle-verwenden', { dialog: true });
});

/**
 * Hausregel „zwei Varianten“: WIE die beiden Werte bei 375 px stehen sollen, ist eine Frage an den
 * Captain. Im Code steht Variante A (nebeneinander, Q1); dieser Lauf fotografiert zusätzlich
 * Variante B (untereinander) — allein über eine eingespielte Regel, ohne eine Zeile Produktcode.
 */
test('Q1b · Variante B zur Wahl: dieselbe Karte, die Werte untereinander', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await oeffne(page, breite, MS01_ID);
  await expect(page.getByTestId('quelle-karte')).toBeVisible();
  await page.addStyleTag({ content: '.vp-qk-werte { grid-template-columns: 1fr !important; }' });

  const werte = page.getByTestId('quelle-groesse-Wirkleistung|Bezug').getByTestId('quelle-werte').locator('li');
  const a = await werte.nth(0).boundingBox();
  const b = await werte.nth(1).boundingBox();
  expect(b!.y, 'Variante B: der Vergleich steht UNTER der führenden Quelle').toBeGreaterThan(a!.y + a!.height - 2);
  await messeUndFotografiere(page, breite, 'q1b-variante-b-gestapelt');
});
