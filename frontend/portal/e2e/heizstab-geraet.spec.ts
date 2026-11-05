import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Die Geräteseite eines Heizstabs (Bühne `heizstab-geraet.html`, Konzept „Phasen schalten“ 05.11.2026): Smart
 * zuerst, darunter ein Schalter je Phase in der BESTÄTIGTEN Stellung, Seltenes unter „Einstellungen“. Geprüft
 * werden Geometrie und Bedienung bei 375 und 1440 px, kein Pixelvergleich.
 *
 * Bilder nur auf Wunsch (`HEIZSTAB_BILDER=<Ordner>`), nie ins Repository.
 */
const BILDER = process.env.HEIZSTAB_BILDER;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffne(page: Page, breite: number, fall: string) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.clock.setFixedTime(new Date('2026-11-04T10:52:00Z'));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/heizstab-geraet.html?fall=${fall}`);
  await expect(page.getByTestId('heizstab-karte')).toBeVisible({ timeout: 20_000 });
  return fehler;
}

/** Nichts ragt über den Rand der Seite, und die Seite selbst scrollt nicht seitlich. */
async function ohneUeberlauf(page: Page) {
  const m = await page.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const draussen = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.right > breite + 1 || r.left < -1);
      })
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5);
    return { dokument: document.documentElement.scrollWidth - breite, draussen };
  });
  expect(m.dokument).toBeLessThanOrEqual(0);
  expect(m.draussen).toEqual([]);
}

async function bild(page: Page, name: string, breite: number) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: true, animations: 'disabled' });
}

for (const breite of [375, 1440] as const) {
  test.describe(`Heizstab auf der Geräteseite (${breite})`, () => {
    test.beforeEach(({}, info) => {
      const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
      test.skip(!passend, 'je Breite nur die passende Maschine');
    });

    const gesendet = (page: Page, was: string) =>
      page.evaluate((w) => (window as unknown as { __gesendet: Record<string, unknown> }).__gesendet[w], was);

    test('heizt: Smart oben, je Phase ein Schalter in der bestätigten Stellung, Einstellungen zugeklappt', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'heizt');
      const karte = page.getByTestId('heizstab-karte');
      // Der Kopf der Seite widerspricht nicht („meldet gerade keinen Wert“ neben „Heizt mit 2 Phasen“).
      await expect(page.getByText('Heizt gerade.')).toBeVisible();
      await expect(page.getByText(/meldet gerade keinen Wert|noch keine Messwerte geliefert/)).toHaveCount(0);
      await expect(page.getByText(/shelly_http/)).toHaveCount(0);
      // Die eigene Steuerung ersetzt Zustandszeile und Segmente („Automatik / Ein / Aus“).
      await expect(page.getByRole('radiogroup', { name: 'Betriebsart' })).toHaveCount(0);
      await expect(karte.getByTestId('heizstab-smart')).toContainText('Smart · Überschuss');
      await expect(karte.getByRole('switch', { name: 'L1 ausschalten' })).toHaveAttribute('aria-checked', 'true');
      await expect(karte.getByRole('switch', { name: 'L3 einschalten' })).toHaveAttribute('aria-checked', 'false');
      await expect(karte.getByTestId('heizstab-einstellungen')).not.toHaveAttribute('open', '');
      await ohneUeberlauf(page);
      await bild(page, 'k-heizt', breite);
      // Ein Tipp auf L3 schaltet von Hand: L1 bis L3, zwei Stunden.
      await karte.getByRole('switch', { name: 'L3 einschalten' }).click();
      await expect.poll(() => gesendet(page, 'startOverride')).toEqual({ action: 'start', durationMinutes: 120, ausgaenge: [0, 1, 2] });
      await karte.getByTestId('heizstab-einstellungen').locator('summary').click();
      await expect(karte.getByRole('button', { name: 'Täglich wechselnd' })).toHaveAttribute('aria-pressed', 'true');
      await ohneUeberlauf(page);
      await bild(page, 'k-heizt-einstellungen', breite);
      expect(fehler).toEqual([]);
    });

    test('Abweichung nach oben: der Hinweis sagt „mehr als befohlen“ und bleibt oben sichtbar', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'abweichung');
      const hinweis = page.getByTestId('heizstab-karte').getByRole('status');
      await expect(hinweis).toBeVisible();
      await expect(hinweis).toContainText('heizt der Stab mit mehr als befohlen (2 Phasen statt 1 Phase)');
      await expect(hinweis).not.toContainText('nie mit mehr');
      await ohneUeberlauf(page);
      await bild(page, 'k-abweichung', breite);
      expect(fehler).toEqual([]);
    });

    test('von Hand: L3 angefragt wartet sichtbar, Smart ruht bis 13:47, „Zurück zu Smart“', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'hand');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByTestId('heizstab-smart')).toContainText('Smart ruht');
      await expect(karte.getByTestId('heizstab-hand')).toContainText('Von Hand · Smart wieder ab 13:47');
      await expect(karte.getByTestId('heizstab-phase-L3')).toContainText('schaltet ein …');
      await expect(page.getByText(/Heizt von Hand/)).toHaveCount(0);
      await ohneUeberlauf(page);
      await bild(page, 'k-hand', breite);
      await karte.getByRole('button', { name: 'Zurück zu Smart' }).click();
      await expect.poll(() => gesendet(page, 'clearOverride')).toBeTruthy();
      expect(fehler).toEqual([]);
    });

    test('noch keine Rückmeldung: „?“ statt „aus“', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'still');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByTestId('heizstab-phase-L1')).toContainText('?');
      await expect(karte.getByTestId('heizstab-phase-L1')).toContainText('noch keine Rückmeldung der Box');
      await ohneUeberlauf(page);
      await bild(page, 'k-still', breite);
      expect(fehler).toEqual([]);
    });

    test('ältere Box: Stufen mit dem Hinweis auf das Update', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'alt');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByText('Einzelne Phasen nach dem nächsten Update der Box')).toBeVisible();
      await karte.getByRole('button', { name: '1 Phase' }).click();
      await expect.poll(() => gesendet(page, 'startOverride')).toEqual({ action: 'start', durationMinutes: 120, stufe: 1 });
      await ohneUeberlauf(page);
      await bild(page, 'k-alt', breite);
      expect(fehler).toEqual([]);
    });

    test('Smart ruht: die Phasen-Schalter gehen weiter, der Smart-Schalter setzt fort', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'ruht');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByTestId('heizstab-smart')).toContainText('Der Stab bleibt aus, bis Smart wieder an ist.');
      await expect(karte.getByRole('switch', { name: 'L1 einschalten' })).toBeEnabled();
      await karte.getByRole('switch', { name: 'Smart einschalten' }).click();
      await expect.poll(() => gesendet(page, 'resume')).toBeTruthy();
      await ohneUeberlauf(page);
      expect(fehler).toEqual([]);
    });

    test('Fall GATE: ein Stab mit nur Ausgang 0 bekommt unter „Technik“ drei Ausgänge', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'einrichtung');
      const einst = page.getByTestId('heizstab-einstellungen');
      await einst.locator('summary').click();
      await einst.getByRole('button', { name: '3', exact: true }).click();
      await einst.getByRole('button', { name: '3 Ausgänge prüfen und speichern' }).click();
      await expect.poll(() => gesendet(page, 'updateComponent')).toMatchObject({ connection: { channels: [0, 1, 2], stages: [1, 2, 3] } });
      await ohneUeberlauf(page);
      await bild(page, 'k-einrichtung', breite);
      expect(fehler).toEqual([]);
    });
  });
}
