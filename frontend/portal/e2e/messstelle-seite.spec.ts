import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EINFUEHRUNG_TAG,
  kostenstellenAhrenberg,
  MS_IDS,
  ms06,
  ms08Angelegt,
  ms08OrtGeplant,
  ms08Vorher,
  ms10,
  ohneProzesse,
  ohneVerteilung,
  protokollMs06,
  protokollMs08Angelegt,
  protokollMs08OrtGeplant,
  protokollMs08Vorher,
  protokollMs10,
  prozesseAhrenberg,
  SEITE_HEUTE,
  prozesseVon,
  verteilungVon,
} from '../src/test/messstelleSeiteFixtures';
import type { MessstelleWerte } from '../src/api';
import { verschiebe } from '../src/picker/datum';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import { f13Stunden, f13Tag, grundlastStunden, grundlastTag } from '../src/test/werteKarteFixtures';
import { f21Stunden, f21Tag, f21TagWert } from '../src/test/wertVersionenFixtures';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ersten Zugriff kalt — großzügige Frist.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * UEMS AP-04 IP-8 · die Messstellen-Seite am echten Baustein (Bühne `messstelle-seite.html`):
 * R2 — MS-06 mit drei Zuordnungs-Karten und dem Protokoll nach der Eintragung; Z4 — „Ort ändern“
 * für MS-08 ab 01.03.2027 („geplant“), gespeichert, Historie der Karte aus der Antwort; dazu das
 * Kennzeichen „rückwirkend (19 Tage)“ im Dialog „Prozesse ändern“. Misst bei jedem Bild: Dokument
 * und Dialog 0 px Querlauf, kein Element über dem Rand. `mobile-chromium` fährt 375 px (Pflicht des
 * Reports), `desktop-chromium` 1440 px. Mit `MESSSTELLE_SEITE_BILDER=<Ordner>` legt der Lauf je
 * Schritt ein Bild und `messung-*.json` ab.
 */

const BILDER = process.env.MESSSTELLE_SEITE_BILDER;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Gesendet {
  methode: string;
  pfad: string;
  body: unknown;
}

/**
 * Die Route „Werte je Messstelle“ der Bühne (UEMS AP-13 IP-3): MS-06 am 25.10.2026 ist F13, jeder andere Tag die
 * Grundlast derselben Stunde (endgültig ab dem achten Tag nach seinem Beginn); MS-10 am 03.11.2026 ist F21 in der
 * Version der Anfrage. Alles andere ist nicht gestellt (404).
 */
function werteAntwort(kz: string, p: URLSearchParams, heute: string): MessstelleWerte | null {
  const raster = p.get('raster');
  const von = p.get('von') ?? '';
  if (raster !== 'tag' && raster !== 'stunde') return null;
  if (kz === 'MS-06' && von === '2026-10-25') return raster === 'tag' ? f13Tag() : f13Stunden();
  if (kz === 'MS-06' && p.get('bis') === von) {
    const fassung = verschiebe(von, 8) <= heute ? 'endgueltig' : 'vorlaeufig';
    return raster === 'tag' ? grundlastTag(von, fassung) : grundlastStunden(von, fassung);
  }
  if (kz === 'MS-10' && von === '2026-11-03') {
    if (raster === 'stunde') return f21Stunden();
    const v = Number(p.get('version') ?? '3');
    return v === 1 || v === 2 || v === 3 ? { ...f21Tag(), version: p.get('version') ? v : null, werte: [f21TagWert(v)] } : null;
  }
  return null;
}

