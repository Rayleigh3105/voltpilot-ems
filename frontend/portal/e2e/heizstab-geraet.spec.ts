import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Die Geräteseite eines Heizstabs (Bühne `heizstab-geraet.html`, Entschlacken 04.11.2026): oben steht, was
 * BESTÄTIGT läuft und was der Kunde wissen muss (Abweichung, Handeingriff, offener Anschluss); Phasen, die
 * geschätzte Wärme und die Phase für Stufe 1 stehen unter „Mehr zum Heizstab“. Geprüft wird Geometrie und
 * Bedienung bei 375 und 1440 px, kein Pixelvergleich.
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

    test('heizt: Kopf und Karte nennen die bestätigte Stufe, Einzelheiten unter „Mehr“', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'heizt');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByText('Heizt mit 2 Phasen · 4,0 kW')).toBeVisible();
      // Der Kopf der Seite widerspricht nicht mehr („meldet gerade keinen Wert“ neben „Heizt mit 2 Phasen“).
      await expect(page.getByText('Heizt gerade.')).toBeVisible();
      await expect(page.getByText('≈ 4,0 kW · angenommen')).toBeVisible();
      await expect(page.getByText(/meldet gerade keinen Wert|noch keine Messwerte geliefert/)).toHaveCount(0);
      await expect(page.getByText(/shelly_http/)).toHaveCount(0);
      // Phasen und Wärme stehen zugeklappt unter „Mehr zum Heizstab“.
      await expect(karte.getByText('L1 an')).toBeHidden();
      await expect(karte.getByRole('group', { name: 'Stufe' })).toBeVisible();
      await expect(karte.getByRole('group', { name: 'Dauer' })).toBeVisible();
      await ohneUeberlauf(page);
      await bild(page, 'k-heizt', breite);
      await karte.getByText('Mehr zum Heizstab').click();
      await expect(karte.getByText('L1 an')).toBeVisible();
      await expect(karte.getByText(/Wärme heute ≈\s7,2\skWh - geschätzt/)).toBeVisible();
      await expect(karte.getByRole('button', { name: /Täglich wechselnd/ })).toHaveAttribute('aria-pressed', 'true');
      await ohneUeberlauf(page);
      await bild(page, 'k-heizt-mehr', breite);
      // „Jetzt heizen“ nennt Stufe UND Dauer im Knopf.
      await karte.getByRole('button', { name: /^2 Phasen/ }).click();
      await karte.getByRole('button', { name: '1 Stunde' }).click();
      await karte.getByRole('button', { name: '2 Phasen für 1 Stunde einschalten' }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __gesendet: Record<string, unknown> }).__gesendet.startOverride))
        .toEqual({ action: 'start', durationMinutes: 60, stufe: 2 });
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

    test('Handeingriff: befohlen ist nicht bestätigt - kein „heizt von Hand“', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'hand');
      const karte = page.getByTestId('heizstab-karte');
      await expect(karte.getByText(/^Von Hand eingeschaltet bis 13:47 \(1 Phase · 2,0\skW\)\.$/)).toBeVisible();
      await expect(page.getByText(/Heizt von Hand/)).toHaveCount(0);
      await expect(karte.getByRole('button', { name: 'Automatik fortsetzen' })).toBeVisible();
      await ohneUeberlauf(page);
      await bild(page, 'k-hand', breite);
      expect(fehler).toEqual([]);
    });

    test('noch keine Rückmeldung: unbekannt bleibt unbekannt', async ({ page }) => {
      const fehler = await oeffne(page, breite, 'still');
      await expect(page.getByText('Die Box hat noch keine Stufe gemeldet.')).toBeVisible();
      await expect(page.getByTestId('heizstab-karte').getByText('Noch keine Rückmeldung der Box')).toBeVisible();
      await ohneUeberlauf(page);
      await bild(page, 'k-still', breite);
      expect(fehler).toEqual([]);
    });
  });
}
