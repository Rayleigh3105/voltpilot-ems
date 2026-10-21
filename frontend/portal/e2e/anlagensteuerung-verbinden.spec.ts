import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS EZ-15 „Anlege-Schritt Steuerung verbinden“ auf der Bühne `e2e/anlagensteuerung-verbinden.html`: der ganze Weg vom
 * Anschluss bis „Angelegt“, ohne Seitenüberlauf und am Telefon mit Tippzielen ab 44 px. `EZ15_SHOTS=<ordner>`
 * legt je Schritt ein Bild ab (für den PR, nicht Teil des Gesamtlaufs).
 */

const SHOTS = process.env.EZ15_SHOTS;

async function keinUeberlauf(page: Page) {
  const [breit, fenster] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(breit).toBeLessThanOrEqual(fenster);
}

/** Jedes sichtbare Bedienelement im Dialog ist mindestens 44 px hoch (Schalter: die ganze Zeile). */
async function tippziele(page: Page) {
  const zuKlein = await page.getByRole('dialog').evaluate((d) => {
    const ziele = d.querySelectorAll<HTMLElement>('button, input:not([type="checkbox"]), [role="combobox"], .vp-anst-alarme label');
    return [...ziele].filter((z) => {
      const r = z.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    }).map((z) => `${z.tagName} ${z.getAttribute('aria-label') ?? z.textContent?.trim().slice(0, 30)} ${Math.round(z.getBoundingClientRect().height)}`);
  });
  expect(zuKlein).toEqual([]);
}

async function bild(page: Page, name: string, telefon: boolean) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${telefon ? '375' : '1440'}-${name}.png`, fullPage: false });
}

async function schritt(page: Page, name: string, telefon: boolean) {
  await keinUeberlauf(page);
  if (telefon) await tippziele(page);
  await bild(page, name, telefon);
}

test('Anlagensteuerung verbinden: Kopf, Einheiten, Netz und Vermarktung, Alarme', async ({ page, isMobile }) => {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.goto('/e2e/anlagensteuerung-verbinden.html');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Adresse', { exact: true }).fill('192.168.4.165');
  await dialog.getByRole('button', { name: 'Kopf prüfen' }).click();
  await expect(dialog.getByText('✓ Bild erkannt')).toBeVisible();
  await expect(dialog.getByText('2 Einheiten · Herzschlag läuft (2 Lesungen, +2) · Wortfolge stimmt')).toBeVisible();
  await schritt(page, '1-anschluss', isMobile);

  await dialog.getByRole('button', { name: 'Weiter' }).click();
  await expect(dialog.getByRole('heading', { name: 'Einheiten aus dem Bild' })).toBeVisible();
  await expect(dialog.getByLabel('Typ (aus dem Bild)').first()).toHaveValue('MAN E0836LE');
  await schritt(page, '2-einheiten', isMobile);

  await dialog.getByRole('button', { name: 'Weiter' }).click();
  await expect(dialog.getByRole('heading', { name: 'Netzbetreiber' })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Einspeisemanagement' }).click();
  await page.getByRole('option', { name: /^Stufen \(Rundsteuerempfänger\)/ }).click();
  await dialog.getByRole('combobox', { name: 'Weg der Vorgaben' }).click();
  await page.getByRole('option', { name: /^Relais und 4–20 mA/ }).click();
  await expect(dialog.getByLabel('Stufe 2 in %')).toHaveValue('60');
  // Das Auswahlblatt des Pickers ist zu, bevor fotografiert und gemessen wird.
  await expect(page.getByRole('option')).toHaveCount(0);
  await schritt(page, '3-netz', isMobile);

  await dialog.getByRole('button', { name: 'Weiter' }).click();
  await expect(dialog.getByRole('heading', { name: 'Alarme vorschlagen' })).toBeVisible();
  await schritt(page, '4-abschluss', isMobile);

  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(dialog.getByText('Anlagensteuerung angelegt')).toBeVisible();
  await expect(dialog.getByText('✓ Fernsteuerung nicht bereit angelegt')).toBeVisible();
  await schritt(page, '5-angelegt', isMobile);
  expect(fehler).toEqual([]);
});

test('ein fremdes Registerbild nennt den Grund und lässt nicht weiter', async ({ page, isMobile }) => {
  await page.goto('/e2e/anlagensteuerung-verbinden.html?fall=fremd');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Adresse', { exact: true }).fill('192.168.4.165');
  await dialog.getByRole('button', { name: 'Kopf prüfen' }).click();
  await expect(dialog.getByText('Bild unbekannt: andere Signatur')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  await schritt(page, '1-fremd', isMobile);
});
