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
  protokollMs06,
  protokollMs08Angelegt,
  protokollMs08OrtGeplant,
  protokollMs08Vorher,
  prozesseAhrenberg,
  prozesseVon,
  verteilungVon,
} from '../src/test/messstelleSeiteFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';

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

/** `angelegt`: MS-08 am 01.10.2026, eben angelegt (heute = Stichtag der Einführung). */
async function cloud(page: Page, { angelegt = false } = {}): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  let gespeichert = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pfad = url.pathname;
    const methode = req.method();
    if (methode !== 'GET') gesendet.push({ methode, pfad, body: req.postDataJSON() });

    const ms08 = () => (angelegt ? ms08Angelegt() : gespeichert ? ms08OrtGeplant() : ms08Vorher());
    const messstelle = pfad.includes(MS_IDS.ms06) ? ms06() : ms08();

    if (pfad === '/api/v1/unternehmen/prozesse') return route.fulfill(json({ stichtag: null, prozesse: prozesseAhrenberg() }));
    if (pfad === '/api/v1/unternehmen/kostenstellen') {
      return route.fulfill(json({ stichtag: null, kostenstellen: kostenstellenAhrenberg() }));
    }
    if (pfad === '/api/v1/standorte') return route.fulfill(json(ahrenbergHeute()));
    if (pfad.endsWith('/orte')) return route.fulfill(json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    if (pfad === '/api/v1/messstellen' && methode === 'GET') {
      return route.fulfill(json(angelegt ? { ...ahrenbergRegister(), stichtag: EINFUEHRUNG_TAG } : ahrenbergRegister()));
    }
    if (pfad.endsWith('/prozesse') && methode === 'GET') return route.fulfill(json(prozesseVon(messstelle)));
    if (pfad.endsWith('/verteilung') && methode === 'GET') return route.fulfill(json(verteilungVon(messstelle)));
    if (pfad.endsWith('/aenderungen')) {
      const protokoll = pfad.includes(MS_IDS.ms06)
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
