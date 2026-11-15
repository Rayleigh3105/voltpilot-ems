import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 4, Aufbau und Text (`e2e/steuerlogik-bearbeiten.tsx`). Prüfen und Speichern fragen den ECHTEN
 * Logik-Dienst: die Spec baut `vp-logik-dienst` aus `edge-app/core` und leitet `/dienst/**` der Bühne an ihn weiter -
 * dieselben Leser und dieselbe Prüfung wie Box und API. Ohne Go im PATH wird die Datei übersprungen (mit Grund).
 *
 * Der durchgehende Fall: eine Beispiel-Logik im Aufbau ändern, im Text prüfen (Meldung an der Zeile, dann
 * behoben), als Fassung speichern, mitlaufen lassen. Dazu: Aufbau und Text bleiben eins, die Wortliste, die
 * Fassungen mit Vergleich, das Protokoll, Bedienberechtigte (nur lesen, Änderung anfragen), die Plattform (eine
 * vorgelegte Fassung scharf schalten), eine neue Logik, die die Prüfung besteht. Bei 390 und 1440 px kein Überlauf,
 * Konsole sauber. Mit `BILDER_DIR` legt der Lauf Bilder ab.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
test.describe.configure({ mode: 'serial' });

const BILDER = process.env.BILDER_DIR;
const CORE = fileURLToPath(new URL('../../../edge-app/core', import.meta.url));
let dienst: ChildProcess | null = null;
let dienstUrl = '';
let ordner = '';
let ohneGo: string | null = null;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  ordner = mkdtempSync(join(tmpdir(), 'vp-logik-dienst-'));
  const programm = join(ordner, 'vp-logik-dienst');
  try {
    execFileSync('go', ['build', '-o', programm, './cmd/vp-logik-dienst'], { cwd: CORE, stdio: 'pipe' });
  } catch (e) {
    ohneGo = `vp-logik-dienst ließ sich nicht bauen (Go?): ${(e as Error).message.split('\n')[0]}`;
    return;
  }
  const port = 18_400 + Math.floor(Math.random() * 500);
  dienstUrl = `http://127.0.0.1:${port}`;
  dienst = spawn(programm, [], { env: { ...process.env, LOGIK_DIENST_PORT: String(port), LOGIK_DIENST_BIND: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${dienstUrl}/health`)).ok) return;
    } catch {
      // startet noch
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('vp-logik-dienst antwortet nicht');
});

test.afterAll(() => {
  dienst?.kill();
  if (ordner) rmSync(ordner, { recursive: true, force: true });
});

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(ohneGo != null, ohneGo ?? '');
  test.skip(testInfo.project.name !== 'desktop-chromium', 'eine Bühne, ein Browser; die Breiten setzt der Fall');
  void browserName;
});

async function oeffnen(page: Page, breite: 390 | 1440, such = '') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.route('**/dienst/**', async (route) => {
    const url = new URL(route.request().url());
    const r = await fetch(`${dienstUrl}${url.pathname.replace(/^\/dienst/, '')}`, {
      method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() ?? undefined,
    });
    await route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
  });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
  await page.goto(`/e2e/steuerlogik-bearbeiten.html${such}`);
  return fehler;
}

async function ohneUeberlauf(page: Page) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s).toBeLessThanOrEqual(w.c);
}

async function bild(page: Page, name: string, breite: number, ganz = true) {
  if (!BILDER) return;
  if (ganz) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${BILDER}/${name}-${breite}.png`, fullPage: ganz, animations: 'disabled' });
}

function aufbau(page: Page) {
  return page.getByRole('tabpanel', { name: 'Aufbau' });
}

