import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  kanaeleK5Frei,
  komponentenHalle1,
  messstelleAngelegt,
  registerAntwort,
  VORSCHLAG,
} from '../src/test/messstelleDialogFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ersten Zugriff kalt — großzügige Frist.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * UEMS AP-04 IP-6 · der Messstellen-Dialog am echten Baustein (Bühne `messstelle-dialog.html`):
 * D1 Identität → D2 Zuordnung mit dem zweiten Hauptzähler (409, Wortlaut der FEHLER-Tabelle) und
 * dem Weg „Unterzähler von MS-01“ → D3 „Woher kommen die Werte?“ (Messen m2: zwei gleichwertige Wege) mit
 * ausgegrauten Messwerten und „Was geschieht“ → Fertig; dazu der Weg „Von Hand ablesen“ mit der ersten Ablesung. Misst bei jedem Bild: Dokument UND Dialog 0 px Querlauf, kein Element über dem Rand.
 * Pflicht ist 375 px (Prüfnachweis des Reports); 1440 px fährt denselben Weg für die Ansicht.
 * Mit `MESSSTELLE_DIALOG_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild und `messung-*.json` ab.
 */

const BILDER = process.env.MESSSTELLE_DIALOG_BILDER;
const BREITEN = [375, 1440] as const;

const HAUPTZAEHLER =
  'Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Gesendet {
  methode: string;
  pfad: string;
  body: unknown;
}

async function cloud(page: Page): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  const aktiv = messstelleAngelegt({ lebenszyklus: 'aktiv', fehlt: [] });
  let stellungVersuche = 0;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const pfad = new URL(req.url()).pathname;
    const methode = req.method();
    if (methode !== 'GET') gesendet.push({ methode, pfad, body: req.postDataJSON() });

    if (pfad.endsWith('/messstellen/kennzeichen-vorschlag')) return route.fulfill(json({ kennzeichen: VORSCHLAG }));
    if (pfad.endsWith('/api/v1/standorte')) return route.fulfill(json(ahrenbergHeute()));
    if (pfad.endsWith('/orte')) {
      return route.fulfill(json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    }
    if (pfad.endsWith('/api/v1/messstellen') && methode === 'GET') return route.fulfill(json(registerAntwort()));
    if (pfad.endsWith('/api/v1/messstellen') && methode === 'POST') return route.fulfill(json(messstelleAngelegt(), 201));
    if (pfad.endsWith('/ort') && methode === 'PUT') return route.fulfill(json(aktiv));
    if (pfad.endsWith('/stellung') && methode === 'PUT') {
      stellungVersuche += 1;
      if (stellungVersuche === 1) {
        return route.fulfill(
          json(
            {
              code: 'hauptzaehler_vorhanden',
              message: HAUPTZAEHLER,
              tag: '2026-10-20',
              bestehend: { kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: FIXTURE_IDS.an1 },
            },
            409,
          ),
        );
      }
      return route.fulfill(json(aktiv));
    }
    if (pfad.endsWith('/entities')) return route.fulfill(json(komponentenHalle1()));
    if (pfad.endsWith('/messkanaele')) return route.fulfill(json(kanaeleK5Frei()));
    if (pfad.endsWith('/quellen') && methode === 'POST') return route.fulfill(json({ quelle: { id: 'q-1' } }, 201));
    if (pfad.endsWith('/ablesungen') && methode === 'POST') {
      const b = req.postDataJSON() as { zeitpunkt: string; stand: string };
      return route.fulfill(
        json({
          urteil: 'eingetragen',
          korrektur: null,
          ablesung: {
            quelle: 'q-ablesung', zeitpunkt: b.zeitpunkt, fassung: 1, stand: 1250000, monat: null, woher: 'eingabe',
            urheber: { name: 'Ines Kaltenbach', rolle: null }, korrektur: null, eingetragen_am: '2026-10-20T09:00:00+02:00',
          },
          ablesezeitraum: null,
        }),
      );
    }
    return route.fulfill(json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
  });
  return gesendet;
}

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *')]
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
  await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function messeUndFotografiere(page: Page, breite: number, name: string, { ganz = true } = {}) {
  await ruhig(page);
  const m = await messe(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  // Das ganze Bild: das Fenster so hoch wie der Dialog-Inhalt, damit nichts im Scrollbereich fehlt.
  if (ganz && m.inhaltHoehe && m.sichtHoehe && m.inhaltHoehe > m.sichtHoehe) {
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: vorher.height + (m.inhaltHoehe - m.sichtHoehe) + 40 });
    await ruhig(page);
    await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

/** Die Liste DIESES Felds — eine eben geschlossene blendet noch aus und steht solange im DOM. */
async function listeVon(page: Page, feld: Locator): Promise<Locator> {
  await feld.click();
  const id = await feld.getAttribute('id');
  return id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
}

async function waehleIn(page: Page, feld: Locator, option: RegExp) {
  await (await listeVon(page, feld)).getByRole('option', { name: option }).click();
}

const waehle = (page: Page, feld: string, option: RegExp) =>
  waehleIn(page, page.getByRole('combobox', { name: feld, exact: true }), option);

const aktiverSchritt = (page: Page) => page.locator('.vp-step-active .vp-step-label');

for (const breite of BREITEN) {
  test(`D1 → D2 (409 Hauptzähler) → D3 → Fertig bei ${breite} px ohne Querlauf`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    const gesendet = await cloud(page);
    await page.goto('/e2e/messstelle-dialog.html');

    // D1 — Kennzeichen vorbelegt, Medium nur Strom.
    const dialog = page.getByRole('dialog', { name: 'Messstelle anlegen' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Kennzeichen', { exact: true })).toHaveValue('MS-0022');
    await expect(dialog.getByText('automatisch · änderbar')).toBeVisible();
    await messeUndFotografiere(page, breite, 'd1-identitaet');

    await page.getByRole('button', { name: 'Weiter: Zuordnung' }).click();
    await expect(dialog.getByText('Bitte geben Sie der Messstelle einen Namen.')).toBeVisible();
    await expect(page.getByLabel('Name *')).toBeFocused();
    await messeUndFotografiere(page, breite, 'd1-pflichtfelder');

    await page.getByLabel('Name *').fill('Spritzguss SG01–SG06 Kühlung');
    await waehle(page, 'Hauptgröße *', /^Wirkenergie/);
    await waehle(page, 'Richtung *', /^Bezug/);
    await waehle(page, 'Wertart *', /^Zählerstand/);
    await page.getByRole('button', { name: 'Nebengröße hinzufügen' }).click();
    const neben = dialog.locator('.vp-msd-neben');
    await waehleIn(page, neben.getByRole('combobox', { name: 'Größe *' }), /^Wirkleistung/);
    await waehleIn(page, neben.getByRole('combobox', { name: 'Richtung *' }), /^Bezug/);
    await messeUndFotografiere(page, breite, 'd1-ausgefuellt');

    // D2 — Ort ist der Standort (Vorgabe); zweiter Hauptzähler → 409 mit Wortlaut.
    await page.getByRole('button', { name: 'Weiter: Zuordnung' }).click();
    await expect(aktiverSchritt(page)).toHaveText('Zuordnung');
    await expect(page.getByRole('combobox', { name: 'Ort', exact: true })).toContainText('Werk Ahrenberg');
    await waehle(page, 'Ort', /^Halle 1 Nord/);
    await expect(dialog.getByText('Werk Ahrenberg › Halle 1 › Halle 1 Nord · Bereich')).toBeVisible();
    await waehle(page, 'Anlage', /^Werk Ahrenberg – Halle 1/);
    await waehle(page, 'Elektrische Stellung', /^Hauptzähler/);
    await page.getByRole('button', { name: 'Weiter: Quelle' }).click();
    await expect(dialog.getByText(HAUPTZAEHLER, { exact: true })).toBeVisible();
    await expect(aktiverSchritt(page)).toHaveText('Zuordnung');
    await messeUndFotografiere(page, breite, 'd2-hauptzaehler-409');

    await waehle(page, 'Elektrische Stellung', /^Unterzähler/);
    await waehle(page, 'Unterzähler von *', /^MS-01 Netzbezug Halle 1/);
    await messeUndFotografiere(page, breite, 'd2-unterzaehler');
    await page.getByRole('button', { name: 'Weiter: Quelle' }).click();
    await expect(aktiverSchritt(page)).toHaveText('Quelle');

    // D3 — „Woher kommen die Werte?“: zwei gleichwertige Wege, keiner vorgewählt.
    await expect(dialog.getByText('Woher kommen die Werte?')).toBeVisible();
    const geraet = dialog.getByRole('radio', { name: /^Automatisch von einem Gerät/ });
    const ablesen = dialog.getByRole('radio', { name: /^Von Hand ablesen/ });
    await expect(geraet).not.toBeChecked();
    await expect(ablesen).not.toBeChecked();
    await messeUndFotografiere(page, breite, 'd3-woher');
    await geraet.check();

    // Nur passende Messwerte wählbar, „Was geschieht“ vor dem Klick.
    await waehle(page, 'Komponente', /^Unterzähler Spritzguss SG01–SG06/);
    const hauptListe = await listeVon(
      page,
      page.getByRole('combobox', { name: 'Messwert für die Hauptgröße · Wirkenergie · Bezug' }),
    );
    await expect(hauptListe.getByRole('option', { name: /^Wirkleistung/ })).toHaveAttribute('aria-disabled', 'true');
    // Offene Liste: kein „ganz“-Bild — ein anderes Fenstermaß schlösse sie.
    await messeUndFotografiere(page, breite, 'd3-messwerte', { ganz: false });
    await hauptListe.getByRole('option', { name: /^Wirkenergie Bezug/ }).click();
    await waehle(page, 'Messwert für die Nebengröße · Wirkleistung · Bezug', /^Wirkleistung/);
    await expect(page.getByTestId('messstelle-folgen')).toContainText(
      'MS-0022 liest ab 20.10.2026, 09:00 Uhr Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug, Wirkleistung.',
    );
    await messeUndFotografiere(page, breite, 'd3-quelle');

    await page.getByRole('button', { name: 'Fertigstellen' }).click();
    await expect(
      dialog.getByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · wartet auf erste Daten'),
    ).toBeVisible();
    await messeUndFotografiere(page, breite, 'fertig');

    // Jeder Schritt über seine Route: anlegen (automatisches Kennzeichen), Ort, Stellung zweimal, zwei Quellen.
    expect(gesendet.map((g) => `${g.methode} ${g.pfad}`)).toEqual([
      'POST /api/v1/messstellen',
      'PUT /api/v1/messstellen/ms-neu/ort',
      'PUT /api/v1/messstellen/ms-neu/stellung',
      'PUT /api/v1/messstellen/ms-neu/stellung',
      'POST /api/v1/messstellen/ms-neu/quellen',
      'POST /api/v1/messstellen/ms-neu/quellen',
    ]);
    expect(gesendet[0].body).not.toHaveProperty('kennzeichen');
    expect(gesendet[1].body).toEqual({ kennzeichen: 'B-1', gueltig_ab: '2026-10-20' });
    expect(gesendet[3].body).toEqual({
      anlage: FIXTURE_IDS.an1,
      stellung: 'Unterzähler',
      unterzaehler_von: 'MS-01',
      gueltig_ab: '2026-10-20',
    });
  });

  test(`D3 · „Von Hand ablesen“: Ableserhythmus monatlich, erste Ablesung, Fertig bei ${breite} px ohne Querlauf`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    const gesendet = await cloud(page);
    await page.goto('/e2e/messstelle-dialog.html');
    const dialog = page.getByRole('dialog', { name: 'Messstelle anlegen' });
    await expect(page.getByLabel('Kennzeichen', { exact: true })).toHaveValue('MS-0022');
    await page.getByLabel('Name *').fill('Zähler Kompressor K3');
    await waehle(page, 'Hauptgröße *', /^Wirkenergie/);
    await waehle(page, 'Richtung *', /^Bezug/);
    await waehle(page, 'Wertart *', /^Zählerstand/);
    await page.getByRole('button', { name: 'Weiter: Zuordnung' }).click();
    await expect(aktiverSchritt(page)).toHaveText('Zuordnung');
    await expect(page.getByRole('combobox', { name: 'Ort', exact: true })).toContainText('Werk Ahrenberg');
    await page.getByRole('button', { name: 'Weiter: Quelle' }).click();
    await expect(aktiverSchritt(page)).toHaveText('Quelle');

    await dialog.getByRole('radio', { name: /^Von Hand ablesen/ }).check();
    await expect(dialog.getByText('Ableserhythmus')).toBeVisible();
    await expect(dialog.getByText('Monatlich', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Erste Ablesung', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Komponente', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Später eintragen' })).toBeVisible();
    await page.getByLabel('Zählerstand (kWh) *').fill('1.250.000');
    const uhrzeit = page.getByLabel('Uhrzeit *');
    await uhrzeit.fill('08:30');
    await uhrzeit.press('Enter');
    await messeUndFotografiere(page, breite, 'd3-ablesen');

    await page.getByRole('button', { name: 'Fertigstellen' }).click();
    await expect(
      dialog.getByText('MS-0022 Spritzguss SG01–SG06 Kühlung ist eingerichtet und aktiv · wird von Hand abgelesen'),
    ).toBeVisible();
    await messeUndFotografiere(page, breite, 'fertig-ablesen');
    const ablesung = gesendet.find((g) => g.pfad.endsWith('/ablesungen'));
    expect(ablesung?.pfad).toBe('/api/v1/messstellen/MS-0022/ablesungen');
    expect(ablesung?.body).toEqual({ zeitpunkt: '2026-10-20T08:30:00+02:00', stand: '1.250.000', zuordnung_monat: null });
    expect(gesendet.some((g) => g.pfad.endsWith('/quellen'))).toBe(false);
  });
}
