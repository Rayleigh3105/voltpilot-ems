import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';

/**
 * Die geplanten Messstellen unter Messen (Konzept Auswerten a1, Entscheid 9 „Messplanung nach Messen“) bei 375 px und
 * 1440 px, auf der Bühne `e2e/geplante-messstellen.html` (die ECHTE `MessstellenPage` mit `useEntscheidFokus`, Routen
 * von Messbedarf und Messstellen-Dialog aus `src/test/messplanungBuehne.ts`): MB-1 an Halle 1, MB-2 ohne Ort mit
 * überschrittener Frist.
 *
 * - Die Liste: MB-1 nach den Messstellen von Halle 1, MB-2 unter „Kein Ort zugeordnet“, die Hinweiskarte zur Frist,
 *   die Marke „2 geplant“.
 * - „Einrichten“: der ECHTE Messstellen-Dialog mit Ort und Größe des Bedarfs → MS-23 eingerichtet, „Später festlegen“ →
 *   der Bedarf ist eingelöst, an seiner Stelle steht MS-23 mit „Noch keine Quelle“ (nie 0).
 * - Der Schritt „Messstelle anlegen“ der Wiedervorlage (`?entscheid=messbedarf_frist&kennzeichen=MB-2`) führt den Blick
 *   auf „Einrichten“ von MB-2.
 * - „Messbedarf erfassen“ im Menü ⋯ und die Sicht ohne das Recht, Energieeinsätze zu verwalten.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente. `GEPLANT_BILDER=<Ordner>` legt je Fall ein Bild ab.
 */

const expect = baseExpect.configure({ timeout: 30_000 });
const BILDER = process.env.GEPLANT_BILDER;
const AM_20_10 = new Date('2026-10-20T08:00:00Z');

async function oeffne(page: Page, adresse: string, breite: number) {
  await page.clock.setFixedTime(AM_20_10);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(adresse);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('messstelle-reihe').first()).toBeVisible();
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueber = [...document.querySelectorAll<HTMLElement>('main *, .vp-modal *')]
      .filter((e) => sichtbar(e))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueber: [...new Set(ueber)] };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueber, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: ganz });
}

const modal = (page: Page) => page.locator('.vp-modal');
const picker = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });
const karte = (page: Page, ort: string) =>
  page.getByTestId('messstellen-ort').filter({ has: page.getByRole('heading', { level: 2, name: ort, exact: true }) });
const geplant = (page: Page, kz: string) => page.getByTestId('geplante-messstelle').filter({ hasText: kz });

async function waehle(page: Page, feld: string, option: RegExp) {
  const f = picker(page, feld);
  await f.click();
  const id = await f.getAttribute('id');
  const liste: Locator = id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
  await liste.getByRole('option', { name: option }).first().click();
}

