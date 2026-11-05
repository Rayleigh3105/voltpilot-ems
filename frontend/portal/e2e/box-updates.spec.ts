import { expect, test } from '@playwright/test';

/** Kein Element ragt über die Seite oder seinen Elternblock hinaus. */
async function ueberlauf(page: import('@playwright/test').Page, auswahl: string) {
  return page.evaluate((sel) => {
    const raus: string[] = [];
    const breite = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll(`${sel} *`)) {
      const r = el.getBoundingClientRect();
      const eltern = el.parentElement?.getBoundingClientRect();
      if (r.width === 0) continue;
      // Ein Segment scrollt in sich (wie die Reiter); was darin liegt, zählt nicht.
      if (el.closest('.vp-gu-seg')) continue;
      if (r.right > breite + 1 || (eltern && r.right > eltern.right + 1)) raus.push(`${el.tagName}.${el.className}`);
    }
    return { seite: document.documentElement.scrollWidth - innerWidth, raus };
  }, auswahl);
}

test('Updates: Lage, Linien, Braucht dich und Boxen - Fortschritt, Box-Dialog und Suche', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  await expect(page.getByRole('tab', { name: 'Updates', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('lage')).toContainText('1 Box hält ein Update zurück: Gewerbepark West.');
  const docker = page.getByTestId('linie-docker');
  await expect(docker.getByTestId('linie-neuestes')).toHaveText('edge-2026.09.10');
  await expect(docker.getByTestId('linie-plattformen')).toContainText('Raspberry Pi · arm64');
  const light = page.getByTestId('linie-light');
  await expect(light.getByTestId('linie-neuestes')).toHaveText('edge-light-2026.09.12');
  await expect(light.getByTestId('linie-plattformen')).toContainText('Mango · mipsle ✓');

  const aufgaben = page.getByTestId('braucht-dich').getByTestId('aufgabe');
  await expect(aufgaben).toHaveCount(3);
  await expect(aufgaben.nth(0)).toContainText('Gewerbepark West: hält das Update zurück');
  await expect(aufgaben.nth(1)).toContainText('Hof Lindenallee ist seit 4');
  await expect(aufgaben.nth(2)).toContainText('Kleingarten Ostend: nur von Hand (Stufe 1)');

  // „Fortschritt": nur die Box, bei der das Update gerade läuft - mit Stand und Anfrage getrennt.
  await docker.getByRole('button', { name: 'Fortschritt' }).click();
  const boxes = page.getByTestId('box-versions');
  await expect(boxes.getByTestId('box-zeile')).toHaveCount(1);
  const werkstatt = boxes.getByTestId('box-zeile').filter({ hasText: 'Werkstatt am Bach' });
  await expect(werkstatt.getByTestId('box-laeuft')).toHaveText('edge-2026.09.02');
  await expect(werkstatt.getByTestId('box-ziel')).toHaveText('Anfrage edge-2026.09.10');
  await expect(werkstatt.getByTestId('box-update')).toContainText('lädt');
  await page.getByRole('button', { name: 'Update verwalten für Werkstatt am Bach · edge-abcdefj' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Software-Version');
  await drawer.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Aktion ist fehlgeschlagen');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();

  // Suche über Anlage und Gerät; die Filter lassen sich gemeinsam zurücksetzen.
  await page.getByRole('searchbox', { name: 'Boxen durchsuchen' }).fill('Sonnenhof');
  await expect(boxes).toHaveCount(0);
  await expect(page.getByText('Keine Box passt zu diesem Filter.')).toBeVisible();
  await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
  await page.getByRole('searchbox', { name: 'Boxen durchsuchen' }).fill('Sonnenhof');
  await expect(boxes.getByTestId('box-zeile')).toHaveCount(1);
  await expect(boxes).toContainText('Solarpark Sonnenhof');

  await page.getByRole('tab', { name: 'Registrierung' }).click();
  const support = page.locator('details').filter({ hasText: '1 Box ohne Kundenkonto' });
  await expect(support).not.toHaveAttribute('open');
  await support.locator('summary').click();
  await expect(support).toHaveAttribute('open');
  await expect(support).toContainText('edge-xyz234q');
  expect(errors).toEqual([]);
});

test('Box-Art: Chip, Gerät, Stufe 1 und keine Docker-Zuweisung für Edge Light', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  const boxes = page.getByTestId('box-versions');
  await expect(boxes).toBeVisible();
  const mango = boxes.getByTestId('box-zeile').filter({ hasText: 'Kleingarten Ostend' });
  await expect(mango.getByTestId('box-art')).toHaveText('Edge Light');
  await expect(mango.getByTestId('box-update')).toContainText('nur von Hand · Stufe 1');
  await expect(mango).not.toContainText('ohne Vertrauens-Set');
  // Geräte & Updates G8: das gemeldete Gerät in der Tabelle.
  await expect(mango.getByTestId('box-geraet')).toHaveText('GL.iNet GL-MT300N-V2 · mipsle');
  const neubau = boxes.getByTestId('box-zeile').filter({ hasText: 'Neubau am Feldrain' });
  await expect(neubau.getByTestId('box-art')).toHaveText('Box-Art unbekannt');
  await expect(neubau.getByTestId('box-geraet')).toHaveText('Gerät nicht gemeldet');

  // Filtern nach Linie.
  await page.getByRole('group', { name: 'Boxen nach Linie filtern' }).getByRole('button', { name: 'Edge Light 1' }).click();
  await expect(boxes.getByTestId('box-zeile')).toHaveCount(1);
  await expect(boxes).toContainText('Kleingarten Ostend');

  // „Update verwalten": kein Docker-Release, sondern der Grund.
  await page.getByRole('button', { name: 'Update verwalten für Kleingarten Ostend · edge-m4ng0q1' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByTestId('drawer-geraet')).toHaveText('GL.iNet GL-MT300N-V2 · mipsle');
  await expect(drawer.getByTestId('drawer-loader')).toHaveText('startet nur die Fassung aus dem Flash (Stufe 1)');
  // Stufe 1 (S0): das Edge-Light-Release ist gesperrt, und der Grund sagt, was zu tun ist.
  await expect(drawer.getByTestId('drawer-keine-passenden')).toContainText('diese Box hat Stufe 1');
  await expect(drawer.getByTestId('drawer-keine-passenden')).toContainText('nachrüsten');
  await expect(drawer.getByRole('button', { name: 'Aktualisieren', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();

  // Die Releases der Docker-Linie: die Edge-Light-Box steht im Verteil-Dialog ausgegraut mit Grund.
  await page.getByTestId('linie-docker').getByRole('button', { name: 'Releases (2)' }).click();
  const releases = page.getByRole('dialog', { name: 'Releases · Docker-Box' });
  await expect(releases.getByTestId('releases')).toContainText('edge-2026.09.02');
  await expect(releases).not.toContainText('edge-light-2026.09.12');
  await releases.getByRole('button', { name: /Aktualisieren/ }).first().click();
  const rollout = page.getByRole('dialog', { name: 'Aktualisieren auf edge-2026.09.10' });
  const gesperrt = rollout.getByTestId('candidate-gesperrt');
  await expect(gesperrt).toContainText('Kleingarten Ostend');
  await expect(gesperrt).toContainText('diese Box ist eine Edge Light');
  await expect(gesperrt.locator('input')).toBeDisabled();
  await expect(rollout.getByTestId('choose-all')).toContainText('Alle passenden Geräte (5)');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Je Software-Linie eine Karte: nebeneinander am Rechner, untereinander am Telefon, Stufe 1 mit Weg (S0/G5)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  const docker = page.getByTestId('linie-docker');
  const light = page.getByTestId('linie-light');
  // Das jüngste Release ist Edge Light - das Docker-Release steht trotzdem oben.
  await expect(docker.getByTestId('linie-neuestes')).toHaveText('edge-2026.09.10');
  await expect(docker).toContainText('1 neuestes');
  await expect(docker.getByTestId('linie-leiter')).toContainText('Solarpark Sonnenhof');
  await expect(light.getByTestId('linie-neuestes')).toHaveText('edge-light-2026.09.12');
  await expect(light).toContainText('1 nur von Hand (Stufe 1)');
  await expect(light.getByTestId('linie-leiter')).toContainText('Kleingarten Ostend · Stufe 1');
  // Die einzige Edge-Light-Box hat Stufe 1: statt „Verteilen" der Weg zum Nachrüsten.
  await expect(light.getByRole('button', { name: 'Verteilen …' })).toHaveCount(0);
  await light.getByRole('button', { name: 'Nachrüsten: so geht’s' }).click();
  await expect(page.getByRole('dialog')).toContainText('Kleingarten Ostend');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const over = await ueberlauf(page, '.vp-gu');
    expect(over.seite, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
    expect(over.raus, `Seite „Updates" bei ${width}px`).toEqual([]);
    // Nebeneinander am Rechner, untereinander am Telefon.
    const [a, b] = await Promise.all([docker.boundingBox(), light.boundingBox()]);
    if (width === 1440) expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    else expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  }
  expect(errors).toEqual([]);
});

test('Updates bleibt bei 320, 768, 1024 und 1440 px innerhalb des Bildschirms', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium' && info.project.use.browserName !== 'webkit', 'Gezielte zusätzliche Viewport-Prüfung');
  await page.goto('/e2e/box-updates.html');
  await expect(page.getByTestId('box-versions')).toBeVisible();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="box-versions"]')!;
      return {
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        tableOverflow: table.scrollWidth - table.clientWidth,
      };
    });
    expect(metrics.documentOverflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
    expect(metrics.tableOverflow, `Boxen bei ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('Registrierung: Online-Status je Box mit Zählung und Filter, ohne Überlauf', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  await page.getByRole('tab', { name: 'Registrierung' }).click();
  const devices = page.getByTestId('devices');
  await expect(devices).toBeVisible();
  await expect(page.getByTestId('online-zaehlung')).toHaveText('4 online · 1 offline · 1 nie gemeldet');
  const still = devices.locator('tr').filter({ hasText: 'Hof Lindenallee' });
  await expect(still).toContainText('Meldet sich nicht');
  await expect(still).toContainText('Letzte Meldung: vor 4 Std.');
  await expect(devices.locator('tr').filter({ hasText: 'Neubau am Feldrain' }))
    .toContainText('Letzte Meldung: noch nie');

  const gruppe = page.getByRole('group', { name: 'Boxen nach Online-Status filtern' });
  await gruppe.getByRole('button', { name: 'Offline 1' }).click();
  await expect(devices.locator('tbody tr')).toHaveCount(1);
  await gruppe.getByRole('button', { name: 'Online 4' }).click();
  await expect(devices.locator('tbody tr')).toHaveCount(4);

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('Updates: Verbindung je Box aus der einen Uhr, mit Filter, ohne Überlauf', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  const table = page.getByTestId('box-versions');
  await expect(table).toBeVisible();
  // Dieselbe Regel und derselbe Wortlaut wie im Reiter „Registrierung".
  const still = table.getByTestId('box-zeile').filter({ hasText: 'Hof Lindenallee' });
  await expect(still.getByTestId('box-verbindung')).toContainText('Meldet sich nicht');
  await expect(still.getByTestId('box-verbindung')).toContainText(/seit 4\sStd\./);
  // Was eine stumme Box zuletzt gemeldet hat, ist nicht aktuell.
  await expect(still).toContainText('Stand von');
  await expect(table.getByTestId('box-zeile').filter({ hasText: 'Neubau am Feldrain' }).getByTestId('box-verbindung'))
    .toContainText('Wartet auf erste Meldung');

  const gruppe = page.getByRole('group', { name: 'Boxen nach Zustand filtern' });
  await gruppe.getByRole('button', { name: 'Offline 1' }).click();
  await expect(table.getByTestId('box-zeile')).toHaveCount(1);
  await gruppe.getByRole('button', { name: 'Offline 1' }).click();
  await expect(table.getByTestId('box-zeile')).toHaveCount(6);

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
