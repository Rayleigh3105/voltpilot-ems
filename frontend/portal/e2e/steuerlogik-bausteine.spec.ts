import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 5, Bausteine (`e2e/steuerlogik-bausteine.tsx`). Liste, Füllen, Prüfen und „So verhält sie sich“
 * rechnet der ECHTE Logik-Dienst: die Spec baut `vp-logik-dienst` aus `edge-app/core` und leitet `/dienst/**` der
 * Bühne an ihn weiter - dieselben Leser, dieselbe Prüfung, dieselben Proben wie Box und API. Ohne Go im PATH wird die
 * Datei übersprungen (mit Grund).
 *
 * Der durchgehende Fall: im Reiter „Regeln“ einen Baustein wählen, seine Lücken füllen, „So verhält sie sich“ lesen,
 * speichern, die entstandene Logik mitlaufen lassen. Dazu: der Fachbetrieb speichert eine Logik als Baustein und
 * seine Kunden finden ihn; Bedienberechtigte sehen keine Bausteine. Bei 390 und 1440 px kein Überlauf, Konsole
 * sauber. Mit `BILDER_DIR` legt der Lauf Bilder ab.
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
  const port = 18_900 + Math.floor(Math.random() * 500);
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
  await page.goto(`/e2e/steuerlogik-bausteine.html${such}`);
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

function bausteine(page: Page) {
  return page.getByRole('region', { name: 'Bausteine', exact: true });
}

function tag(page: Page) {
  return page.getByRole('region', { name: 'So verhält sie sich', exact: true });
}

