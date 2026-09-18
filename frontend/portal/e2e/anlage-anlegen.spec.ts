import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Funktionen, StandortAmStichtag, StandorteAmStichtag, Unternehmen } from '../src/api';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from '../src/test/funktionenFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg, werkLindach } from '../src/test/standorteFixtures';

/**
 * Der Modus „nur messen" im Anlege-Fluss (Steuern-Regel, Captain 15.09.2026) auf der
 * Bühne `anlage-anlegen.html` bei 375 und 1440 px: ein Kunde, der nur misst (Werk
 * Lindach), und ein Kunde mit Steuern (Werk Ahrenberg) gehen denselben Drawer „Anlage
 * anlegen" durch. Im Modus „nur messen" steht auf der ganzen Seite kein Wort der
 * Wortliste (`STEUER_GELD_WOERTER`, im Browser gegen das echte Modul geprüft), und
 * „Fertig" führt ohne Umweg zu den Messstellen; der Kunde mit Steuern sieht
 * Veräußerungsform und „Betrieb" wie heute. Ohne Querlauf — GEMESSEN am Dokument, am
 * Rumpf und an jedem Element des Dialogs.
 *
 * Mit `ANLAGE_ANLEGEN_BILDER=<Ordner>` legt der Lauf je Fall Bild, ganzes Bild und Messung ab.
 */

const BILDER = process.env.ANLAGE_ANLEGEN_BILDER;
const BREITEN = [375, 1440] as const;
const NEU = 's-neu';
const MESSSTELLEN_LINDACH = `#/standort/${FIXTURE_IDS.st2}/messstellen`;

interface Cloud {
  standorte: StandorteAmStichtag;
  funktionen: Funktionen;
  unternehmen?: Unternehmen;
  /** Jeder Körper von `POST /api/v1/sites`. */
  angelegt: Record<string, unknown>[];
}

const messkunde = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [werkLindach()] },
  funktionen: ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }),
  angelegt: [],
});

const kundeMitSteuern = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [werkAhrenberg()] },
  funktionen: ahrenbergFunktionen({ standorte: [funktionWerkAhrenberg()] }),
  angelegt: [],
});

const neuerMesskunde = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
  funktionen: ahrenbergFunktionen({ standorte: [] }),
  unternehmen: ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 0, nochNichtZugeordnetZahl: 0 }),
  angelegt: [],
});

const bestandskundeOhneStandort = (): Cloud => ({
  standorte: { ...ahrenbergHeute(), standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
  funktionen: ahrenbergFunktionen({ standorte: [] }),
  angelegt: [],
});

async function verdrahte(page: Page, cloud: Cloud) {
  // Keine Kartenkacheln aus dem Netz — die Karte ist hier nicht Gegenstand.
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const pfad = url.pathname.slice(url.pathname.indexOf('/api/v1'));
    const methode = r.request().method();
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/standorte' && methode === 'GET') return json(cloud.standorte);
    if (pfad === '/api/v1/unternehmen') return json(cloud.unternehmen ?? ahrenbergUnternehmen());
    if (pfad === '/api/v1/standorte/kurzzeichen-vorschlag') return json({ kurzzeichen: 'ST-2' });
    if (pfad === '/api/v1/standorte' && methode === 'POST') {
      const body = r.request().postDataJSON() as {
        name: string;
        adresse: { strasse: string; plz: string | null; ort: string; land: string };
        zeitzone: string;
      };
      const standort: StandortAmStichtag = werkLindach({
        name: body.name,
        adresse: body.adresse,
        zeitzone: body.zeitzone,
        anlagen: [],
        anlagenZahl: 0,
      });
      cloud.standorte = { ...cloud.standorte, standorte: [standort] };
      cloud.funktionen = ahrenbergFunktionen({ standorte: [funktionWerkLindach()] });
      return json(standort, 201);
    }
    if (pfad === '/api/v1/funktionen') return json(cloud.funktionen);
    if (pfad === '/api/v1/sites' && methode === 'POST') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      cloud.angelegt.push(body);
      return json({
        id: NEU,
        name: body.name,
        biddingZone: 'DE-LU',
        latitude: null,
        longitude: null,
        plantKind: body.plantKind,
        anzulegenderWertCtKwh: null,
        tarifArt: body.tarifArt,
        tarifParamCtKwh: null,
        netzladenErlaubt: body.netzladenErlaubt,
        maxFeedInKw: body.maxFeedInKw,
      });
    }
    if (pfad === '/api/v1/devices/claim') {
      return json({
        id: 'd-neu',
        siteId: NEU,
        externalRef: 'VP-DEMO-0001',
        kind: 'inverter',
        name: null,
        status: 'active',
        lastSeenAt: null,
        createdAt: '2026-10-20T08:15:30Z',
      });
    }
    if (pfad === `/api/v1/sites/${NEU}/assets`) return json([]);
    if (pfad === `/api/v1/sites/${NEU}/entities`) return json({ registry: null, entities: [], localSetup: [], staleOnDevice: [] });
    if (pfad === `/api/v1/sites/${NEU}/profiles`) return json({ profiles: [] });
    return json({ code: 'nicht_gefunden', message: 'Nicht gefunden.' }, 404);
  });
}