/** `angelegt`: MS-08 am 01.10.2026, eben angelegt (heute = Stichtag der Einführung); `heute`: der Stichtag des Registers. */
async function cloud(page: Page, { angelegt = false, heute = null as string | null } = {}): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  let gespeichert = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pfad = url.pathname;
    const methode = req.method();
    if (methode !== 'GET') gesendet.push({ methode, pfad, body: req.postDataJSON() });

    const ms08 = () => (angelegt ? ms08Angelegt() : gespeichert ? ms08OrtGeplant() : ms08Vorher());
    const messstelle = pfad.includes(MS_IDS.ms06) ? ms06() : pfad.includes(MS_IDS.ms10) ? ms10() : ms08();

    if (pfad === '/api/v1/unternehmen/prozesse') return route.fulfill(json({ stichtag: null, prozesse: prozesseAhrenberg() }));
    if (pfad === '/api/v1/unternehmen/kostenstellen') {
      return route.fulfill(json({ stichtag: null, kostenstellen: kostenstellenAhrenberg() }));
    }
    if (pfad === '/api/v1/standorte') return route.fulfill(json(ahrenbergHeute()));
    if (pfad.endsWith('/orte')) return route.fulfill(json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    if (pfad === '/api/v1/messstellen' && methode === 'GET') {
      const register = angelegt ? { ...ahrenbergRegister(), stichtag: EINFUEHRUNG_TAG } : heute ? ahrenbergRegister({ stichtag: heute }) : ahrenbergRegister();
      return route.fulfill(json(register));
    }
    const hauptzaehler = messstelle.kennzeichen === 'MS-10';
    if (pfad.endsWith('/prozesse') && methode === 'GET') return route.fulfill(json(hauptzaehler ? ohneProzesse(messstelle) : prozesseVon(messstelle)));
    if (pfad.endsWith('/verteilung') && methode === 'GET') return route.fulfill(json(hauptzaehler ? ohneVerteilung(messstelle) : verteilungVon(messstelle)));
    if (pfad.endsWith('/aenderungen')) {
      const protokoll = pfad.includes(MS_IDS.ms10)
        ? protokollMs10()
        : pfad.includes(MS_IDS.ms06)
        ? protokollMs06()
        : angelegt
          ? protokollMs08Angelegt()
          : gespeichert
          ? protokollMs08OrtGeplant()
          : protokollMs08Vorher();
      return route.fulfill(json(protokoll));
    }
    if (pfad.endsWith('/ort') && methode === 'PUT') {
      gespeichert = true;
      return route.fulfill(json(ms08OrtGeplant()));
    }
    const werte = /^\/api\/v1\/messstellen\/([^/]+)\/werte$/.exec(pfad);
    if (werte && methode === 'GET') {
      const antwort = werteAntwort(decodeURIComponent(werte[1]), url.searchParams, heute ?? SEITE_HEUTE);
      return route.fulfill(antwort ? json(antwort) : json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
    }
    if (/^\/api\/v1\/messstellen\/[^/]+$/.test(pfad) && methode === 'GET') return route.fulfill(json(messstelle));
    return route.fulfill(json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
  });
  return gesendet;
}

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-mss *, .vp-modal *')]
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
  // Der ganze Dialog: das Fenster so hoch wie sein Inhalt, damit nichts im Scrollbereich fehlt.
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

async function waehleTag(page: Page, dialog: Locator, iso: string) {
  const feld = dialog.getByRole('combobox', { name: 'Gilt ab *' });
  const [t, m, j] = ((await feld.textContent()) ?? '').match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 40 && !(await tag.isVisible()); i++) await page.getByRole('button', { name: richtung }).click();
  await tag.click();
}

const breiteFuer = (projekt: string) => (projekt.startsWith('mobile') ? 375 : 1440);

test('R2 · MS-06: drei Zuordnungs-Karten und das Protokoll nach der Eintragung, ohne Querlauf', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  await expect(page.getByRole('heading', { level: 1, name: 'Spritzguss SG01–SG06' })).toBeVisible();
  const ort = page.getByTestId('karte-ort');
  await expect(ort.getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024')).toBeVisible();
  await expect(page.getByTestId('karte-elektrisch').getByText('Unterzähler von MS-01')).toBeVisible();
  await expect(page.getByTestId('karte-organisation').getByText('4100 Spritzguss · 100 %')).toBeVisible();
  await expect(page.getByText('Sortiert danach, wann die Änderung eingetragen wurde.')).toBeVisible();
  await expect(page.locator('.vp-befehl').first()).toContainText('Quelle gebunden: Z-5a');
  await messeUndFotografiere(page, breite, 'r2-ms06');
});

