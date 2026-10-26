import { expect, test, type Page } from '@playwright/test';

// Die Seite ist lang und klickreich (dreizehn Schritte, Probe, Abnahme); WebKit braucht im Container mehr Zeit.
test.describe.configure({ timeout: 90_000 });

const HOST = 'SHA256:' + 'Q'.repeat(42) + 'c';

/**
 * Kein waagerechter Überlauf und nichts, was über den Rand der Seite ragt. Tabellen und die Reiterleiste
 * scrollen in sich; von der Leiste muss der gewählte Reiter ganz zu sehen sein.
 */
async function passt(page: Page) {
  const r = await page.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const zuBreit = [...document.querySelectorAll<HTMLElement>('.vp-ws *')]
      .filter((e) => e.offsetParent !== null && !e.closest('.vp-table-scroll, .vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 1)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = document.querySelector<HTMLElement>('.vp-bereich-tabs [aria-selected="true"]')!.getBoundingClientRect();
    const leiste = document.querySelector<HTMLElement>('.vp-bereich-tabs')!.getBoundingClientRect();
    return {
      ueberlauf: document.documentElement.scrollWidth - breite,
      zuBreit: zuBreit.slice(0, 5),
      reiterSichtbar: reiter.left >= leiste.left - 1 && reiter.right <= leiste.right + 1,
    };
  });
  expect(r.ueberlauf).toBeLessThanOrEqual(0);
  expect(r.zuBreit).toEqual([]);
  expect(r.reiterSichtbar).toBe(true);
}

for (const breite of [1440, 375]) {
  test(`Werkstatt bei ${breite} px: Liste, Ablauf einer Box, Probe und Abnahme`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto('/e2e/werkstatt.html');

    await expect(page.getByRole('tab', { name: 'Werkstatt' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-versand-oben')).toContainText('Nicht versenden');
    const liste = page.getByTestId('ws-boxen');
    await expect(liste).toContainText('edge-wrk7abg');
    await expect(liste).toContainText('8 von 13 Schritten');
    await expect(liste).toContainText('Docker-Box');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-liste-${breite}.png`), fullPage: true });

    await liste.locator('tr').filter({ hasText: 'edge-wrk7abg' }).getByRole('button', { name: 'Weiter' }).click();
    await expect(page.getByTestId('ws-ablauf')).toContainText('edge-wrk7abg · Edge Light');
    await expect(page.getByTestId('ws-schritt-tunnel')).toContainText('service-tunnel.sh mango 10.10.16.7 51820');
    await expect(page.getByTestId('ws-qr')).toBeVisible();

    // Werkstatt-Probe: Fenster öffnen, der Stand kommt vom (nachgebildeten) Tunnel-Dienst.
    await page.getByRole('button', { name: /Fenster für die Probe öffnen \(30 Minuten\)/ }).click();
    await expect(page.getByTestId('ws-probe-offen')).toBeVisible();
    await expect(page.getByTestId('ws-probe-fall')).toHaveAttribute('data-fall', 'bereit');
    await expect(page.getByTestId('ws-probe-fall')).toContainText('Alles bereit');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-probe-${breite}.png`), fullPage: true });

    await page.getByRole('button', { name: 'Fenster jetzt schließen' }).click();
    await expect(page.getByTestId('ws-fenster-zu')).toContainText('Connection timed out');

    const abnahme = page.getByTestId('ws-karte-abnahme');
    const knopf = abnahme.getByRole('button', { name: 'Abnahme festhalten' });
    await expect(knopf).toBeDisabled();
    for (const haken of await abnahme.getByRole('checkbox').all()) await haken.check();
    await abnahme.getByLabel('Host-Schlüssel (aus Schritt 10)').fill(`3072 ${HOST} [10.10.16.7]:2222 (RSA)`);
    await abnahme.getByLabel('Fassung des Programms (aus /health)').fill('edge-light-g9c3368e3a');
    await knopf.click();
    await expect(page.getByTestId('ws-abnahme-protokoll')).toContainText(HOST);
    await expect(page.getByTestId('ws-versand')).toContainText('Keine Box mit Stufe 1 geht an einen Kunden');
    await passt(page);
    await page.screenshot({ path: test.info().outputPath(`werkstatt-abnahme-${breite}.png`), fullPage: true });
    expect(fehler).toEqual([]);
  });
}

test('Werkstatt: eine neue Box kommt mit ihrer Referenz in die Liste, ein übliches LAN lehnt das Portal ab', async ({ page }) => {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.goto('/e2e/werkstatt.html');
  await page.getByRole('button', { name: /Neue Box einrichten/ }).click();
  await page.getByTestId('ws-haken-openwrt').locator('input').check();
  await page.getByTestId('ws-schritt-programm').getByLabel('Referenz der Box').fill('EDGE-HM4QZ29');
  await page.getByRole('button', { name: 'In die Werkstatt-Liste aufnehmen' }).click();
  await expect(page.getByTestId('ws-ablauf')).toContainText('edge-hm4qz29 · Edge Light');
  await expect(page.getByTestId('ws-haken-openwrt').locator('input')).toBeChecked();
  await expect(page.getByTestId('ws-haken-programm')).toHaveCount(0);

  const lan = page.getByTestId('ws-schritt-lan');
  await lan.getByLabel(/LAN der Box/).fill('192.168.1.1/24');
  await lan.getByRole('button', { name: 'Netz festhalten' }).click();
  await expect(lan).toContainText('übliches Netz von Heimroutern');
  await lan.getByLabel(/LAN der Box/).fill('10.213.0.1/24');
  await lan.getByRole('button', { name: 'Netz festhalten' }).click();
  await expect(lan).toContainText('Festgehalten: 10.213.0.1/24');
  await expect(lan).toContainText("uci add_list network.lan.ipaddr='10.213.0.1/24'");
  await passt(page);

  await page.getByRole('button', { name: 'Zur Liste' }).first().click();
  await expect(page.getByTestId('ws-boxen')).toContainText('edge-hm4qz29');
  expect(fehler).toEqual([]);
});
