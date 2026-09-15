import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Funktionen, StandorteAmStichtag } from '../src/api';
import {
  ahrenbergFunktionen,
  funktionMessenEntwurf,
  funktionWerkAhrenberg,
  funktionWerkLindach,
} from '../src/test/funktionenFixtures';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from '../src/test/standorteFixtures';

/**
 * Der Assistent „Messen & Auswerten" (UEMS AP-01 IP-9a) auf der Bühne
 * `messen-assistent.html` bei 375 und 1440 px: Schritt 1 → Schritt 2 mit genau
 * einem Einrichten, „Schritt n von 5", Abbruch und Wiedereinstieg über ein
 * Neuladen, der Standort ohne Anlage und die gestapelten Unterabläufe — ohne
 * Querlauf, GEMESSEN am Dokument (`scrollWidth − clientWidth`) und an jedem
 * Element der Dialoge.
 *
 * Die Cloud ist per `page.route` verdrahtet (Referenzunternehmen Ahrenberg,
 * Komponenten je Anlage wie in der Referenzdatei: AN-1 7, AN-2 6, AN-3 3). Mit
 * `MESSEN_ASSISTENT_BILDER=<Ordner>` legt der Lauf je Fall Bild und Messung ab.
 */

const BILDER = process.env.MESSEN_ASSISTENT_BILDER;
const BREITEN = [375, 1440] as const;
const LINDACH = FIXTURE_IDS.st2;
const KOMPONENTEN: Record<string, number> = { [FIXTURE_IDS.an1]: 7, [FIXTURE_IDS.an2]: 6, [FIXTURE_IDS.an3]: 3 };

interface Cloud {
  standorte: StandorteAmStichtag;
  funktionen: Funktionen;
}

const ohneMessen = (): Cloud => ({
  standorte: ahrenbergHeute(),
  funktionen: ahrenbergFunktionen({ messen: 'bestand' }),
});

const lindachImEntwurf = (standorte = ahrenbergHeute()): Cloud => ({
  standorte,
  funktionen: ahrenbergFunktionen({
    standorte: [funktionWerkAhrenberg('bestand'), funktionMessenEntwurf(funktionWerkLindach('bestand'))],
  }),
});

/** Verdrahtet die Cloud; das Ergebnis zählt jedes `PUT …/funktionen/messen` (Standort-Kennung). */
async function verdrahte(page: Page, cloud: Cloud) {
  const einrichten: string[] = [];
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const pfad = url.pathname.slice(url.pathname.indexOf('/api/v1'));
    const methode = r.request().method();
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/standorte' && methode === 'GET') return json(cloud.standorte);
    if (pfad === '/api/v1/unternehmen') return json(ahrenbergUnternehmen());
    if (pfad === '/api/v1/funktionen') return json(cloud.funktionen);
    if (pfad === '/api/v1/standorte/kurzzeichen-vorschlag') return json({ kurzzeichen: 'ST-3' });
    const messen = /^\/api\/v1\/standorte\/([^/]+)\/funktionen\/messen$/.exec(pfad);
    if (messen && methode === 'PUT') {
      einrichten.push(messen[1]);
      const vorher = cloud.funktionen.standorte.find((s) => s.id === messen[1])!;
      if (vorher.messen.zustand !== 'kein_objekt') {
        return json({ code: 'bereits_angelegt', message: 'Messen & Auswerten ist hier bereits angelegt', fehlt: [], wege: [] }, 409);
      }
      const danach = funktionMessenEntwurf(vorher);
      cloud.funktionen = {
        ...cloud.funktionen,
        standorte: cloud.funktionen.standorte.map((s) => (s.id === danach.id ? danach : s)),
      };
      return json({ aktion: 'einrichten', standort: danach });
    }
    if (pfad === '/api/v1/sites') {
      return json(cloud.standorte.standorte.flatMap((s) => s.anlagen).map((a) => ({ id: a.id, name: a.name })));
    }
    const komponenten = /^\/api\/v1\/sites\/([^/]+)\/components$/.exec(pfad);
    if (komponenten) {
      const n = KOMPONENTEN[komponenten[1]] ?? 0;
      return json({ componentAuthority: 'cloud', components: Array.from({ length: n }, (_, i) => ({ id: `k-${i + 1}` })) });
    }
    if (pfad === '/api/v1/component-templates') return json([]);
    return json({ code: 'nicht_gefunden', message: 'Nicht gefunden.' }, 404);
  });
  return einrichten;
}

