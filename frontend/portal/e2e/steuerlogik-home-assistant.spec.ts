import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 6, aus Home Assistant übernehmen (`e2e/steuerlogik-home-assistant.tsx`). Übersetzen, Vorschlagen,
 * Prüfen und Speichern rechnet der ECHTE Logik-Dienst: die Spec baut `vp-logik-dienst` aus `edge-app/core` und leitet
 * `/dienst/**` der Bühne an ihn weiter. Hochgeladen werden die Dateien der Test-Anlage des Übersetzers
 * (`edge-app/core/internal/logikdienst/homeassistant/testdata/solarheizung/`, erfunden, gleich aufgebaut wie die Vorlage
 * des Konzepts). Ohne Go im PATH wird die Datei übersprungen (mit Grund).
 *
 * Der durchgehende Fall: unter „Neue Logik“ die Dateien hochladen, die Lücken zuordnen (die Leistungen mit ihrem
 * Vorzeichen), Hinweise und Text lesen, übernehmen, als Logik speichern. Dazu: eine Stelle, die sich nicht übersetzen
 * lässt; eine Datei, die keine YAML ist; eine vorhandene Logik bekommt die Übersetzung als Entwurf. Bei 390 und 1440 px
 * kein Überlauf, Konsole sauber. Mit `BILDER_DIR` legt der Lauf Bilder ab.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
test.describe.configure({ mode: 'serial' });

const BILDER = process.env.BILDER_DIR;
const CORE = fileURLToPath(new URL('../../../edge-app/core', import.meta.url));
const ANLAGE = join(CORE, 'internal/logikdienst/homeassistant/testdata/solarheizung');
const DATEIEN = ['configuration.yaml', 'automations.yaml', 'scripts.yaml'].map((d) => join(ANLAGE, d));
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
  const port = 19_400 + Math.floor(Math.random() * 500);
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
  await page.goto(`/e2e/steuerlogik-home-assistant.html${such}`);
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

/** Ordnet eine Lücke zu: das Feld trägt den Namen der Lücke, die Wahl den Namen in der Anlage. */
async function ordneZu(page: Page, luecke: string, wahl: string) {
  const blatt = page.getByRole('dialog', { name: 'Aus Home Assistant' });
  await blatt.getByRole('combobox', { name: luecke, exact: true }).click();
  await page.getByRole('option', { name: wahl, exact: true }).click();
  // Die Liste schließt, bevor die nächste aufgeht (sonst stünden zwei gleiche Wahlen im Baum).
  await expect(page.getByRole('option', { name: wahl, exact: true })).toHaveCount(0);
  await expect(blatt.getByRole('combobox', { name: luecke, exact: true })).toContainText(wahl);
}

