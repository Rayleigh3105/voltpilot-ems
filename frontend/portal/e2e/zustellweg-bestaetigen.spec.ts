import { expect, test, type Page } from '@playwright/test';

/**
 * Der Link aus der Bestätigungs-Mail (Alerting Scheibe 0, "So erreichen wir
 * Sie", §6.6): `ZustellwegService#anfordern` baut ihn als
 * `VOLTPILOT_VERSAND_BESTAETIGUNG_BASIS_URL + "/#/zustellweg/bestaetigen?token=…"`.
 * Befund der Abnahme: diese Portal-Route gab es nicht - der Klick lief ins Leere.
 *
 * Dieser Fall läuft gegen die ECHTE Schale (`/`, main.tsx), nicht gegen einen
 * e2e-Fixture-Harness: die Route muss schon VOR dem Keycloak-Bootstrap greifen
 * (`main.tsx` liest `zustellwegBestaetigenToken()` vor `initAuth()`), der Klick
 * aus der Mail kommt ja oft OHNE angemeldete Sitzung - und läuft hier sogar
 * ohne jede Keycloak-Verbindung (bewusst nicht erreichbar in diesem Lauf), was
 * genau das belegt: die Seite hängt NICHT an der Anmeldung.
 */

function querlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function oeffne(page: Page, breite: number, token = 'ein-gueltiger-token') {
  const fehler: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') fehler.push(msg.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto(`/#/zustellweg/bestaetigen?token=${token}`);
  return fehler;
}

for (const breite of [390, 1440] as const) {
  test(`bestätigt die E-Mail-Adresse und zeigt den Weiter-Weg ohne Querlauf bei ${breite}px`, async ({
    page,
  }) => {
    let angefragterToken: string | null = null;
    await page.route('**/api/v1/zustellwege/bestaetigen*', (route) => {
      angefragterToken = new URL(route.request().url()).searchParams.get('token');
      return route.fulfill({ status: 200, body: '' });
    });

    const fehler = await oeffne(page, breite, 'ein-echter-mail-token');
    await expect(page.getByRole('heading', { name: 'E-Mail-Adresse bestätigt' })).toBeVisible();
    await expect(page.getByText('Sie erhalten Meldungen von VoltPilot jetzt auch per E-Mail.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Weiter zum Meldungs-Center' })).toBeVisible();

    expect(angefragterToken).toBe('ein-echter-mail-token');
    expect(await querlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
}

test('"Weiter" führt weg von der Bestätigungsroute (zum Meldungs-Center)', async ({ page }) => {
  await page.route('**/api/v1/zustellwege/bestaetigen*', (route) => route.fulfill({ status: 200, body: '' }));
  await oeffne(page, 1440);
  await page.getByRole('button', { name: 'Weiter zum Meldungs-Center' }).click();
  await page.waitForURL(/#\/meldungen$/);
});

test('ein ungültiger/abgelaufener/schon verwendeter Token zeigt einen ehrlichen Fehler mit nächstem Schritt', async ({
  page,
}) => {
  await page.route('**/api/v1/zustellwege/bestaetigen*', (route) => route.fulfill({ status: 410, body: '' }));
  const fehler = await oeffne(page, 1440, 'laengst-verbraucht');

  await expect(page.getByRole('heading', { name: 'Link nicht mehr gültig' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('ungültig, abgelaufen oder schon verwendet');
  await expect(page.getByRole('button', { name: 'Weiter zu VoltPilot' })).toBeVisible();
  // Der Browser selbst protokolliert jede Netzwerk-Antwort ≥400 als Konsolenfehler
  // ("Failed to load resource") - das ist die erwartete Nebenwirkung des mit 410
  // gemockten Endpunkts, keine Fehlfunktion der Seite (die `410` behandelt sie
  // ja gerade sauber). Echte App-Fehler blieben trotzdem sichtbar.
  expect(fehler.filter((f) => !f.includes('Failed to load resource'))).toEqual([]);
});

test('ein Serverfehler bietet "Erneut versuchen" an - ein zweiter Versuch kann gelingen', async ({ page }) => {
  let aufrufe = 0;
  await page.route('**/api/v1/zustellwege/bestaetigen*', (route) => {
    aufrufe += 1;
    return aufrufe === 1
      ? route.fulfill({ status: 500, body: '' })
      : route.fulfill({ status: 200, body: '' });
  });
  await oeffne(page, 1440, 'temporaer-kaputt');

  await expect(page.getByRole('heading', { name: 'Das hat gerade nicht geklappt' })).toBeVisible();
  await page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByRole('heading', { name: 'E-Mail-Adresse bestätigt' })).toBeVisible();
  expect(aufrufe).toBe(2);
});
