import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * „Geräte suchen“ (Konzept vp-portal-geraetesuche-konzept, Paket 4 Portal) auf der Bühne `e2e/geraetesuche.html`: der
 * echte Aufbau und die echte Box-Seite über der fiktiven Anlage Hof Seewiesen. Jeder Zustand des Such-Modals bei 375 und
 * 1440 px: kein Querlauf, keine gekürzten Knöpfe, keine Konsolenfehler.
 *
 * Bilder: `GERAETESUCHE_BILDER=<Ordner>` legt je Zustand `<name>-<breite>.png` ab - 375 aus `mobile-webkit`, 1440 aus
 * `desktop-chromium`. Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */
const BILDER = process.env.GERAETESUCHE_BILDER;
const BREITEN = [375, 1440] as const;

async function oeffne(page: Page, breite: number, query: string) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/geraetesuche.html?${query}`);
}

/** Querlauf in px: Dokument, Rumpf der Modals, Elemente über den Rand und Knöpfe, deren Text überläuft. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *')]
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)')
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.parentElement?.closest('.vp-kat-arten'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const rumpf = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const gekuerzt = [...document.querySelectorAll('.vp-modal button, .vp-modal a')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5 && (el as HTMLElement).offsetParent !== null)
      .map((el) => el.textContent);
    return {
      dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rumpf: rumpf.length ? Math.max(...rumpf.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
      gekuerzt,
    };
  }, breite);
}

async function pruefeUndFotografiere(page: Page, info: TestInfo, breite: number, name: string, ganz = false) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  // Endlos-Schleifen (Puls der Suche, Spinner) laufen immer - gewartet wird nur auf die endlichen.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const m = await ueberlauf(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.rumpf, `${name} ${breite}: Rumpf`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(m.gekuerzt, `${name} ${breite}: gekürzt`).toEqual([]);
  // Je Breite fotografiert nur die passende Maschine: 375 mobiles WebKit, 1440 Desktop-Chromium.
  const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
  if (!BILDER || !passend) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: ganz });
  if (!ganz || !(await page.locator('.vp-modal').count())) return;
  // Ein langer Dialog zusätzlich ganz: das Fenster so hoch wie Kopf, Rumpf und Fuß des obersten Modals.
  const hoehe = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.vp-modal')].at(-1) as HTMLElement;
    const rumpf = m.querySelector('.dbody') as HTMLElement;
    return m.offsetHeight - rumpf.clientHeight + rumpf.scrollHeight + 48;
  });
  const vorher = page.viewportSize()!;
  if (hoehe <= vorher.height) return;
  await page.setViewportSize({ width: breite, height: hoehe });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
  await page.setViewportSize(vorher);
}

function konsole(page: Page): string[] {
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  page.on('pageerror', (e) => fehler.push(e.message));
  return fehler;
}

const modal = (page: Page, name = 'Geräte suchen') => page.getByRole('dialog', { name });

/** Die Suche der Bühne (`GS_SUCH_ID` der Fixture - die Spec importiert keine Fixtures). */
const SUCH_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
/** Was die Bühne zuletzt an `createComponent` bzw. `updateComponent` geschickt hat. */
const gesendet = (page: Page, route: 'createComponent' | 'updateComponent') =>
  page.evaluate((r) => (window as unknown as { __gesendet: Record<string, Record<string, unknown>> }).__gesendet[r], route);

for (const breite of BREITEN) {
  test.describe(`Gerätesuche · ${breite} px`, () => {
    test('Suche läuft (m2/d2): Schritte, Fortschritt als Ansage, Abbrechen behält die Funde', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=laeuft');
      await expect(modal(page).getByRole('heading', { name: 'Suche im Heimnetz …' })).toBeVisible();
      await expect(modal(page).getByRole('status').filter({ hasText: 'Schritt 2 von 3 · Geräte ansprechen' })).toBeVisible();
      await expect(modal(page).getByRole('progressbar', { name: 'Fortschritt der Suche' })).toHaveAttribute('aria-valuenow', '58');
      await pruefeUndFotografiere(page, info, breite, 'm2-laeuft');

      await modal(page).getByRole('button', { name: 'Abbrechen' }).click();
      await expect(modal(page).getByText('Die Suche wurde abgebrochen. Was bis dahin gefunden war, steht unten.')).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'abgebrochen');
      expect(fehler).toEqual([]);
    });

    test('läuft → Ergebnis von selbst (alle 2 s abgefragt), „Woran erkannt?" (m3/d3)', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=ablauf');
      await expect(modal(page).getByRole('heading', { name: 'Suche im Heimnetz …' })).toBeVisible();
      await expect(modal(page).getByRole('heading', { name: '2 Geräte gefunden' })).toBeVisible({ timeout: 10_000 });
      await pruefeUndFotografiere(page, info, breite, 'm3-ergebnis', true);

      const deye = modal(page).locator('[data-fund="solarman:3115580613"]');
      if (breite < 720) await deye.getByRole('button', { name: 'Deye Hybrid-Wechselrichter', exact: true }).click();
      else await deye.getByRole('button', { name: 'Woran erkannt?' }).click();
      await expect(deye.getByText('Der Datenlogger nennt seine Seriennummer im Antwortkopf (Solarman V5).')).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm3-woran-erkannt');

      // Weitere Geräte sind eingeklappt und nennen Telefone nur als Zahl (DP-3 A).
      const weitere = modal(page).getByTestId('gs-weitere');
      await weitere.locator('summary').click();
      await expect(weitere.getByText('Telefone und Rechner stehen nur als Anzahl da – ohne Namen und ohne MAC-Adresse.')).toBeVisible();
      expect(fehler).toEqual([]);
    });

    test('Deye: Modell vom Typenschild, Anlege-Fluss testet von selbst, danach zurück zur Liste (m4a/m4/m5c, d4)', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=fertig');
      await modal(page).getByRole('button', { name: 'Deye Hybrid-Wechselrichter übernehmen' }).click();
      const wahl = modal(page, 'Wechselrichter hinzufügen');
      await expect(wahl.getByRole('heading', { name: 'Welches Modell steht auf dem Typenschild?' })).toBeVisible();
      await expect(wahl.locator('.vp-gs-wahl-zeile')).toHaveCount(8);
      await pruefeUndFotografiere(page, info, breite, 'm4a-modell', true);

      await wahl.getByRole('button', { name: /SUN-30K-SG01HP3-EU/ }).click();
      const seite = modal(page, 'Gerät einrichten');
      await expect(seite.getByTestId('aus-der-suche')).toContainText('Aus der Gerätesuche: IP-Adresse des Datenloggers');
      await expect(seite.getByTestId('richtung-pruefen')).toBeVisible({ timeout: 10_000 });
      await pruefeUndFotografiere(page, info, breite, 'm4-anlegen-test', true);

      await seite.getByTestId('einrichten-speichern').click();
      await expect(modal(page).getByText(/„.+“ ist angelegt\./)).toBeVisible();
      // Folgepaket „Herkunft": der Bezug auf Suche und Fund reist beim Anlegen mit.
      expect((await gesendet(page, 'createComponent'))?.geraetesuche).toEqual({ suchId: SUCH_ID, fund: 'solarman:3115580613' });
      await expect(modal(page).getByRole('heading', { name: 'Noch 1 Gerät' })).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm5c-zurueck-zur-liste');
      expect(fehler).toEqual([]);
    });

    test('Shelly: je Ausgang ein Gerät (m6)', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=fertig');
      await modal(page).getByRole('button', { name: 'Shelly Pro 3 übernehmen' }).click();
      const wahl = modal(page, 'Schalter hinzufügen');
      await expect(wahl.getByRole('heading', { name: 'Welcher Ausgang steuert ein Gerät?' })).toBeVisible();
      await expect(wahl.getByRole('button', { name: /Ausgang \d/ })).toHaveCount(3);
      await pruefeUndFotografiere(page, info, breite, 'm6-ausgang');
      await wahl.getByRole('button', { name: 'Zurück zur Liste' }).click();
      await expect(modal(page).getByRole('heading', { name: '2 Geräte gefunden' })).toBeVisible();
      expect(fehler).toEqual([]);
    });

    test('Stufe 2: alle Gruppen in fester Reihenfolge, Ladesäule klopft an → Zulassen', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=breit');
      const titel = modal(page).locator('.vp-gs-gruppe > h4 > span');
      await expect(titel).toHaveText([
        'Braucht Ihre Hilfe', 'Ladesäule klopft an', 'Bereit zum Übernehmen',
        'Erkannt, mit dieser Box noch nicht anbindbar', 'Vielleicht ein Energie-Gerät',
      ]);
      await pruefeUndFotografiere(page, info, breite, 'v2-gruppen', true);
      await modal(page).getByRole('button', { name: 'Ladesäule CP-HOF-1 zulassen' }).click();
      await expect(modal(page).getByText(/Zugelassen\. Die Ladesäule darf sich/)).toBeVisible();
      expect(fehler).toEqual([]);
    });

    test('Adresse geändert: ein Tipp übernimmt sie, dasselbe Gerät (m9, DP-7 A)', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=hinweis');
      await expect(modal(page).getByRole('heading', { name: '1 neues Gerät, 1 Hinweis' })).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm9-adresse-geaendert', true);
      await modal(page).getByRole('button', { name: 'Neue Adresse 192.168.178.52:80 für Wallbox Garage übernehmen' }).click();
      await expect(modal(page).getByText('Neue Adresse für „Wallbox Garage“ übernommen – dasselbe Gerät.')).toBeVisible();
      expect((await gesendet(page, 'updateComponent'))?.geraetesuche).toEqual({ suchId: SUCH_ID, fund: 'goe:204117' });
      await pruefeUndFotografiere(page, info, breite, 'm9-uebernommen');
      expect(fehler).toEqual([]);
    });

    test('nichts gefunden (m7): Netze, Prüffragen, zwei Wege weiter', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'fall=nichts');
      await expect(modal(page).getByRole('heading', { name: 'Keine Energie-Geräte gefunden' })).toBeVisible();
      await expect(modal(page).getByRole('button', { name: 'Erneut suchen' })).toBeVisible();
      await expect(modal(page).getByRole('button', { name: 'Von Hand hinzufügen' })).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm7-nichts-gefunden', true);
      expect(fehler).toEqual([]);
    });

    for (const [fall, name, satz] of [
      ['offline', 'm8-start-offline', /Ihre Box meldet sich gerade nicht \(zuletzt \d\d:\d\d\)/],
      ['update', 'm8-start-update', /Update nötig für: Gerätesuche/],
      ['zuoft', 'start-zu-oft', /Je Box sind 6 Suchen pro Stunde möglich\. Ab \d\d:\d\d geht es wieder\./],
      ['keineAntwort', 'keine-antwort', /Ihre Box hat die Suche nicht zu Ende gemeldet\./],
      ['abgelehnt', 'abgelehnt-box', /Ihre Box weiß nicht, in welchem Heimnetz sie steht/],
      ['fehlgeschlagen', 'fehlgeschlagen', /Die Suche ist auf Ihrer Box fehlgeschlagen/],
      ['laeuftschon', 'mitansehen', /von Anna Weber \(VoltPilot-Service\)/],
    ] as const) {
      test(`wenn es nicht geht: ${fall}`, async ({ page }, info) => {
        const fehler = konsole(page);
        await oeffne(page, breite, `fall=${fall}`);
        await expect(modal(page).getByText(satz).first()).toBeVisible();
        await pruefeUndFotografiere(page, info, breite, name);
        expect(fehler).toEqual([]);
      });
    }

    test('Letzte Suchen (m10): 30 Tage, andere Geräte nur als Anzahl', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'ansicht=verlauf');
      await expect(modal(page).getByRole('heading', { name: 'Letzte Suchen' })).toBeVisible();
      await expect(modal(page).getByText('Anna Weber (VoltPilot-Service) · abgebrochen')).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm10-verlauf');
      expect(fehler).toEqual([]);
    });

    test('Escape schließt, die Suche läuft weiter; Tippflächen mindestens 44 px', async ({ page }) => {
      await oeffne(page, breite, 'fall=fertig');
      // Erst messen, wenn das Modal steht - während des Einblendens ist es leicht skaliert.
      await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
      );
      const knopf = modal(page).getByRole('button', { name: 'go-e Wallbox übernehmen' }).or(
        modal(page).getByRole('button', { name: 'Deye Hybrid-Wechselrichter übernehmen' }),
      ).first();
      const box = await knopf.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(modal(page)).toHaveCount(0);
    });

    test('Box-Seite (d1/m1/m8): Knopf im Kartenkopf, Leerzustand, Gründe', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'flaeche=box');
      await expect(page.getByTestId('geraete-suchen')).toBeVisible();
      await expect(page.getByTestId('letzte-suche')).toContainText('Letzte Suche heute');
      // Die Aktivität (d1): die Übernahme über der Suche, die Suche mit Dauer und „nur gelesen".
      const aktivitaet = page.getByTestId('baustein-aktivitaet');
      await expect(aktivitaet.getByText('Gerät angelegt: Wechselrichter (aus der Gerätesuche)')).toBeVisible();
      await expect(aktivitaet.getByText('Gerätesuche im Heimnetz')).toBeVisible();
      await expect(aktivitaet.getByText(/· 38 s · nur gelesen$/)).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'd1-box-seite', true);

      await oeffne(page, breite, 'flaeche=box&geraete=0');
      await expect(page.getByTestId('geraetesuche-leer')).toContainText('An dieser Box meldet sich noch kein Gerät.');
      await pruefeUndFotografiere(page, info, breite, 'm1-box-leer', true);

      for (const lage of ['offline', 'update', 'laeuft'] as const) {
        await oeffne(page, breite, `flaeche=box&box=${lage}`);
        await expect(page.getByTestId('geraetesuche-grund')).toBeVisible();
        await pruefeUndFotografiere(page, info, breite, `m8-box-${lage}`, true);
      }
      expect(fehler).toEqual([]);
    });

    test('Aufbau: an der leeren Box steht „Geräte suchen" neben „Noch kein Gerät an dieser Box"', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'neu=0&geraete=0');
      await expect(page.getByText('Noch kein Gerät an dieser Box')).toBeVisible();
      const knopf = page.getByRole('button', { name: 'Geräte suchen an Seewiesen' });
      await expect(knopf).toBeVisible();
      expect((await knopf.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await pruefeUndFotografiere(page, info, breite, 'aufbau-leere-box', true);
      await knopf.click();
      await expect(modal(page).getByRole('heading', { name: '2 Geräte gefunden' })).toBeVisible();
      expect(fehler).toEqual([]);
    });

    test('Katalog „Gerät hinzufügen" beginnt mit „Im Heimnetz suchen" (m1b)', async ({ page }, info) => {
      const fehler = konsole(page);
      await oeffne(page, breite, 'neu=0');
      await page.getByRole('button', { name: 'Gerät hinzufügen' }).first().click();
      const katalog = modal(page, 'Gerät hinzufügen');
      await expect(katalog.getByTestId('kat-heimnetz')).toBeVisible();
      await pruefeUndFotografiere(page, info, breite, 'm1b-katalog');
      await katalog.getByTestId('kat-heimnetz').click();
      await expect(modal(page).getByRole('heading', { name: '2 Geräte gefunden' })).toBeVisible();
      expect(fehler).toEqual([]);
    });
  });
}
