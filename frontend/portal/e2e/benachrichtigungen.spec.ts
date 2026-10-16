import { expect, test, type Page } from '@playwright/test';

/**
 * "Meine Benachrichtigungen" (Alerting Scheibe 3/6, Konzept §6.8 Entwurf 4, §7 Scheibe 6) bei 390
 * und 1440 px auf der echten Schale (`startansicht.html`, wie `meldungen.spec.ts`): E-Mail-
 * Zustellweg, Web-Push-Geräte-Abos, Webhook-Ziele, Telegram-Verbindungen, Ruhezeit mit
 * "Dringendes trotzdem melden" (Entscheid 8A).
 *
 * Die Routen sind gemockt (`page.route`) - dieselbe Bühne kennt keinen echten Server.
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
  await page.route('**/api/v1/zustellwege/webhook', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: [
        { id: 'w1', url: 'https://hooks.example/teams', name: 'Teams-Kanal', aktiv: true, abSchwere: 'warnung', erstelltAm: '2026-10-01T10:00:00Z' },
      ],
    });
  });
  await page.route('**/api/v1/zustellwege/webhook/w1', (route) => route.fallback());
  await page.route('**/api/v1/zustellwege/telegram', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: [{ id: 't1', bestaetigt: true, aktiv: true, abSchwere: 'warnung', erstelltAm: '2026-10-01T10:00:00Z' }],
    });
  });
  await page.route('**/api/v1/zustellwege/telegram/t1', (route) => route.fallback());
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
  test(`zeigt E-Mail, Push-Geräte, Webhook, Telegram und Ruhezeit ohne Querlauf bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });

    await expect(dialog.getByText('ines.kaltenbach@ahrenberg.example')).toBeVisible();
    await expect(dialog.getByText('iPhone von Ines')).toBeVisible();
    await expect(dialog.getByText('Teams-Kanal')).toBeVisible();
    await expect(dialog.getByText('Verbunden')).toBeVisible();
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
  await dialog.getByRole('button', { name: 'Entfernen' }).first().click();
  await expect(dialog.getByText('iPhone von Ines')).toBeHidden();
  expect(entfernt).toBe(true);
});

// =================================================================== Webhook (Alerting Scheibe 6, §7 Scheibe 6)

test('ein Webhook-Ziel lässt sich anlegen und zeigt das Geheimnis nur dieses eine Mal', async ({ page }) => {
  let angelegt: Record<string, unknown> | null = null;
  await page.route('**/api/v1/zustellwege/webhook', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    angelegt = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: 'w2', geheimnis: 'ein-neues-geheimnis' } });
  });
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });

  await dialog.getByLabel('Webhook-URL').fill('https://hooks.example/slack');
  await dialog.getByLabel('Name (optional)').fill('Slack-Kanal');
  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(dialog.getByText('ein-neues-geheimnis')).toBeVisible();
  expect(angelegt).toMatchObject({ url: 'https://hooks.example/slack', name: 'Slack-Kanal' });
});

test('ein Webhook-Ziel lässt sich entfernen', async ({ page }) => {
  let entfernt = false;
  await page.route('**/api/v1/zustellwege/webhook/w1', (route) => {
    if (route.request().method() === 'DELETE') {
      entfernt = true;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });
  await dialog.getByText('Teams-Kanal').locator('..').getByRole('button', { name: 'Entfernen' }).click();
  await expect(dialog.getByText('Teams-Kanal')).toBeHidden();
  expect(entfernt).toBe(true);
});

// =================================================================== Telegram (Alerting Scheibe 6, §7 Scheibe 6)

test('"Telegram verbinden" öffnet den Start-Link in einem neuen Tab', async ({ page, context }) => {
  await page.route('**/api/v1/zustellwege/telegram/verbinden', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: { link: 'https://t.me/VoltPilotBot?start=ein-token' } });
  });
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });

  const [neuerTab] = await Promise.all([
    context.waitForEvent('page'),
    dialog.getByRole('button', { name: 'Telegram verbinden' }).click(),
  ]);
  await expect.poll(() => neuerTab.url()).toBe('https://t.me/VoltPilotBot?start=ein-token');
});

test('eine Telegram-Verbindung lässt sich trennen', async ({ page }) => {
  let getrennt = false;
  await page.route('**/api/v1/zustellwege/telegram/t1', (route) => {
    if (route.request().method() === 'DELETE') {
      getrennt = true;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await oeffne(page, 1440);
  const dialog = page.getByRole('dialog', { name: 'Meine Benachrichtigungen' });
  await dialog.getByRole('button', { name: 'Trennen' }).click();
  await expect(dialog.getByText('Verbunden')).toBeHidden();
  expect(getrennt).toBe(true);
});
