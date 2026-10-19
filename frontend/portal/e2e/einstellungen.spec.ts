import { expect, test, type Page } from '@playwright/test';

/**
 * Die Einstellungs-Seite (Konzept `vp-einstellungen-konzept-e1`, Scheibe 1) bei 390 und 1440 px -
 * die echte `EinstellungenPage` auf der eigenen Bühne `e2e/einstellungen.html` (gestellte Routen,
 * wie `gemeinsame-steuerung.spec.ts`). Löst `e2e/benachrichtigungen.spec.ts` ab (das Modal ist
 * entfernt).
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments, Konsole sauber.
 */

async function oeffne(page: Page, breite: number, query = 'fall=voll') {
  const fehler: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') fehler.push(msg.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto(`/e2e/einstellungen.html?${query}`);
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  return fehler;
}

function querlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const breite of [390, 1440] as const) {
  test(`zeigt die vier Gruppen und das Kurzbild ohne Querlauf bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffne(page, breite);

    await expect(page.getByText('So erreicht Sie eine Meldung jetzt')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'So erreichen wir Sie' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ruhezeit und Zusammenfassung' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ihr Konto' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dieses Gerät' })).toBeVisible();
    await expect(page.getByText('iPhone von Ines')).toBeVisible();
    await expect(page.getByText('ines.kaltenbach@ahrenberg.example')).toBeVisible();
    await expect(page.getByText('Energieteam')).toBeVisible();

    expect(await querlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`zeigt den leeren Zustand ehrlich (nichts eingerichtet) bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=leer');
    const gruppe = page.locator('#einst-wege');
    await expect(gruppe.getByText('E-Mail')).toBeVisible();
    await expect(gruppe.getByText('Push auf diesem Gerät')).toBeVisible();
    await expect(gruppe.getByText('Nicht eingerichtet')).toHaveCount(2);
    expect(await querlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`"Dringendes trotzdem melden" lässt sich abschalten bei ${breite}px`, async ({ page }) => {
    await oeffne(page, breite);
    const schalter = page.getByRole('switch', { name: 'Dringendes trotzdem melden' });
    await expect(schalter).toHaveAttribute('aria-checked', 'true');
    await schalter.click();
    await expect(schalter).toHaveAttribute('aria-checked', 'false');
  });
}

test('die E-Mail-Zeile öffnet ihr Blatt mit Stufe und Bestätigung', async ({ page }) => {
  await oeffne(page, 1440);
  await page.getByRole('button', { name: /^E-Mail/ }).click();
  const blatt = page.getByRole('dialog', { name: 'E-Mail' });
  await expect(blatt.getByText('ines.kaltenbach@ahrenberg.example · Bestätigt')).toBeVisible();
  await expect(blatt.getByRole('radio', { name: 'Warnung und Dringend' })).toHaveAttribute('aria-checked', 'true');
});

test('eine unbestätigte E-Mail bietet "Link erneut senden" statt einer Stufe', async ({ page }) => {
  await oeffne(page, 1440, 'fall=unbestaetigt');
  await page.getByRole('button', { name: /^E-Mail/ }).click();
  const blatt = page.getByRole('dialog', { name: 'E-Mail' });
  await expect(blatt.getByRole('button', { name: 'Link erneut senden' })).toBeVisible();
  await expect(blatt.getByRole('radiogroup')).toHaveCount(0);
});

test('"Weiteren Weg verbinden" bietet einen Team-Kanal und (mit Bot) Telegram an', async ({ page, context }) => {
  await oeffne(page, 1440);
  await page.getByRole('button', { name: 'Weiteren Weg verbinden' }).click();
  const blatt = page.getByRole('dialog', { name: 'Weiteren Weg verbinden' });
  const [neuerTab] = await Promise.all([
    context.waitForEvent('page'),
    blatt.getByRole('button', { name: 'Telegram verbinden' }).click(),
  ]);
  await expect.poll(() => neuerTab.url()).toBe('https://t.me/VoltPilotBot?start=ein-token');
});

test('ein neuer Team-Kanal zeigt den Signatur-Schlüssel nur dieses eine Mal', async ({ page }) => {
  await oeffne(page, 1440, 'fall=leer');
  await page.getByRole('button', { name: 'Weiteren Weg verbinden' }).click();
  const blatt = page.getByRole('dialog', { name: 'Weiteren Weg verbinden' });
  await blatt.getByRole('button', { name: 'Team-Kanal verbinden' }).click();
  await blatt.getByLabel('Adresse').fill('https://hooks.example/eigener-dienst');
  await blatt.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(blatt.getByText('ein-geheimnis')).toBeVisible();
});

test('in der Ruhezeit nennt das Kurzbild "wartet" statt der Wege', async ({ page }) => {
  await oeffne(page, 1440, 'fall=voll&ruhezeitAktiv=1');
  const kurzbild = page.locator('.vp-meinst-kurzbild');
  await expect(kurzbild.getByText(/wartet bis/)).toBeVisible();
});
