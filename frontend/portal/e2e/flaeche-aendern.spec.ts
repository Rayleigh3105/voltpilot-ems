import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Ort, StandorteAmStichtag } from '../src/api';
import { ortNachSchreiben, ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, bestandEineAnlage, werkLindach } from '../src/test/standorteFixtures';

/**
 * UEMS AP-02 IP-8 bei 375 und 1440 px, Referenzunternehmen Ahrenberg (Fassung 1.1):
 * - T7 „Fläche ändern“: Halle 2, am 15.01.2027 eingetragen 3 400 m² ab 01.01.2027 —
 *   die Folgen vor dem Speichern, danach der Verlauf mit „rückwirkend (14 Tage)“.
 *   Bühne: die echte Liste „Standorte“ (`standorte.html`), Weg über „Halle 2 bearbeiten“.
 * - T6a „Meine Anlage“: Halle 2 mit Standort ST-1 (beide Zeilen), Halle 1 mit dem
 *   automatisch angelegten Standort ohne Adresse, ein Kunde ohne Standort-Objekt.
 *   Bühne: die echte `TechnikSection` (`meine-anlage.html`).
 *
 * Mit `FLAECHE_BILDER=<Ordner>` legt der Lauf je Fall Bilder und `messung-*.json` ab;
 * `ANSICHT_VARIANTE=<x>` hängt `-<x>` an jeden Namen (Vergleichsvariante der Vorschau).
 */

const BILDER = process.env.FLAECHE_BILDER;
const VARIANTE = process.env.ANSICHT_VARIANTE ? `-${process.env.ANSICHT_VARIANTE}` : '';
const BREITEN = [375, 1440] as const;
const HEUTE = '2027-01-15';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Querlauf in px und die Maße, mit denen die Vorschau die Varianten vergleicht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Die Landkarte schneidet ihre Kacheln selbst ab (`seite` misst, ob wirklich etwas übersteht).
      .filter(({ el }) => !el.closest('.leaflet-container'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const karte = document.getElementById('technik-anlage');
    const zeilen = karte ? ([...karte.querySelectorAll('.vp-kv-row')] as HTMLElement[]) : [];
    const koordinaten = zeilen.find(
      (z) => !z.querySelector('.vp-as') && /^Standort( auf der Karte)?$/.test(z.querySelector('dt')?.textContent ?? ''),
    );
    const objekt = zeilen.find((z) => z.querySelector('.vp-as'));
    const landkarte = karte?.querySelector('.vp-tech-map') as HTMLElement | null;
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
      karteHoehe: karte ? Math.round(karte.getBoundingClientRect().height) : null,
      zeilen: zeilen.map((z) => ({
        label: z.querySelector('dt')?.textContent ?? '',
        hoehe: Math.round(z.getBoundingClientRect().height),
      })),
      // Zwischen den beiden „Standort“-Zeilen liegen so viele andere Zeilen.
      zeilenZwischen: objekt && koordinaten ? zeilen.indexOf(koordinaten) - zeilen.indexOf(objekt) - 1 : null,
      // Wie weit die Koordinaten-Zeile von der Landkarte entfernt steht.
      abstandKoordinatenKarte:
        koordinaten && landkarte
          ? Math.round(landkarte.getBoundingClientRect().top - koordinaten.getBoundingClientRect().bottom)
          : null,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string, ausschnitt?: Locator) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await messe(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}${VARIANTE}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  if (ausschnitt) await ausschnitt.screenshot({ path: join(BILDER, `${datei}-ausschnitt.png`) });
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
    await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

/** Die Antwort von `PUT /api/v1/orte/{G-2}/flaeche` nach dem Anbau (Referenz `gebaeude[1].bezugsflaechen`). */
const anbau = (): Ort =>
  ortNachSchreiben({
    flaechen: [
      { m2: 3100, gueltigAb: '2026-10-01', gueltigBis: '2026-12-31', zustand: 'beendet' },
      { m2: 3400, gueltigAb: '2027-01-01', gueltigBis: null, zustand: 'gueltig' },
    ],
    rueckwirkung: { art: 'rueckwirkend', tage: 14, abzeichen: 'rückwirkend (14 Tage)' },
  });

async function verdrahteStandorte(page: Page) {
  const gesendet: unknown[] = [];
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte/kurzzeichen-vorschlag', (r) => r.fulfill(json({ kurzzeichen: 'ST-3' })));
  await page.route('**/api/v1/standorte/*/orte', (r) =>
    r.fulfill(
      json(
        r.request().url().includes(werkLindach().id)
          ? ortsbaumLindach({ stichtag: HEUTE })
          : ortsbaumAhrenberg({ stichtag: HEUTE }),
      ),
    ),
  );
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/orte') || url.pathname.endsWith('/kurzzeichen-vorschlag')) return r.fallback();
    return r.fulfill(json({ ...ahrenbergHeute(), stichtag: HEUTE }));
  });
  await page.route('**/api/v1/orte/*/flaeche', (r) => {
    gesendet.push(r.request().postDataJSON());
    return r.fulfill(json(anbau()));
  });
  // AP-12 IP-9 · freigegebene Berichte (Ahrenberg): ab 01.01.2027 ist kein gültiger Berichtsstand betroffen;
  // früher träfe die Fläche den Stand BR-2026-0001 Nr. 2.
  await page.route('**/api/v1/berichte/betroffen**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    const ab = q.get('gilt_ab') ?? '';
    return r.fulfill(
      json({
        anlass: q.get('anlass'),
        gilt_ab: ab,
        berichte_vorhanden: true,
        betroffen: ab < '2027-01-01' ? [{ kennung: 'BR-2026-0001', nr: 2 }] : [],
        zitieren: [
          { kennung: 'BR-2026-0001', nr: 1 },
          { kennung: 'BR-2026-0001', nr: 2 },
        ],
      }),
    );
  });
  return gesendet;
}