test('Z4 · MS-08: Ort ändern ab 01.03.2027 → geplant → gespeichert, Historie aus der Antwort', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms08}`);

  await expect(page.getByRole('heading', { level: 1, name: 'Kühlung Kaltwassersatz' })).toBeVisible();
  await expect(page.getByTestId('karte-ort').getByText('Halle 1 Süd')).toBeVisible();
  await messeUndFotografiere(page, breite, 'z4-ms08-vorher');

  await page.getByRole('button', { name: 'Ort ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ort ändern' });
  await expect(dialog).toBeVisible();
  const ortListe = await listeVon(page, dialog.getByRole('combobox', { name: 'Neuer Ort *' }));
  await ortListe.getByRole('option', { name: /^Halle 2 Montage/ }).click();
  await waehleTag(page, dialog, '2027-03-01');
  const folgen = dialog.getByTestId('zuordnung-folgen');
  await expect(folgen).toContainText('geplant');
  await expect(folgen).toContainText('Ab 01.03.2027 gehört MS-08 zu Halle 2 Montage (B-3); bis 28.02.2027 bleibt es bei Halle 1 Süd (B-2).');
  await expect(dialog.getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024 — endet 28.02.2027')).toBeVisible();
  await messeUndFotografiere(page, breite, 'z4-ort-aendern-geplant', { dialog: true });

  await dialog.getByRole('button', { name: 'Ort ab 01.03.2027 eintragen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ort = page.getByTestId('karte-ort');
  await expect(ort.getByText('Ort ab 01.03.2027 eingetragen · geplant.')).toBeVisible();
  await expect(ort.getByText('ab 01.03.2027: Halle 2 Montage')).toBeVisible();
  await ort.getByText('Historie (2)').click();
  await expect(ort.locator('.vp-mss-h').first()).toContainText('Halle 2 Montage');
  await expect(page.locator('.vp-befehl').first()).toContainText('Ort zugeordnet: B-3');
  await expect(page.locator('.vp-befehl').first()).toContainText('angekündigt');
  await messeUndFotografiere(page, breite, 'z4-ms08-nachher');

  expect(gesendet.map((g) => `${g.methode} ${g.pfad}`)).toEqual([`PUT /api/v1/messstellen/${MS_IDS.ms08}/ort`]);
  expect(gesendet[0].body).toEqual({ kennzeichen: 'B-3', gueltig_ab: '2027-03-01' });
});

test('rückwirkend · MS-08 am 01.10.2026: Ort ab 12.03.2024 trägt „rückwirkend (933 Tage)“, bevor gespeichert ist', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page, { angelegt: true });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms08}`);

  await expect(page.getByTestId('karte-ort').getByText('Kein Ort zugeordnet')).toBeVisible();
  await page.getByRole('button', { name: 'Ort ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ort ändern' });
  await expect(dialog).toBeVisible();
  const ortListe = await listeVon(page, dialog.getByRole('combobox', { name: 'Neuer Ort *' }));
  await ortListe.getByRole('option', { name: /^Halle 1 Süd/ }).click();
  await waehleTag(page, dialog, '2024-03-12');
  const folgen = dialog.getByTestId('zuordnung-folgen');
  await expect(folgen).toContainText('rückwirkend (933 Tage)');
  await expect(folgen).toContainText('Für die Tage vom 12.03.2024 bis 30.09.2026 gilt das nachträglich.');
  await messeUndFotografiere(page, breite, 'rueckwirkend-ort', { dialog: true });
  expect(gesendet).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------------
// UEMS AP-13 IP-3 · die Werte an der Messstelle: O14 (Zone und 25-Stunden-Tag) und O13 (der Einstieg aus dem Register)
// ------------------------------------------------------------------------------------------------------------------