async function oeffne(page: Page, breite: number, suche = '', titel = 'Wie heißt Ihre Anlage?') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/anlage-anlegen.html${suche}`);
  await expect(page.getByRole('heading', { name: titel })).toBeVisible();
}

const woerter = (page: Page) =>
  page.evaluate(() => (window as unknown as { steuerGeldWoerterDerSeite: () => string[] }).steuerGeldWoerterDerSeite());

async function schweigt(page: Page, stelle: string) {
  expect(await woerter(page), stelle).toEqual([]);
}

/** Querlauf in px: Dokument, Rumpf des Dialogs und jedes Element über den Rand (die Karte zeichnet ihre Kacheln bewusst darüber hinaus). */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *, .vp-onboarding *')]
      .filter((el) => !el.closest('.vp-map'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const rumpf = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const gekuerzt = [...document.querySelectorAll('.vp-anlage-flow button')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    return {
      dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rumpf: rumpf.length ? Math.max(...rumpf.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
      gekuerzt,
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
  expect(m.gekuerzt, `${name} ${breite}: gekürzt`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  // Das ganze Bild: der Rumpf des Dialogs bzw. die ganze Seite des Assistenten.
  const hoehe = await page.evaluate(() => {
    const modal = document.querySelector('.vp-modal') as HTMLElement | null;
    const rumpf = modal?.querySelector('.dbody') as HTMLElement | null;
    if (modal && rumpf) return modal.offsetHeight - rumpf.clientHeight + rumpf.scrollHeight + 48;
    return document.documentElement.scrollHeight;
  });
  const vorher = page.viewportSize()!;
  if (hoehe > vorher.height) {
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

for (const breite of BREITEN) {
  test(`neuer Messkunde ohne Standort · ${breite} px: zuerst Standort, danach Anlage nur messen`, async ({ page }) => {
    const cloud = neuerMesskunde();
    await verdrahte(page, cloud);
    await oeffne(page, breite, '', 'Zuerst den Standort');
    await expect(page.locator('.vp-step-label')).toHaveText(['Standort', 'Anlage', 'Register', 'Gerät']);
    await expect(page.getByText('Jede Anlage gehört zu einem Standort.')).toBeVisible();
    await schweigt(page, 'Zuerst den Standort');
    await messeUndFotografiere(page, breite, 'neu-0-standort-zuerst');

    await page.getByRole('button', { name: 'Standort anlegen', exact: true }).click();
    const standort = page.getByRole('dialog', { name: 'Standort anlegen' });
    await standort.getByLabel('Name *').fill('Werk Lindach');
    await standort.getByLabel('Straße und Hausnummer *').fill('Am Bahndamm 12');
    await standort.getByLabel('Ort *').fill('Lindach');
    await standort.getByRole('button', { name: 'Standort anlegen' }).click();

    await expect(page.getByRole('heading', { name: 'Wie heißt Ihre Anlage?' })).toBeVisible();
    const anlage = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(anlage.getByRole('combobox', { name: 'Standort *' })).toContainText('Werk Lindach');
    await expect(anlage.locator('.vp-step-label')).toHaveText(['Anlage', 'Register', 'Gerät']);
    await schweigt(page, 'Anlage nach dem Standort');
    await messeUndFotografiere(page, breite, 'neu-1-anlage');

    await anlage.getByLabel('Name der Anlage').fill('Messung Halle 1');
    await anlage.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(anlage.getByRole('heading', { name: 'PV & Speicher aus dem Register' })).toBeVisible();
    expect(cloud.angelegt).toEqual([
      expect.objectContaining({ standortId: FIXTURE_IDS.st2, plantKind: 'eigenverbrauch', tarifArt: 'ohne' }),
    ]);
  });

  test(`Ein-Anlagen-Bestandskunde ohne Standort · ${breite} px: Zeichenweg bleibt wie heute`, async ({ page }) => {
    await verdrahte(page, bestandskundeOhneStandort());
    await oeffne(page, breite, '?wirt=bestand-ohne-standort');
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Anlage', 'Register', 'Gerät', 'Betrieb']);
    await expect(dialog.getByRole('combobox', { name: 'Veräußerungsform' })).toBeVisible();
    await expect(dialog.getByText(/Feineinstellungen/)).toBeVisible();
    await expect(dialog.getByText('Zuerst den Standort')).toHaveCount(0);
    await messeUndFotografiere(page, breite, 'bestand-eine-anlage');
  });

  test(`Leerzustand · ${breite} px: Messkunde ohne Fahrplan und Erlöse, Gegenprobe wie heute`, async ({ page }) => {
    await verdrahte(page, messkunde());
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/anlage-anlegen.html?wirt=leer');
    await expect(page.getByRole('heading', { name: 'Noch keine Anlage' })).toBeVisible();
    await expect(page.locator('.vp-main')).toContainText('ihre Messwerte');
    await expect(page.locator('.vp-main')).not.toContainText('Fahrplan');
    await expect(page.locator('.vp-main')).not.toContainText('Erlöse');
    await messeUndFotografiere(page, breite, 'leer-messkunde-nachher');
  });

  test(`Leerzustand-Gegenprobe · ${breite} px: Standort mit Steuern behält heutigen Text`, async ({ page }) => {
    await verdrahte(page, kundeMitSteuern());
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/anlage-anlegen.html?wirt=leer');
    await expect(page.getByRole('heading', { name: 'Noch keine Anlage' })).toBeVisible();
    await expect(page.locator('.vp-main')).toContainText('Fahrplan');
    await expect(page.locator('.vp-main')).toContainText('Erlöse');
    await messeUndFotografiere(page, breite, 'leer-wie-heute-vorher');
  });

  test(`nur messen · ${breite} px: Werk Lindach — drei Schritte, kein Wort der Wortliste, „Zu den Messstellen"`, async ({ page }) => {
    const cloud = messkunde();
    await verdrahte(page, cloud);
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.getByRole('combobox', { name: 'Standort *' })).toContainText('Werk Lindach');
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Anlage', 'Register', 'Gerät']);
    await expect(dialog.getByText(/Feineinstellungen/)).toHaveCount(0);
    await schweigt(page, 'Schritt 1 · Anlage');
    await messeUndFotografiere(page, breite, 'messen-1-anlage');

    await dialog.getByLabel('Name der Anlage').fill('Halle 3');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'PV & Speicher aus dem Register' })).toBeVisible();
    await schweigt(page, 'Schritt 2 · Register');
    await messeUndFotografiere(page, breite, 'messen-2-register');

    await dialog.getByRole('button', { name: 'Überspringen - später nachtragen' }).click();
    await expect(dialog.getByRole('heading', { name: 'Verbinden Sie Ihr VoltPilot-Gerät' })).toBeVisible();
    await schweigt(page, 'Schritt 3 · Gerät');
    await messeUndFotografiere(page, breite, 'messen-3-geraet');

    await dialog.getByLabel('Geräte-ID').fill('vp-demo-0001');
    await dialog.getByRole('button', { name: 'Anlage anlegen', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Anlage „Halle 3“ ist da' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Zu den Messstellen' })).toBeVisible();
    // Still heißt nicht Sackgasse: die Anlage (mit ihrem Bereich „Steuerung") bleibt einen Tipp entfernt.
    await expect(dialog.getByRole('button', { name: 'Zur Anlage' })).toBeVisible();
    await schweigt(page, 'Fertig');
    await messeUndFotografiere(page, breite, 'messen-4-fertig');
    expect(cloud.angelegt).toEqual([
      expect.objectContaining({
        standortId: FIXTURE_IDS.st2,
        plantKind: 'eigenverbrauch',
        tarifArt: 'ohne',
        netzladenErlaubt: false,
        maxFeedInKw: null,
      }),
    ]);

    await dialog.getByRole('button', { name: 'Zu den Messstellen' }).click();
    await expect(page.getByTestId('gemeldet')).toHaveText(`${NEU} → ${MESSSTELLEN_LINDACH}`);
    expect(new URL(page.url()).hash).toBe(MESSSTELLEN_LINDACH);
  });

  test(`Kunde mit Steuern · ${breite} px: Werk Ahrenberg — wie heute, mit Veräußerungsform und „Betrieb"`, async ({ page }) => {
    const cloud = kundeMitSteuern();
    await verdrahte(page, cloud);
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Anlage anlegen' });
    await expect(dialog.getByRole('combobox', { name: 'Standort *' })).toContainText('Werk Ahrenberg');
    await expect(dialog.locator('.vp-step-label')).toHaveText(['Anlage', 'Register', 'Gerät', 'Betrieb']);
    await expect(dialog.getByRole('combobox', { name: 'Veräußerungsform' })).toBeVisible();
    // Gegenprobe im Browser: derselbe Abtaster findet die Wörter.
    expect(await woerter(page)).toEqual(expect.arrayContaining(['veräußerung', 'vergüt', 'netzladen']));
    await messeUndFotografiere(page, breite, 'steuern-1-anlage');

    await dialog.getByLabel('Name der Anlage').fill('Halle 3');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await dialog.getByRole('button', { name: 'Überspringen - später nachtragen' }).click();
    await expect(dialog.getByRole('heading', { name: 'Verbinden Sie Ihr VoltPilot-Gerät' })).toBeVisible();
    await messeUndFotografiere(page, breite, 'steuern-3-geraet');

    await dialog.getByLabel('Geräte-ID').fill('vp-demo-0001');
    await dialog.getByRole('button', { name: 'Anlage anlegen', exact: true }).click();
    await expect(dialog.getByText('Wofür ist diese Anlage?')).toBeVisible();
    await messeUndFotografiere(page, breite, 'steuern-4-betrieb');

    await dialog.getByRole('button', { name: 'Überspringen - später festlegen' }).click();
    await expect(dialog.getByRole('heading', { name: 'Anlage „Halle 3“ ist da' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Zu den Messstellen' })).toHaveCount(0);
    await messeUndFotografiere(page, breite, 'steuern-5-fertig');
    await dialog.getByRole('button', { name: 'Zur Anlage' }).click();
    await expect(page.getByTestId('gemeldet')).toHaveText(`${NEU} → Anlage`);
  });

  test(`Einrichtungs-Assistent · ${breite} px: „In drei Schritten" beim Messkunden`, async ({ page }) => {
    await verdrahte(page, messkunde());
    await oeffne(page, breite, '?wirt=assistent');
    await expect(page.getByText('In drei Schritten ist Ihre Anlage startklar.')).toBeVisible();
    await schweigt(page, 'Willkommen');
    await messeUndFotografiere(page, breite, 'assistent-messen');
  });

  test(`Einrichtungs-Assistent · ${breite} px: „In vier Schritten" mit Steuern`, async ({ page }) => {
    await verdrahte(page, kundeMitSteuern());
    await oeffne(page, breite, '?wirt=assistent');
    await expect(page.getByText('In vier Schritten ist Ihre Anlage startklar.')).toBeVisible();
    await messeUndFotografiere(page, breite, 'assistent-steuern');
  });
}