test.describe('T7 · Fläche ändern mit Verlauf (AP-02 IP-8)', () => {
  for (const breite of BREITEN) {
    test(`Halle 2: 3 400 m² ab 01.01.2027, rückwirkend — ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahteStandorte(page);
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
      await page.goto('/e2e/standorte.html');
      await expect(page.getByRole('heading', { level: 1, name: 'Standorte' })).toBeVisible();

      await page.getByRole('button', { name: 'Halle 2 bearbeiten', exact: true }).click();
      await page.getByRole('button', { name: 'Fläche ändern: Halle 2' }).click();
      const dialog = page.getByRole('dialog', { name: 'Fläche ändern' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Neue Fläche (m²) *').fill('3400');
      await dialog.getByRole('combobox', { name: 'Gültig ab *' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
      const folgen = page.getByTestId('flaeche-folgen');
      await expect(folgen).toContainText('Rückwirkend um 14 Tage');
      await expect(folgen).toContainText('Heute ist der 15.01.2027.');
      // AP-12 IP-9: die Auskunft über freigegebene Berichte steht in der Karte vor dem Speichern.
      const berichte = folgen.getByTestId('berichte-folgen');
      await expect(berichte).toHaveText('Freigegebene Berichte: keine betroffen');
      await berichte.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 't7-eingabe', folgen);

      await page.getByRole('button', { name: 'Fläche speichern' }).click();
      await expect(page.getByRole('heading', { name: 'Verlauf der Fläche' })).toBeVisible();
      expect(gesendet).toEqual([{ m2: 3400, gueltigAb: '2027-01-01' }]);
      await expect(page.getByText('rückwirkend (14 Tage)')).toBeVisible();
      await expect(folgen).toContainText('Für die 14 Tage vom 01.01.2027 bis 14.01.2027 gilt die neue Fläche nachträglich.');
      await expect(page.getByTestId('berichte-folgen')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 't7-verlauf');
    });
  }

  test('Halle 2: 3 400 m² ab 01.10.2026 — BR-2026-0001 Nr. 2 bekommt den Vermerk (AP-12 IP-9) — 375 px', async ({ page }) => {
    await verdrahteStandorte(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/e2e/standorte.html');
    await expect(page.getByRole('heading', { level: 1, name: 'Standorte' })).toBeVisible();

    await page.getByRole('button', { name: 'Halle 2 bearbeiten', exact: true }).click();
    await page.getByRole('button', { name: 'Fläche ändern: Halle 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fläche ändern' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Neue Fläche (m²) *').fill('3400');
    await dialog.getByRole('combobox', { name: 'Gültig ab *' }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Voriger Monat' }).click();
    await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
    const folgen = page.getByTestId('flaeche-folgen');
    await expect(folgen).toContainText('01.10.2026');
    const berichte = folgen.getByTestId('berichte-folgen');
    await expect(berichte).toHaveText('Freigegebene Berichte: BR-2026-0001 Nr. 2 bekommt den Vermerk „Revision nötig“');
    await berichte.scrollIntoViewIfNeeded();
    await messeUndFotografiere(page, 375, 't7-eingabe-revision', folgen);
  });
});

const OHNE: StandorteAmStichtag = {
  stichtag: '2026-10-20',
  standorte: [],
  nichtGezeigt: [],
  nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Hof Sonnenfeld' }] },
};

const KARTEN: Record<string, { standorte: () => StandorteAmStichtag; labels: string[] | null }> = {
  ahrenberg: { standorte: ahrenbergHeute, labels: ['Name', 'Standort', 'Standort auf der Karte'] },
  entwurf: { standorte: bestandEineAnlage, labels: ['Name', 'Standort', 'Standort auf der Karte'] },
  ohne: { standorte: () => OHNE, labels: ['Name', 'Standort'] },
};

test.describe('T6a · Meine Anlage mit beiden Standort-Zeilen (AP-02 IP-8, W4)', () => {
  for (const [fall, k] of Object.entries(KARTEN)) {
    for (const breite of BREITEN) {
      test(`${fall} — ${breite} px`, async ({ page }) => {
        // Zuerst das Allgemeine: spätere Routen haben Vorrang.
        await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
        await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
        await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
        await page.route('**/api/v1/standorte', (r) => r.fulfill(json(k.standorte())));
        await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
        await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
        await page.goto(`/e2e/meine-anlage.html?fall=${fall}`);

        const karte = page.locator('#technik-anlage');
        await expect(karte).toBeVisible();
        const aufklappen = karte.locator('button[aria-expanded="false"]');
        if (await aufklappen.count()) await aufklappen.first().click();
        if (fall !== 'ohne') await expect(karte.getByText('(ST-1)', { exact: false })).toBeVisible();
        else await page.waitForLoadState('networkidle');
        await expect(karte.locator('dt').first()).toHaveText('Name');
        if (k.labels && !VARIANTE) {
          const labels = await karte.locator('dt').allTextContents();
          expect(labels.slice(0, k.labels.length)).toEqual(k.labels);
        }
        await karte.scrollIntoViewIfNeeded();
        await messeUndFotografiere(page, breite, `t6a-${fall}`, karte);
      });
    }
  }
});
