import { expect, test, type Page } from '@playwright/test';

/**
 * "Meine Benachrichtigungen" (Alerting Scheibe 3, Konzept §6.8 Entwurf 4) bei 390 und 1440 px auf
 * der echten Schale (`startansicht.html`, wie `meldungen.spec.ts`): E-Mail-Zustellweg, Web-Push-
 * Geräte-Abos, Ruhezeit mit "Dringendes trotzdem melden" (Entscheid 8A).
 *
 * Die vier neuen Routen sind gemockt (`page.route`) - dieselbe Bühne kennt keinen echten Server.
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments, Konsole sauber.
 */

async function mocken(page: Page) {
  await page.route('**/api/v1/zustellwege/email', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 202 });
    return route.fulfill({
      json: {
        ziel: 'ines.kaltenbach@ahrenberg.example',
        bestaetigt: true,
        aktiv: true,
        abSchwere: 'warnung',
        zusammenfassungAktiv: false,
        zusammenfassungUhrzeit: '07:00:00',
      },
    });
  });
  await page.route('**/api/v1/zustellwege/email/einstellungen', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/v1/zustellwege/push', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: [
        { id: '1', geraet: 'iPhone von Ines', aktiv: true, abSchwere: 'warnung', erstelltAm: '2026-10-01T10:00:00Z' },
      ],
    });
  });
  await page.route('**/api/v1/ruhezeit', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
    return route.fulfill({
      json: {
        regeln: JSON.stringify({ werktags: { von: '22:00', bis: '07:00' }, wochenende: 'ganz' }),
        zeitzone: 'Europe/Berlin',
        dringendDurch: true,
      },
    });
  });
}

async function oeffne(page: Page, breite: number) {
  const fehler: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') fehler.push(msg.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await mocken(page);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=messstellen');
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Konto-Menü/ }).click();
  await page.getByRole('menuitem', { name: 'Meine Benachrichtigungen' }).click();
  await expect(page.getByRole('dialog', { name: 'Meine Benachrichtigungen' })).toBeVisible();
  return fehler;
}

function querlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const breite of [390, 1440] as const) {
  test(`zeigt E-Mail, Push-Geräte und Ruhezeit ohne Querlauf bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });

    await expect(dialog.getByText('ines.kaltenbach@ahrenberg.example')).toBeVisible();
    await expect(dialog.getByText('iPhone von Ines')).toBeVisible();
    await expect(dialog.getByText('Dringendes trotzdem melden')).toBeVisible();

    expect(await querlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
}

test('"Dringendes trotzdem melden" lässt sich abschalten', async ({ page }) => {
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });

  // ERST nach dem Laden registriert: Playwright ruft den ZULETZT registrierten Treffer zuerst auf,
  // dieser hier überdeckt also gezielt nur den folgenden PUT - die erste (GET-)Antwort aus `mocken`
  // oben bleibt für den Blatt-Aufbau unverändert.
  let letzteAnfrage: Record<string, unknown> | null = null;
  await page.route('**/api/v1/ruhezeit', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    letzteAnfrage = route.request().postDataJSON();
    return route.fulfill({ status: 204 });
  });
  const schalter = dialog.getByLabel('Dringendes trotzdem melden');
  await expect(schalter).toBeChecked();
  // Das native Feld ist visuell versteckt (die Pille rendert sichtbar daneben) - der sichtbare
  // Text im selben <label> stößt denselben Klick an, ohne die Sichtbarkeits-Prüfung zu verfehlen.
  await dialog.getByText('Dringendes trotzdem melden').click();
  await expect.poll(() => letzteAnfrage?.dringendDurch).toBe(false);
});

test('ein Geräte-Abo lässt sich entfernen', async ({ page }) => {
  let entfernt = false;
  await page.route('**/api/v1/zustellwege/push/1', (route) => {
    if (route.request().method() === 'DELETE') {
      entfernt = true;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });
  await dialog.getByRole('button', { name: 'Entfernen' }).click();
  await expect(dialog.getByText('iPhone von Ines')).toBeHidden();
  expect(entfernt).toBe(true);
});