/** Ein Bild nur des Abschnitts „Werte“ — für die Ansicht, neben dem Bild der ganzen Seite. */
async function werteBild(werte: Locator, breite: number, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await werte.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

const werteZeile = (werte: Locator, name: string) =>
  werte.getByTestId('werte-zeile').filter({ has: werte.page().locator('.vp-wk-zeile-name', { hasText: new RegExp(`^${name}$`) }) });

const adresse = (hash: string) => new RegExp(`${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

test('O14 · MS-06 am 26.10.2026: „Werte“ unter dem Kopf — Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg), der 25-Stunden-Tag mit MESZ und MEZ', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-10-26' });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByRole('heading', { level: 2, name: 'Werte' })).toBeVisible();
  // Claudia öffnet MS-06 am 26.10.2026 — die Sektion zeigt den Vortag, den Sonntag der Zeitumstellung.
  const karte = werte.getByTestId('werte-karte');
  await expect(karte).toContainText(/720\skWh/);
  await expect(karte).toContainText('25 Stunden (Zeitumstellung)');
  await expect(karte.getByTestId('werte-fassung')).toHaveText('endgültig');
  await expect(werte.getByTestId('werte-zone')).toHaveText('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)');
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(25);
  await expect(werteZeile(werte, '02:00–03:00 MESZ')).toHaveCount(1);
  await expect(werteZeile(werte, '02:00–03:00 MEZ')).toHaveCount(1);
  await expect(werteZeile(werte, '02:00–03:00 MEZ')).toContainText(/28,8\skWh/);

  // Unter dem Kopf, vor den Zuordnungs-Karten — EIN Ort für Stammdaten und Zahlen (E9).
  const unten = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().bottom);
  const oben = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top);
  expect(await oben(werte)).toBeGreaterThanOrEqual(await unten(page.locator('.vp-mss-kopf')));
  expect(await oben(page.getByTestId('karte-ort'))).toBeGreaterThan(await oben(werte));
  if (breite === 1440) {
    // Am Rechner steht die Liste neben der Karte, nicht 1 100 px darunter.
    const k = (await karte.boundingBox())!;
    const l = (await werte.locator('.vp-wk-liste').boundingBox())!;
    expect(l.x).toBeGreaterThan(k.x + k.width);
  }
  await messeUndFotografiere(page, breite, 'o14-ms06-werte');
  await werteBild(werte, breite, 'o14-werte');
  if (BILDER && breite === 1440) {
    // Vorschau der NICHT gebauten Variante B (eine Spalte wie im Dialog) — nur als Bild, nicht im Code.
    const stil = await page.addStyleTag({ content: '.vp-mss-werte .vp-wk { grid-template-columns: minmax(0, 40rem) !important; }' });
    await werteBild(werte, breite, 'variante-b-eine-spalte');
    await stil.evaluate((el) => el.remove());
  }
});

test('O13 · Einstieg: vom Register in die Werte — am Rechner „Letzter Wert“ und Zeilenmenü „Werte“, am Telefon die ganze Karte', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto('/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen');
  // Heute ist laut Register der 20.10.2026 — der Einstieg öffnet den letzten ganzen Tag.
  const ziel = adresse(`#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-19`);
  const werte = page.getByTestId('werte');

  if (breite === 1440) {
    const zeile = page.locator('.vp-ms-tabelle tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^MS-06$/ }) });
    const letzterWert = zeile.getByRole('button', { name: /^Werte MS-06:/ });
    await expect(letzterWert).toBeVisible();
    await messeUndFotografiere(page, breite, 'o13-register');
    await letzterWert.click();
    await expect(page).toHaveURL(ziel);
    await expect(werte.getByTestId('werte-karte')).toContainText(/691\skWh/);
    await page.goBack();
    await zeile.getByRole('button', { name: 'Aktionen' }).click();
    await expect(page.getByRole('menuitem', { name: 'Werte' })).toBeVisible();
    await messeUndFotografiere(page, breite, 'o13-zeilenmenue');
    await page.getByRole('menuitem', { name: 'Werte' }).click();
  } else {
    const karte = page.locator('.vp-ms-karte').filter({ has: page.locator('.vp-ms-kz', { hasText: /^MS-06$/ }) });
    await expect(karte).toHaveClass(/is-werte/);
    await messeUndFotografiere(page, breite, 'o13-register');
    // Getippt wird unten in die Karte, nicht auf den Namen: die ganze Karte ist der Einstieg.
    const box = (await karte.boundingBox())!;
    await karte.click({ position: { x: box.width / 2, y: box.height - 16 } });
  }
  await expect(page).toHaveURL(ziel);
  await expect(werte.getByTestId('werte-karte')).toContainText(/691\skWh/);
  await expect(werte.getByTestId('werte-zone')).toHaveText('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)');
  await expect(werte).toBeInViewport();
  await messeUndFotografiere(page, breite, 'o13-seite-werte');

  // Eine neue Wahl ersetzt die Adresse ohne Verlaufseintrag: „zurück“ führt ins Register, nicht auf den Vortag.
  await werte.getByRole('button', { name: 'Vorheriger Zeitraum' }).click();
  await expect(werte.getByTestId('werte-karte')).toContainText('18.10.2026');
  await expect(page).toHaveURL(adresse(`#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-18`));
  await page.goBack();
  await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
  await expect(page.getByTestId('messstellen')).toBeVisible();
});

test('Version der Adresse · MS-10 am 03.11.2026 (F21): „Sie sehen Version 3 — heute die neueste“; Version 1 sagt, welche heute gilt', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const anfragen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/werte?')) anfragen.push(new URL(r.url()).search);
  });
  await cloud(page, { heute: '2026-11-20' });
  const seite = `/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}`;
  await page.goto(`${seite}?periode=2026-11-03&version=3`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByTestId('werte-version')).toHaveText('Sie sehen Version 3 — heute die neueste');
  await expect(werte.getByTestId('werte-karte')).toContainText('3 Versionen');
  expect(anfragen).toContain('?raster=tag&von=2026-11-03&bis=2026-11-03&version=3');
  expect(anfragen).toContain('?raster=stunde&von=2026-11-03&bis=2026-11-03');
  await messeUndFotografiere(page, breite, 'version-neueste');
  await werteBild(werte, breite, 'version-neueste');

  await page.goto(`${seite}?periode=2026-11-03&version=1`);
  await page.reload();
  const hinweis = werte.getByTestId('werte-version');
  await expect(hinweis).toContainText('Sie sehen Version 1 — heute gilt Version 3');
  await messeUndFotografiere(page, breite, 'version-frueher');
  await werteBild(werte, breite, 'version-frueher');
  await hinweis.getByRole('button', { name: 'Neueste zeigen' }).click();
  await expect(hinweis).toHaveCount(0);
  await expect(werte.getByTestId('werte-karte')).toContainText('3 Versionen');
  await expect(page).toHaveURL(adresse(`${MS_IDS.ms10}?periode=2026-11-03`));
});