async function oeffne(page: Page, breite: number, suche = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/messen-assistent.html${suche}`);
  await expect(page.getByRole('dialog', { name: 'Messen & Auswerten einrichten' })).toBeVisible();
}

const schritt1 = (page: Page) => expect(page.getByRole('heading', { name: 'Wo wird gemessen?' })).toBeVisible();
const schritt2 = (page: Page) => expect(page.getByRole('heading', { name: 'Womit wird gemessen?' })).toBeVisible();

/** „Schritt n von 5": am Telefon sichtbar im Kopf, am Rechner als benannter Schritt der Leiste; immer in der Ansage. */
async function zaehlerIst(page: Page, breite: number, n: number, name: string) {
  if (breite < 720) {
    await expect(page.locator('.vp-anlegen-zaehler').first()).toHaveText(`Schritt ${n} von 5`);
  } else {
    await expect(page.locator('.vp-anlegen-steps li[aria-current="step"]').first()).toContainText(name);
  }
  await expect(page.locator('.vp-anlegen-sr').first()).toHaveText(`Schritt ${n} von 5: ${name}`);
}

/** Querlauf in px: Dokument, Rumpf der Dialoge und jedes Element eines Dialogs über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-anlegen-dialog *, .vp-modal *')]
      // Die unsichtbare Ansage der Schale (`.vp-anlegen-sr`, 1 px, `clip: rect(0 0 0 0)`) ist kein Querlauf.
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)')
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const rumpf = [...document.querySelectorAll('.vp-anlegen-rumpf, .vp-modal .dbody')] as HTMLElement[];
    return {
      dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rumpf: rumpf.length ? Math.max(...rumpf.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.rumpf, `${name} ${breite}: Rumpf`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  if (await page.locator('.vp-modal').count()) return;
  // Der ganze Rumpf des obersten Schritt-Dialogs, nicht nur der erste Bildschirm.
  const hoehe = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.vp-anlegen-dialog')].at(-1) as HTMLElement | undefined;
    const rumpf = d?.querySelector('.vp-anlegen-rumpf') as HTMLElement | null;
    return d && rumpf ? d.offsetHeight - rumpf.clientHeight + rumpf.scrollHeight + 24 : 0;
  });
  const vorher = page.viewportSize()!;
  if (hoehe > vorher.height) {
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

for (const breite of BREITEN) {
  test.describe(`Messen & Auswerten einrichten · ${breite} px`, () => {
    test('Schritt 1 → 2 → 1 → 2: genau ein Einrichten, „Schritt n von 5", Abbruch und Wiedereinstieg', async ({ page }) => {
      const cloud = ohneMessen();
      const einrichten = await verdrahte(page, cloud);
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt1(page);
      await zaehlerIst(page, breite, 1, 'Standort');
      await expect(page.getByText('Messen & Auswerten — noch nicht eingerichtet')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt1');

      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await schritt2(page);
      await zaehlerIst(page, breite, 2, 'Datenquelle');
      await expect(page.getByText('3 Komponenten angebunden')).toBeVisible();
      await messeUndFotografiere(page, breite, 'schritt2');

      await page.getByRole('button', { name: 'Zurück', exact: true }).click();
      await schritt1(page);
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await schritt2(page);
      expect(einrichten).toEqual([LINDACH]);

      // Abbruch: der Assistent geht zu, der Entwurf bleibt …
      await page.getByRole('button', { name: 'Schließen', exact: true }).click();
      await expect(page.getByTestId('assistent-geschlossen')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('vp.uems.messen-assistent.entwurf.v1'))).toBe(
        JSON.stringify({ standortId: LINDACH, schritt: 2 }),
      );
      // … und nach einem Neuladen OHNE Vorwahl steht er wieder auf Schritt 2 — ohne zweites Einrichten.
      await oeffne(page, breite);
      await schritt2(page);
      await zaehlerIst(page, breite, 2, 'Datenquelle');
      await expect(page.getByText('Werk Lindach (ST-2)')).toBeVisible();
      await messeUndFotografiere(page, breite, 'wiedereinstieg');
      expect(einrichten).toEqual([LINDACH]);
    });

    test('Standort ohne Anlage: Zustand und Ort als Hinweis ohne Knopf', async ({ page }) => {
      await verdrahte(
        page,
        lindachImEntwurf({ ...ahrenbergHeute(), standorte: [werkAhrenberg(), werkLindach({ anlagen: [], anlagenZahl: 0 })] }),
      );
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt2(page);
      const leer = page.getByTestId('messen-keine-anlage');
      await expect(leer).toContainText('An Werk Lindach hängt noch keine Anlage.');
      await expect(leer).toContainText('auf der Übersicht über „Anlage anlegen“');
      await expect(leer.getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Anderen Standort wählen', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Später fortsetzen', exact: true })).toBeVisible();
      await messeUndFotografiere(page, breite, 'ohne-anlage');
    });

    test('die bestehenden Dialoge liegen über dem Assistenten — ohne Querlauf', async ({ page }) => {
      await verdrahte(page, lindachImEntwurf());
      await oeffne(page, breite, `?standort=${LINDACH}`);
      await schritt2(page);

      await page.getByRole('button', { name: 'Gerät verbinden für Werk Lindach', exact: true }).click();
      const geraet = page.getByRole('dialog', { name: /Gerät hinzufügen/ });
      await expect(geraet).toBeVisible();
      // Der Unterablauf ersetzt die Schale — nichts liegt über ihm (das Haus-Modal läge sonst darunter).
      await expect(page.getByRole('dialog', { name: 'Messen & Auswerten einrichten' })).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'geraet-verbinden');
      await geraet.getByRole('button', { name: 'Abbrechen', exact: true }).click();
      await expect(geraet).toHaveCount(0);
      await zaehlerIst(page, breite, 2, 'Datenquelle');

      await page.getByRole('button', { name: 'Gerät anbinden für Werk Lindach', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Gerät anbinden' })).toBeVisible();
      await messeUndFotografiere(page, breite, 'geraet-anbinden');
    });

    test('ohne Standort legt Schritt 1 ihn im Standort-Dialog aus AP-02 an', async ({ page }) => {
      await verdrahte(page, { standorte: { ...ahrenbergHeute(), standorte: [] }, funktionen: ahrenbergFunktionen({ standorte: [] }) });
      await oeffne(page, breite);
      await schritt1(page);
      await expect(page.getByText('Es gibt noch keinen Standort. Legen Sie ihn zuerst an.')).toBeVisible();
      await page.getByRole('button', { name: 'Neuen Standort anlegen', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Standort anlegen' })).toBeVisible();
      await messeUndFotografiere(page, breite, 'standort-anlegen');
    });
  });
}