for (const breite of [375, 1440]) {
  test.describe(`Geplante Messstellen bei ${breite} px`, () => {
    test('an ihrem Ort nach den Messstellen, ohne Ort bei „Kein Ort zugeordnet“; Frist, Marke und Hinweiskarte', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html#/portfolio/messstellen', breite);
      const mb1 = geplant(page, 'MB-1');
      await expect(mb1).toBeVisible();
      await expect(karte(page, 'Halle 1').getByTestId('geplante-messstelle')).toHaveCount(1);
      await expect(karte(page, 'Halle 1')).toContainText('Werk Ahrenberg · 2 · 1 geplant');
      await expect(mb1).toContainText('Lüftung, Beleuchtung und Allgemeinstrom Halle 1');
      await expect(mb1.locator('.vp-ms-reihe-satz')).toContainText('Geplant für EE-8 Gebäudetechnik Halle 1');
      await expect(mb1.locator('.vp-ms-frist')).toHaveText('Frist 31.03.2027');
      await expect(mb1.getByRole('button', { name: /MB-1\) einrichten$/ })).toBeVisible();
      await expect(karte(page, 'Kein Ort zugeordnet').getByTestId('geplante-messstelle')).toContainText('MB-2');
      await expect(geplant(page, 'MB-2')).toContainText('Frist 30.09.2026 überschritten');
      await expect(page.getByTestId('messstellen-hinweise')).toContainText('Druckluft-Leckagen Halle 2 messen (MB-2) ist noch nicht eingerichtet');
      await ablegen(page, `geplant-liste-${breite}`, true);
      await mb1.scrollIntoViewIfNeeded();
      await ablegen(page, `geplant-halle1-${breite}`);
      await ohneQuerlauf(page, `liste-${breite}`);

      // Die Karte filtert auf die geplanten - wie die Marke „2 geplant“.
      await page.getByTestId('messstellen-hinweise').getByRole('button').click();
      const marke = page.getByTestId('messstellen-marken').getByRole('button', { name: '2 geplant' });
      await expect(marke).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('messstelle-reihe')).toHaveCount(0);
      await expect(page.getByTestId('geplante-messstelle')).toHaveCount(2);
      await expect(page.locator('.vp-ms-treffer')).toHaveText('2 geplante Messstellen');
      await ablegen(page, `geplant-marke-${breite}`, true);
      await ohneQuerlauf(page, `marke-${breite}`);
    });

    test('„Einrichten“: der Messstellen-Dialog mit Ort und Größe; danach steht MS-23 an der Stelle des Bedarfs - ohne Quelle, nie 0', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html#/portfolio/messstellen', breite);
      await geplant(page, 'MB-1').getByRole('button', { name: /einrichten$/ }).click();
      await expect(modal(page).getByLabel('Kennzeichen')).toHaveValue('MS-23');
      await expect(picker(page, 'Hauptgröße *')).toContainText('Wirkenergie');
      await expect(picker(page, 'Richtung *')).toContainText('Bezug');
      await modal(page).getByLabel('Name *').fill('Halle 1 Allgemein');
      await waehle(page, 'Wertart *', /^Zählerstand/);
      await ablegen(page, `geplant-einrichten-${breite}`);
      await modal(page).getByRole('button', { name: 'Weiter: Zuordnung' }).click();
      await expect(picker(page, 'Ort')).toContainText('Halle 1');
      await ohneQuerlauf(page, `einrichten-ort-${breite}`);
      await modal(page).getByRole('button', { name: 'Weiter: Quelle' }).click();
      await modal(page).getByRole('button', { name: 'Später festlegen' }).click();
      await expect(modal(page)).toContainText('noch keine Quelle');
      await modal(page).getByRole('button', { name: 'Schließen' }).first().click();

      const satz = page.getByTestId('geplante-satz');
      await expect(satz).toHaveText('Messbedarf MB-1 ist eingelöst - MS-23 Halle 1 Allgemein steht jetzt in der Liste.');
      await expect(satz).toBeFocused();
      await expect(geplant(page, 'MB-1')).toHaveCount(0);
      const ms23 = karte(page, 'Halle 1').getByTestId('messstelle-reihe').filter({ hasText: 'MS-23' });
      await expect(ms23).toContainText('Noch keine Quelle');
      await expect(ms23).not.toContainText(/\b0\s?kWh/);
      await expect(karte(page, 'Halle 1')).not.toContainText('geplant');
      await ablegen(page, `geplant-eingeloest-${breite}`, true);
      await ohneQuerlauf(page, `eingeloest-${breite}`);
    });

    test('antwortet das Einlösen erst nach dem Schließen, verschwindet die geplante Messstelle mit der Antwort', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?langsam=1#/portfolio/messstellen', breite);
      await geplant(page, 'MB-1').getByRole('button', { name: /einrichten$/ }).click();
      await expect(modal(page).getByLabel('Kennzeichen')).toHaveValue('MS-23');
      await modal(page).getByLabel('Name *').fill('Halle 1 Allgemein');
      await waehle(page, 'Wertart *', /^Zählerstand/);
      await modal(page).getByRole('button', { name: 'Weiter: Zuordnung' }).click();
      await modal(page).getByRole('button', { name: 'Weiter: Quelle' }).click();
      // Sofort zu - das Einlösen ist noch unterwegs; das Neulesen beim Schließen sieht den Bedarf noch offen.
      await modal(page).getByRole('button', { name: 'Später festlegen' }).click();
      await modal(page).getByRole('button', { name: 'Schließen' }).first().click();
      await expect(page.getByTestId('geplante-satz')).toHaveText('Messbedarf MB-1 ist eingelöst - MS-23 Halle 1 Allgemein steht jetzt in der Liste.');
      await expect(geplant(page, 'MB-1')).toHaveCount(0);
      await expect(page.getByTestId('messstellen-marken').getByRole('button', { name: '1 geplant' })).toBeVisible();
    });

    test('zitieren freigegebene Berichtsstände den Bedarf, lehnt der Server das Einlösen ab: der Satz sagt es, die Messstelle bleibt', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?beleg=1#/portfolio/messstellen', breite);
      await geplant(page, 'MB-1').getByRole('button', { name: /einrichten$/ }).click();
      await expect(modal(page).getByLabel('Kennzeichen')).toHaveValue('MS-23');
      await modal(page).getByLabel('Name *').fill('Halle 1 Allgemein');
      await waehle(page, 'Wertart *', /^Zählerstand/);
      await modal(page).getByRole('button', { name: 'Weiter: Zuordnung' }).click();
      await modal(page).getByRole('button', { name: 'Weiter: Quelle' }).click();
      await modal(page).getByRole('button', { name: 'Später festlegen' }).click();
      await modal(page).getByRole('button', { name: 'Schließen' }).first().click();

      const satz = page.getByTestId('geplante-satz');
      await expect(satz).toHaveText(
        '2 freigegebene Berichtsstände zitieren diesen Messbedarf (BR-2026-0002 Nr. 1, BR-2027-0001 Nr. 1) - er bleibt, wie er ist. Die Messstelle MS-23 ist trotzdem eingerichtet und steht in der Liste; MB-1 bleibt geplant.',
      );
      await expect(satz).toHaveAttribute('role', 'alert');
      await expect(satz).toBeFocused();
      await expect(geplant(page, 'MB-1')).toHaveCount(1);
      await expect(karte(page, 'Halle 1').getByTestId('messstelle-reihe').filter({ hasText: 'MS-23' })).toContainText('Noch keine Quelle');
      // Review r4 M4 (Entscheid c): die Reihe bietet jetzt „MS-23 zuordnen“ - kein zweites „Einrichten“, keine MS-24.
      const zuordnen = geplant(page, 'MB-1').getByRole('button', { name: /^MS-23 .*zuordnen$/ });
      await expect(zuordnen).toBeVisible();
      await expect(geplant(page, 'MB-1').getByRole('button', { name: /einrichten$/ })).toHaveCount(0);
      await ablegen(page, `geplant-beleg-${breite}`);
      await ohneQuerlauf(page, `beleg-${breite}`);
      await zuordnen.click();
      await expect(satz).toHaveText('2 freigegebene Berichtsstände zitieren diesen Messbedarf (BR-2026-0002 Nr. 1, BR-2027-0001 Nr. 1) - er bleibt, wie er ist.');
      await expect(geplant(page, 'MB-1').getByRole('button', { name: /^MS-23 .*zuordnen$/ })).toBeVisible();
      await expect(page.getByTestId('messstelle-reihe').filter({ hasText: 'MS-24' })).toHaveCount(0);
    });

    test('scheitert nur das erste Einlösen, löst „MS-23 zuordnen“ mit derselben Messstelle ein (Review r4 M4)', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?beleg=einmal#/portfolio/messstellen', breite);
      await geplant(page, 'MB-1').getByRole('button', { name: /einrichten$/ }).click();
      await expect(modal(page).getByLabel('Kennzeichen')).toHaveValue('MS-23');
      await modal(page).getByLabel('Name *').fill('Halle 1 Allgemein');
      await waehle(page, 'Wertart *', /^Zählerstand/);
      await modal(page).getByRole('button', { name: 'Weiter: Zuordnung' }).click();
      await modal(page).getByRole('button', { name: 'Weiter: Quelle' }).click();
      await modal(page).getByRole('button', { name: 'Später festlegen' }).click();
      await modal(page).getByRole('button', { name: 'Schließen' }).first().click();
      await geplant(page, 'MB-1').getByRole('button', { name: /^MS-23 .*zuordnen$/ }).click();
      await expect(page.getByTestId('geplante-satz')).toHaveText('Messbedarf MB-1 ist eingelöst - MS-23 Halle 1 Allgemein steht jetzt in der Liste.');
      await expect(geplant(page, 'MB-1')).toHaveCount(0);
      await expect(page.getByTestId('messstelle-reihe').filter({ hasText: 'MS-23' })).toHaveCount(1);
      await expect(page.getByTestId('messstelle-reihe').filter({ hasText: 'MS-24' })).toHaveCount(0);
    });

    test('sagt die API vorher, dass Berichtsstände den Bedarf zitieren: der Satz statt „Einrichten“, der Blick der Wiedervorlage darauf (Review r4 M4)', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?zitiert=1#/portfolio/messstellen?entscheid=messbedarf_frist&kennzeichen=MB-1', breite);
      const mb1 = geplant(page, 'MB-1');
      const satz = mb1.getByTestId('geplante-zitiert');
      await expect(satz).toHaveText('2 freigegebene Berichtsstände zitieren diesen Messbedarf (BR-2026-0002 Nr. 1, BR-2027-0001 Nr. 1) - er bleibt, wie er ist.');
      await expect(satz).toBeFocused();
      await expect(mb1.getByRole('button')).toHaveCount(0);
      await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
      await ablegen(page, `geplant-zitiert-${breite}`);
      await ohneQuerlauf(page, `zitiert-${breite}`);
    });

    test('der Schritt „Messstelle anlegen“ der Wiedervorlage führt den Blick auf „Einrichten“ genau dieses Bedarfs', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html#/portfolio/messstellen?entscheid=messbedarf_frist&kennzeichen=MB-2', breite);
      const knopf = geplant(page, 'MB-2').getByRole('button', { name: /MB-2\) einrichten$/ });
      await expect(knopf).toBeFocused();
      await expect(knopf).toBeInViewport({ ratio: 1 });
      await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
      await ablegen(page, `geplant-wiedervorlage-${breite}`);
    });

    test('„Messbedarf erfassen“ im Menü: an EE-8, mit Ort - danach eine geplante Messstelle an diesem Ort', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?plan=leer#/portfolio/messstellen', breite);
      await expect(page.getByTestId('geplante-messstelle')).toHaveCount(0);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      const eintrag = page.getByRole('menuitem', { name: /Messbedarf erfassen/ });
      await expect(eintrag).toContainText('Eine Messstelle planen, die noch fehlt');
      await ablegen(page, `geplant-menue-${breite}`);
      await eintrag.click();
      await expect(modal(page)).toContainText('EE-8 Gebäudetechnik Halle 1');
      await modal(page).getByLabel('Was soll gemessen werden?').fill('Kompressor 2 in Halle 2');
      await waehle(page, 'Ort (optional)', /^Halle 2\s*Gebäude/);
      await ablegen(page, `geplant-erfassen-${breite}`);
      await ohneQuerlauf(page, `erfassen-${breite}`);
      await modal(page).getByRole('button', { name: 'Messbedarf erfassen' }).click();
      await expect(page.getByTestId('geplante-satz')).toHaveText('Messbedarf MB-1 ist erfasst und steht als geplante Messstelle in der Liste.');
      await expect(karte(page, 'Halle 2').getByTestId('geplante-messstelle')).toContainText('Kompressor 2 in Halle 2');
      await ohneQuerlauf(page, `erfasst-${breite}`);
    });

    test('ohne das Recht, Energieeinsätze zu verwalten: die geplanten lesen, nicht einrichten, nicht erfassen', async ({ page }) => {
      await oeffne(page, '/e2e/geplante-messstellen.html?person=PH#/portfolio/messstellen', breite);
      await expect(geplant(page, 'MB-1')).toBeVisible();
      await expect(page.getByTestId('geplante-messstelle').getByRole('button')).toHaveCount(0);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      await expect(page.getByRole('menuitem').first()).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Messbedarf erfassen/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await geplant(page, 'MB-1').scrollIntoViewIfNeeded();
      await ablegen(page, `geplant-nur-lesen-${breite}`);
      await ohneQuerlauf(page, `nur-lesen-${breite}`);
    });
  });
}