for (const breite of [390, 1440] as const) {
  test(`durchgehend: Baustein wählen, Lücken füllen, So verhält sie sich, speichern, mitlaufen (${breite} px)`, async ({ page }) => {
    test.setTimeout(120_000);
    const fehler = await oeffnen(page, breite);

    // Unter „Neue Regel“ stehen die Bausteine, die zu dieser Anlage passen - mit den Geräten der Anlage im Satz.
    // Kühlraum und Klimagerät fehlen: die Anlage hat kein Gerät mit Sollwert in °C.
    const liste = bausteine(page);
    await expect(liste.getByRole('button', { name: /Aus dem Netz nachheizen/ })).toBeVisible({ timeout: 15_000 });
    await expect(liste.getByRole('button')).toHaveCount(5);
    await expect(liste).not.toContainText('Kälte auf Vorrat');
    await expect(liste.getByRole('button', { name: /Gerät mit Sonnenstrom/ })).toContainText('Schalte Poolpumpe ein');
    await bild(page, 'bausteine-liste', breite);

    // Der Satz aus dem Auftrag, jede Lücke antippbar; „So verhält sie sich“ ist ein Tag aus den Proben.
    await liste.getByRole('button', { name: /Aus dem Netz nachheizen/ }).click();
    const blatt = page.getByRole('dialog', { name: 'Neue Regel' });
    const satz = blatt.getByLabel('Regel als Satz');
    await expect(satz).toContainText('Wenn der Speicher unter');
    await expect(satz.getByRole('button', { name: 'Nie kälter als: 40 °C' })).toBeVisible();
    await expect(satz.getByRole('button', { name: 'Netz erlaubt ab: 06:00' })).toBeVisible();
    const momente = tag(page).getByRole('listitem');
    await expect(momente).toHaveCount(5, { timeout: 15_000 });
    await expect(momente.first()).toContainText('06:00');
    await expect(momente.first()).toContainText('Heizt aus dem Netz');
    await expect(tag(page)).toContainText('Wartet auf das Zeitfenster');
    await bild(page, 'baustein-blatt', breite, false);

    // Lücken füllen: unter 45 °C nachheizen, schon ab 05:30, mit dem Heizstab im Puffer und dem Fühler dort.
    await satz.getByRole('button', { name: /^Nie kälter als/ }).click();
    for (let i = 0; i < 5; i++) await blatt.getByRole('button', { name: 'mehr' }).click();
    await expect(satz.getByRole('button', { name: /^Nie kälter als/ })).toHaveText('45 °C');
    await satz.getByRole('button', { name: /^Netz erlaubt ab/ }).click();
    await blatt.getByRole('button', { name: 'weniger' }).click();
    await expect(satz.getByRole('button', { name: /^Netz erlaubt ab/ })).toHaveText('05:30');
    await satz.getByRole('button', { name: /^Heizstab:/ }).click();
    await blatt.getByRole('button', { name: 'Heizstab Puffer', exact: true }).click();
    await blatt.getByRole('button', { name: /^Speicher: / }).click();
    await blatt.getByRole('button', { name: 'Puffer oben', exact: true }).click();
    await blatt.getByLabel('Name').fill('Puffer nachheizen');

    // Der Dienst rechnet den Tag mit genau diesen Werten neu: das Fenster geht um 05:30 auf.
    await expect(momente.first()).toContainText('05:30', { timeout: 15_000 });
    await expect(tag(page)).toContainText('Das Zeitfenster geht auf, der Speicher ist zu kalt');
    await bild(page, 'baustein-gefuellt', breite, false);
    await ohneUeberlauf(page);

    // Speichern: es entsteht eine gewöhnliche Logik (Fassung 1), die noch nicht läuft - auf ihrer Seite.
    await blatt.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Puffer nachheizen' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Fassung 1 ist gespeichert und läuft noch nicht.')).toBeVisible();
    const gespeichert = await page.evaluate(() => (window as unknown as { welt: { fassungen: { text: string; notiz: string }[] } }).welt.fassungen[0]);
    expect(gespeichert.notiz).toBe('Aus dem Baustein „Aus dem Netz nachheizen“');
    expect(gespeichert.text).toContain('stab: ');
    expect(gespeichert.text).toContain('"45 °C"');
    expect(gespeichert.text).toContain('"05:30"');
    expect(gespeichert.text).toContain('"2c4e6a8b-1d3f-4b5a-9c7e-0f1e2d3c4b5a"');
    expect(gespeichert.text).toContain('"4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b.temperature"');
    expect(gespeichert.text).not.toContain('geraet-heizstab');
    await bild(page, 'logik-gespeichert', breite);

    // Mitlaufen wie jede Logik (Stufe 4).
    await page.getByRole('button', { name: 'Fassung 1 mitlaufen lassen' }).click();
    await expect(page.getByText('Läuft mit · Fassung 1').first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { aufgerufen: string[] }).aufgerufen))
      .toEqual(expect.arrayContaining(['bausteine', 'vorschau:netzheizen-zeitfenster', 'einsetzen:netzheizen-zeitfenster', 'mitlaufen:1']));
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('der Fachbetrieb speichert eine Logik als Baustein, seine Kunden finden ihn (1440 px)', async ({ page }) => {
  test.setTimeout(120_000);
  const fehler = await oeffnen(page, 1440, '?person=TB&logik=1');
  await expect(page.getByRole('heading', { level: 1, name: 'Warmwasser Keller' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Als Baustein speichern' }).click();
  const blatt = page.getByRole('dialog', { name: 'Als Baustein speichern' });
  await expect(blatt.getByLabel('Satz')).toHaveValue(/\{heizstab\}/);
  await blatt.getByLabel('Name').fill('Speicher mit Sonne (Brunner)');
  await blatt.getByLabel('Satz').fill('Heize mit');
  await blatt.getByRole('button', { name: 'Heizstab Puffer' }).click();
  await blatt.getByRole('button', { name: 'Mit Sonnenstrom bis' }).click();
  await expect(blatt.getByLabel('Satz')).toHaveValue('Heize mit {heizstab} {ziel}');
  await bild(page, 'als-baustein', 1440, false);
  await blatt.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Gespeichert. Ihre Kunden finden ihn unter „Neue Regel“.')).toBeVisible();
  const doc = await page.evaluate(() => (window as unknown as { welt: { bausteine: { text: string }[] } }).welt.bausteine[0].text);
  expect(doc).toContain('sentence: "Heize mit {heizstab} {ziel}"');
  expect(doc).not.toContain('7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f');

  // Zurück zu den Regeln: der eigene Baustein steht in der Liste, mit dem Satz der Anlage.
  await page.getByRole('button', { name: 'Regeln' }).click();
  const eigen = bausteine(page).getByRole('button', { name: /Speicher mit Sonne \(Brunner\)/ });
  await expect(eigen).toContainText('Ihr Baustein', { timeout: 15_000 });
  await expect(eigen).toContainText('Heize mit Heizstab');
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('beim Kunden steht der Baustein des Fachbetriebs mit dessen Namen; Bedienberechtigte sehen keine (390 px)', async ({ page }) => {
  test.setTimeout(90_000);
  const fehler = await oeffnen(page, 390, '?fachbetrieb=1');
  const karte = bausteine(page).getByRole('button', { name: /Speicher mit Sonne \(Brunner\)/ });
  await expect(karte).toContainText('Thomas Brunner', { timeout: 15_000 });
  await karte.click();
  await expect(tag(page).getByRole('listitem')).toHaveCount(5, { timeout: 15_000 });
  await expect(page.getByRole('dialog', { name: 'Neue Regel' }).getByRole('button', { name: 'Entfernen' })).toHaveCount(0);
  await bild(page, 'fachbetrieb-beim-kunden', 390, false);
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);

  const md = await oeffnen(page, 390, '?person=MD&fachbetrieb=1');
  await expect(page.getByRole('button', { name: 'Neue Regel' })).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { aufgerufen: string[] }).aufgerufen.includes('bausteine'));
  await expect(bausteine(page)).toHaveCount(0);
  expect(md).toEqual([]);
});