for (const breite of [390, 1440] as const) {
  test(`durchgehend: Dateien hochladen, zuordnen, übernehmen, als Logik speichern (${breite} px)`, async ({ page }) => {
    test.setTimeout(120_000);
    const fehler = await oeffnen(page, breite);
    const karte = page.getByRole('region', { name: 'Aus Home Assistant übernehmen' });
    await expect(karte).toContainText('configuration.yaml, automations.yaml und scripts.yaml');
    await bild(page, 'ha-neue-logik', breite);
    await karte.getByLabel('Dateien von Home Assistant').setInputFiles(DATEIEN);

    // Der Dienst übersetzt und schlägt Geräte und Fühler vor; die Leistungen bleiben offen: ihr Vorzeichen wählt der Mensch.
    const blatt = page.getByRole('dialog', { name: 'Aus Home Assistant' });
    await expect(blatt.getByRole('status').filter({ hasText: 'Noch 2 Lücken zuordnen.' })).toBeVisible({ timeout: 15_000 });
    const zuordnen = blatt.getByRole('region', { name: 'Zuordnen' });
    await expect(zuordnen.getByRole('combobox')).toHaveCount(9);
    await expect(zuordnen.getByRole('combobox', { name: 'Durchlauferhitzer', exact: true })).toContainText('Durchlauferhitzer Speicher 1');
    await expect(zuordnen.getByRole('combobox', { name: 'Solarheizung Speicher 2 oben', exact: true })).toContainText('Speicher 2 oben');
    await expect(zuordnen.getByRole('combobox', { name: 'Wr Ladestand', exact: true })).toContainText('Ladestand der Batterie');
    await expect(zuordnen).toContainText('switch.durchlauferhitzer_l1, switch.durchlauferhitzer_l2, switch.durchlauferhitzer_l3');
    await expect(blatt.getByRole('button', { name: 'Als neue Logik übernehmen' })).toBeDisabled();
    await bild(page, 'ha-blatt-offen', breite, false);

    await ordneZu(page, 'Wr Netzleistung', 'Netz, + ist Bezug');
    await ordneZu(page, 'Wr Akkuleistung', 'Batterie, + ist Entladen');
    await expect(blatt.getByRole('status').filter({ hasText: 'Übersetzt und geprüft.' })).toBeVisible({ timeout: 15_000 });
    await expect(zuordnen).toContainText('Was zählt Home Assistant hier positiv?');

    // Wo die Logik sich anders verhält als Home Assistant, steht an der Stelle; der Text ist lesbar.
    const hinweise = blatt.getByRole('region', { name: 'Hinweise' });
    await expect(hinweise).toContainText('„Heizstufe rauf“ nur jede Minute');
    await expect(hinweise).toContainText('steht hier not_before: 6 min');
    await blatt.getByRole('button', { name: 'Zeigen' }).click();
    const text = blatt.getByRole('region', { name: 'Die Logik als Text' });
    await expect(text).toContainText('netzfenster: time_window(netzheizen_von, netzheizen_bis)');
    await expect(text).toContainText('durchlauferhitzer: {entity: 2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b51, name: Durchlauferhitzer Speicher 1}');
    await bild(page, 'ha-blatt-zugeordnet', breite, false);
    await ohneUeberlauf(page);

    // Übernehmen: der Text ist der Entwurf einer neuen Logik; die Prüfung läuft wie beim Schreiben.
    await blatt.getByRole('button', { name: 'Als neue Logik übernehmen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Solarheizung' })).toBeVisible();
    await expect(page.getByText('Entwurf', { exact: true })).toBeVisible();
    await expect(page.getByText('Geprüft · ohne Proben')).toBeVisible({ timeout: 15_000 });
    await bild(page, 'ha-entwurf', breite);
    await page.getByRole('button', { name: 'Als Fassung speichern' }).click();
    const speichern = page.getByRole('dialog', { name: 'Logik speichern' });
    await expect(speichern.getByLabel('Was hat sich geändert?')).toHaveValue('Aus Home Assistant übersetzt (configuration.yaml, automations.yaml, scripts.yaml)');
    await speichern.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('Fassung 1 ist gespeichert. Sie läuft noch nicht.')).toBeVisible({ timeout: 15_000 });

    const gespeichert = await page.evaluate(() => {
      const w = (window as unknown as { welt: { logiken: Record<string, { fassungen: { text: string; notiz: string | null }[] }>; homeAssistant: { dateien: string[] }[] } }).welt;
      return { fassungen: Object.values(w.logiken).flatMap((l) => l.fassungen), dateien: w.homeAssistant[0].dateien };
    });
    expect(gespeichert.dateien).toEqual(['configuration.yaml', 'automations.yaml', 'scripts.yaml']);
    expect(gespeichert.fassungen).toHaveLength(1);
    expect(gespeichert.fassungen[0].notiz).toBe('Aus Home Assistant übersetzt (configuration.yaml, automations.yaml, scripts.yaml)');
    expect(gespeichert.fassungen[0].text).toContain('wr_akkuleistung: {source: battery.power');
    expect(gespeichert.fassungen[0].text).not.toContain('quelle-');
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('was sich nicht übersetzen lässt, steht mit Datei, Zeile und Grund; keine YAML ist ein Halt (390 px)', async ({ page }) => {
  test.setTimeout(90_000);
  const fehler = await oeffnen(page, 390);
  const karte = page.getByRole('region', { name: 'Aus Home Assistant übernehmen' });
  await karte.getByLabel('Dateien von Home Assistant').setInputFiles([{ name: 'ui-lovelace.json', mimeType: 'application/json', buffer: Buffer.from('{}') }]);
  await expect(karte.getByRole('alert')).toHaveText('„ui-lovelace.json“ ist keine YAML-Datei.');

  await karte.getByLabel('Dateien von Home Assistant').setInputFiles([{
    name: 'automations.yaml', mimeType: 'application/yaml', buffer: Buffer.from(`- id: kurz
  alias: Kurz einschalten
  triggers: [{trigger: time_pattern, minutes: "/1"}]
  actions:
    - action: switch.turn_on
      target: {entity_id: switch.pumpe}
    - delay: "00:05:00"
`),
  }]);
  const blatt = page.getByRole('dialog', { name: 'Aus Home Assistant' });
  await expect(blatt.getByRole('status').filter({ hasText: 'Eine Stelle lässt sich nicht übersetzen.' })).toBeVisible({ timeout: 15_000 });
  const stellen = blatt.getByRole('region', { name: 'Nicht übersetzbar' });
  await expect(stellen).toContainText('automations.yaml, Zeile 7');
  await expect(stellen).toContainText('Abläufe mit Warten gibt es in der Logik nicht');
  await expect(blatt).toContainText('Ohne configuration.yaml und scripts.yaml fehlt');
  await expect(blatt.getByRole('button', { name: 'Als neue Logik übernehmen' })).toBeDisabled();
  await bild(page, 'ha-nicht-uebersetzbar', 390, false);
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('eine vorhandene Logik bekommt die Übersetzung als Entwurf (1440 px)', async ({ page }) => {
  test.setTimeout(90_000);
  const fehler = await oeffnen(page, 1440, '?logik=da');
  await expect(page.getByRole('heading', { level: 1, name: 'Warmwasser' })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Dateien von Home Assistant').setInputFiles(DATEIEN);
  const blatt = page.getByRole('dialog', { name: 'Aus Home Assistant' });
  await expect(blatt.getByRole('status').filter({ hasText: 'Noch 2 Lücken zuordnen.' })).toBeVisible({ timeout: 15_000 });
  await ordneZu(page, 'Wr Netzleistung', 'Netz, + ist Bezug');
  await ordneZu(page, 'Wr Akkuleistung', 'Batterie, + ist Entladen');
  await expect(blatt.getByRole('button', { name: 'Als Entwurf übernehmen' })).toBeEnabled({ timeout: 15_000 });
  await blatt.getByRole('button', { name: 'Als Entwurf übernehmen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Solarheizung' })).toBeVisible();
  await expect(page.getByText('Die Übersetzung ist jetzt Ihr Entwurf.')).toBeVisible();
  await expect(page.getByText('Entwurf', { exact: true })).toBeVisible();
  // Nichts ist gespeichert, bis jemand die Fassung speichert.
  const fassungen = await page.evaluate(() => Object.values((window as unknown as { welt: { logiken: Record<string, { fassungen: unknown[] }> } }).welt.logiken)[0].fassungen.length);
  expect(fassungen).toBe(1);
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});