test('durchgehend: im Aufbau ändern, im Text prüfen, als Fassung speichern, mitlaufen lassen (1440 px)', async ({ page }) => {
  test.setTimeout(120_000);
  const fehler = await oeffnen(page, 1440);
  await expect(page.getByRole('heading', { level: 1, name: 'Warmwasser' })).toBeVisible();
  await expect(page.getByText('Läuft mit · Fassung 1')).toBeVisible();
  await expect(aufbau(page).getByRole('region', { name: 'Stellwerte', exact: true })).toContainText('57 °C (45 °C bis 65 °C) · Kunde stellt');
  await bild(page, 'aufbau', 1440);

  // Im Aufbau: „Mit Sonnenstrom bis“ auf 60 °C.
  await aufbau(page).getByRole('button', { name: /Stellwert Mit Sonnenstrom bis/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Mit Sonnenstrom bis' });
  await expect(blatt.getByLabel('Vorgabe')).toHaveValue('57 °C');
  await blatt.getByLabel('Vorgabe').fill('60 °C');
  await bild(page, 'aufbau-stellwert', 1440, false);
  await blatt.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(blatt).toBeHidden();
  await expect(aufbau(page).getByRole('region', { name: 'Stellwerte', exact: true })).toContainText('60 °C (45 °C bis 65 °C)');
  await expect(page.getByText('Entwurf', { exact: true })).toBeVisible();
  // Der echte Dienst prüft: mit 60 °C ist ein Speicher mit 57,2 °C nicht mehr warm - die Probe dazu besteht nicht
  // und sperrt (Lesart zu E5), die Meldung steht an der Probe.
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('1 Fehler', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Als Fassung speichern' })).toBeDisabled();
  const proben = aufbau(page).getByRole('region', { name: 'Proben', exact: true });
  await expect(proben).toContainText('Probe „Speicher ist warm“ besteht nicht');
  await bild(page, 'aufbau-probe', 1440);
  await proben.getByRole('button', { name: /^Probe Speicher ist warm/ }).click();
  const probe = page.getByRole('dialog', { name: 'Speicher ist warm' });
  const t = probe.getByRole('textbox', { name: 'Wert' }).first();
  await expect(t).toHaveValue('57.2 °C');
  await t.fill('60.2 °C');
  await probe.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('Geprüft · 5 Proben bestanden', { timeout: 15_000 });

  // Im Text steht die Änderung an ihrer Zeile; ein Fehler steht an seiner Zeile, bis er behoben ist.
  await page.getByRole('tab', { name: 'Text' }).click();
  const feld = page.getByRole('textbox', { name: 'Text der Logik' });
  const text = await feld.inputValue();
  expect(text).toContain('ziel:      {name: Mit Sonnenstrom bis, default: 60 °C,');
  expect(text.split('\n').length).toBe((await page.evaluate(() => (window as unknown as { welt: { fassungen: { text: string }[] } }).welt.fassungen[0].text)).split('\n').length);
  const zeile = text.split('\n').findIndex((l) => l.includes('Das Netz hilft nicht aus: netz < 0.3 kW')) + 1;
  await feld.fill(text.replace('Das Netz hilft nicht aus: netz < 0.3 kW', 'Das Netz hilft nicht aus: netz < 3 °C'));
  const meldungen = page.getByRole('list', { name: 'Meldungen der Prüfung' });
  await expect(meldungen.getByRole('button').first()).toContainText(`Zeile ${zeile}`, { timeout: 15_000 });
  await expect(meldungen.getByRole('button').first()).toContainText('Einheiten passen nicht');
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('1 Fehler');
  await expect(page.getByRole('button', { name: 'Als Fassung speichern' })).toBeDisabled();
  await expect(page.locator('.lk-editor .lk-rinne > span.fehler')).toHaveText(String(zeile));
  // Ein Tipp auf die Meldung setzt die Schreibmarke an ihre Zeile.
  await meldungen.getByRole('button').first().click();
  expect(await feld.evaluate((t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart).split('\n').length)).toBe(zeile);
  await bild(page, 'text-meldung', 1440, false);
  // Auch der Aufbau zeigt die Meldung an ihrem Eintrag.
  await page.getByRole('tab', { name: 'Aufbau' }).click();
  await expect(aufbau(page).getByRole('region', { name: 'Zustände und Zeitgeber', exact: true })).toContainText(`Zeile ${zeile}:`);
  await page.getByRole('tab', { name: 'Text' }).click();
  await feld.fill((await feld.inputValue()).replace('netz < 3 °C', 'netz < 0.3 kW'));
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('Geprüft · 5 Proben bestanden', { timeout: 15_000 });

  // Die Wortliste daneben.
  await page.getByRole('button', { name: 'Wörter' }).click();
  const woerter = page.getByRole('dialog', { name: 'Wörter der Textform' });
  await woerter.getByLabel('Suchen').fill('holds');
  await expect(woerter.getByRole('region', { name: 'Funktionen', exact: true })).toContainText('holds(Bedingung, Dauer): gilt seit mindestens');
  await bild(page, 'woerter', 1440, false);
  await woerter.getByRole('button', { name: 'Schließen' }).click();

  // Als Fassung speichern, mit Notiz; sie läuft danach noch nicht.
  await page.getByRole('button', { name: 'Als Fassung speichern' }).click();
  const speichern = page.getByRole('dialog', { name: 'Als Fassung 2 speichern' });
  await speichern.getByLabel('Was hat sich geändert?').fill('Sonnenziel 60 °C');
  await speichern.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Fassung 2 ist gespeichert. Sie läuft noch nicht.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toBeHidden();
  await expect(page.getByText('Fassung 2 ist gespeichert und läuft noch nicht.')).toBeVisible();

  // Mitlaufen lassen: Fassung 2 löst Fassung 1 ab, die Box rechnet mit, schaltet nichts.
  await page.getByRole('button', { name: 'Mitlaufen lassen' }).click();
  await expect(page.getByText('Läuft mit · Fassung 2')).toBeVisible();
  await page.getByRole('tab', { name: 'Mitlaufen' }).click();
  const lauf = page.getByRole('tabpanel', { name: 'Mitlaufen' });
  await expect(lauf.getByRole('heading', { name: 'Fassung 2 läuft mit' })).toBeVisible();
  await expect(lauf.getByRole('list', { name: 'Vergleich je Gerät' })).toContainText('6 s von 2 min verschieden');
  await expect(lauf.getByRole('region', { name: 'Vergleichsprotokoll', exact: true })).toContainText('Logik will');
  await bild(page, 'mitlaufen', 1440);

  // Fassungen: Vergleich zeigt genau die geänderte Zeile.
  await page.getByRole('tab', { name: 'Fassungen' }).click();
  await expect(page.locator('[data-fassung="2"]')).toContainText('Jonas Wendlinger (Kundenadministrator) · 5 von 5 Proben');
  await expect(page.locator('[data-fassung="2"]')).toContainText('„Sonnenziel 60 °C“');
  await page.locator('[data-fassung="1"]').getByRole('button', { name: 'Mit 2 vergleichen' }).click();
  const vergleich = page.getByRole('dialog', { name: 'Fassung 1 und 2' });
  await expect(vergleich).toContainText('2 Zeilen dazu, 2 weg');
  await expect(vergleich.locator('.lk-diff .dazu').first()).toContainText('default: 60 °C');
  await expect(vergleich.locator('.lk-diff .weg').first()).toContainText('default: 57 °C');
  await expect(vergleich.locator('.lk-diff .dazu').nth(1)).toContainText('t: 60.2 °C');
  await bild(page, 'fassungen-vergleich', 1440, false);
  await vergleich.getByRole('button', { name: 'Schließen' }).click();

  // Protokoll: wer hat wann was getan.
  await page.getByRole('tab', { name: 'Protokoll' }).click();
  const protokoll = page.getByRole('region', { name: 'Protokoll', exact: true });
  await expect(protokoll).toContainText('Fassung 2 läuft mit');
  await expect(protokoll).toContainText('Fassung 2 gespeichert: Sonnenziel 60 °C');
  await expect(protokoll).toContainText('„Nie kälter als“: 40 °C → 42 °C');
  await bild(page, 'protokoll', 1440);
  expect(await page.evaluate(() => (window as unknown as { aufgerufen: string[] }).aufgerufen)).toEqual(
    expect.arrayContaining(['pruefen', 'speichern', 'mitlaufen:2']),
  );
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Aufbau und Text bleiben eins: eine Bedingung im Aufbau steht sofort im Text, Kommentare bleiben (1440 px)', async ({ page }) => {
  const fehler = await oeffnen(page, 1440);
  const vorher = await page.evaluate(() => (window as unknown as { welt: { fassungen: { text: string }[] } }).welt.fassungen[0].text);
  await aufbau(page).getByRole('button', { name: /Zustand Netzheizen|Zustand netzheizen/ }).click();
  const blatt = page.getByRole('dialog', { name: /netzheizen/i });
  await blatt.getByRole('button', { name: 'Bedingung', exact: true }).first().click();
  const zeilen = blatt.locator('.lk-zeile');
  const neu = zeilen.nth(2);
  await neu.getByLabel('Satz für den Kunden').fill('Die Batterie ist nicht voll');
  await neu.getByLabel('Formel').fill('ladestand < 99 %');
  await blatt.getByRole('button', { name: 'Übernehmen' }).click();
  await page.getByRole('tab', { name: 'Text' }).click();
  const text = await page.getByRole('textbox', { name: 'Text der Logik' }).inputValue();
  expect(text).toContain('      - Die Batterie ist nicht voll: ladestand < 99 %\n');
  // Nur Zeilen dazu, keine geändert: die Kommentare oben und jede andere Zeile bleiben, wie sie waren.
  const a = vorher.split('\n');
  const b = text.split('\n');
  expect(b.length).toBe(a.length + 1);
  expect(b.filter((z) => !a.includes(z))).toEqual(['      - Die Batterie ist nicht voll: ladestand < 99 %']);
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('Geprüft', { timeout: 15_000 });
  expect(fehler).toEqual([]);
});

test('am Telefon: Aufbau und Text lesbar, kein Überlauf (390 px)', async ({ page }) => {
  const fehler = await oeffnen(page, 390);
  await expect(page.getByRole('heading', { level: 1, name: 'Warmwasser' })).toBeVisible();
  await ohneUeberlauf(page);
  await bild(page, 'aufbau', 390);
  await aufbau(page).getByRole('button', { name: /Zustand netzheizen|Zustand Netzheizen/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Geht an, wenn alles gilt');
  await bild(page, 'aufbau-zustand', 390, false);
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('textbox', { name: 'Text der Logik' })).toBeHidden();
  const lesen = page.getByRole('region', { name: 'Text der Logik', exact: true }).last();
  await expect(lesen).toBeVisible();
  await expect(page.getByText('Schreiben geht am Rechner.')).toBeVisible();
  await ohneUeberlauf(page);
  await bild(page, 'text', 390);
  for (const tab of ['Mitlaufen', 'Fassungen', 'Protokoll']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
    await ohneUeberlauf(page);
    await bild(page, tab.toLowerCase(), 390);
  }
  expect(fehler).toEqual([]);
});

for (const breite of [390, 1440] as const) {
  test(`Bedienberechtigte sehen die Logik und fragen eine Änderung an (${breite} px)`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, '?rolle=bedienberechtigt');
    await expect(page.getByRole('heading', { level: 1, name: 'Warmwasser' })).toBeVisible();
    await expect(aufbau(page).getByRole('button', { name: 'Stellwert', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Text' }).click();
    await expect(page.getByRole('textbox', { name: 'Text der Logik' })).toHaveCount(0);
    await expect(page.getByText('YAML · ').first()).toContainText('nur lesen');
    await page.getByRole('button', { name: 'Änderung anfragen' }).click();
    const blatt = page.getByRole('dialog', { name: 'Änderung anfragen' });
    await blatt.getByLabel('Was soll sich ändern?').fill('Bitte schon ab 5 Uhr aus dem Netz heizen.');
    await bild(page, 'anfrage', breite, false);
    await blatt.getByRole('button', { name: 'Anfrage senden' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Ihre Anfrage ist angekommen.' })).toBeVisible();
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`die Plattform schaltet eine vorgelegte Fassung scharf (${breite} px)`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, '?rolle=plattform&vorgelegt=1&anfrage=1');
    await expect(page.getByText('Fassung 2 liegt zur Freigabe vor.')).toBeVisible();
    await expect(page.getByText('Eine Bitte um Änderung liegt vor.')).toBeVisible();
    await bild(page, 'plattform-vorgelegt', breite, false);
    await page.getByRole('button', { name: 'Scharf schalten' }).first().click();
    const blatt = page.getByRole('dialog', { name: 'Fassung 2 scharf schalten' });
    await expect(blatt).toContainText('Home Assistant');
    await blatt.getByRole('button', { name: 'Hinweise gelesen, scharf schalten' }).click();
    await expect(page.getByText('Scharf · Fassung 2')).toBeVisible();
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('der Kundenadministrator legt eine Fassung einer scharfen Logik vor, statt sie scharf zu schalten (1440 px)', async ({ page }) => {
  const fehler = await oeffnen(page, 1440, '?scharf=1');
  await expect(page.getByText('Scharf · Fassung 1')).toBeVisible();
  await aufbau(page).getByRole('button', { name: /Stellwert Mit Sonnenstrom bis/ }).click();
  await page.getByRole('dialog').getByLabel('Vorgabe').fill('56 °C');
  await page.getByRole('dialog').getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('Geprüft', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Als Fassung speichern' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Fassung 2 ist gespeichert. Scharf schaltet VoltPilot.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mitlaufen lassen' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Zur Freigabe vorlegen' }).click();
  await expect(page.getByText('Fassung 2 liegt VoltPilot zur Freigabe vor.')).toBeVisible();
  expect(fehler).toEqual([]);
});

test('eine neue Logik beginnt mit Name und Gerät und besteht die Prüfung (1440 px)', async ({ page }) => {
  const fehler = await oeffnen(page, 1440, '?logik=neu');
  await page.evaluate(() => window.localStorage.clear());
  await expect(page.getByRole('heading', { level: 1, name: 'Neue Logik' })).toBeVisible();
  await page.getByLabel('Name').fill('Wärmepumpe mit Sonne');
  await page.getByRole('combobox', { name: 'Gerät' }).click();
  await page.getByRole('option', { name: /Wärmepumpe/ }).click();
  await page.getByRole('button', { name: 'Logik beginnen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Wärmepumpe mit Sonne' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Entwurf', exact: true })).toContainText('Geprüft · ohne Proben', { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('textbox', { name: 'Text der Logik' })).toHaveValue(/geraet: \{mode: "if\(sonnenstrom, boost, normal\)"\}/);
  await bild(page, 'neu', 1440);
  await page.getByRole('button', { name: 'Als Fassung speichern' }).click();
  await expect(page.getByRole('dialog', { name: 'Logik speichern' })).toBeVisible();
  expect(fehler).toEqual([]);
});

test('die Logiken im Reiter „Regeln“ (390 und 1440 px)', async ({ page }) => {
  for (const breite of [390, 1440] as const) {
    const fehler = await oeffnen(page, breite, '?buehne=regeln');
    const karte = page.locator('[data-logik]');
    await expect(karte).toContainText('Warmwasser');
    await expect(karte).toContainText('Läuft mit · Fassung 1');
    await expect(page.getByRole('button', { name: 'Neue Logik' })).toBeVisible();
    await ohneUeberlauf(page);
    await bild(page, 'regeln', breite);
    expect(fehler).toEqual([]);
  }
});
