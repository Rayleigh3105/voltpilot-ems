import { expect, test } from '@playwright/test';

test('Versionen, Filter und Update-Dialog funktionieren auf jeder Bildschirmgröße', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  const boxes = page.getByTestId('box-versions');
  await expect(boxes).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Updates', exact: true })).toHaveAttribute('aria-selected', 'true');
  const workshop = boxes.locator('tr').filter({ hasText: 'Werkstatt am Bach' });
  await expect(workshop.locator('[data-label="Installierte Version"]')).toContainText('edge-2026.09.02');
  await expect(workshop.locator('[data-label="Zielversion"]')).toContainText('edge-2026.09.10');
  await page.locator('.vp-box-filter-panel > summary').click();
  await page.getByRole('button', { name: 'Update läuft 1' }).click();
  await expect(boxes.locator('tbody tr')).toHaveCount(1);
  await expect(boxes).toContainText('Werkstatt am Bach');
  await page.getByRole('button', { name: 'Update verwalten für Werkstatt am Bach · edge-abcdefj' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Software-Version');
  await drawer.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Aktion ist fehlgeschlagen');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: 'Alle Boxen 6' }).click();
  await page.getByRole('combobox', { name: 'Installierte Version' }).click();
  await page.getByRole('option', { name: 'edge-2026.09.10', exact: true }).click();
  await expect(boxes.locator('tbody tr')).toHaveCount(1);
  await expect(boxes).toContainText('Solarpark Sonnenhof');
  await page.getByRole('tab', { name: 'Registrierung' }).click();
  const support = page.locator('details').filter({ hasText: '1 Box ohne Kundenkonto' });
  await expect(support).not.toHaveAttribute('open');
  await support.locator('summary').click();
  await expect(support).toHaveAttribute('open');
  await expect(support).toContainText('edge-xyz234q');
  expect(errors).toEqual([]);
});

test('Box-Art: Chip, Filter und keine Docker-Zuweisung für Edge Light', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  const boxes = page.getByTestId('box-versions');
  await expect(boxes).toBeVisible();
  const mango = boxes.locator('tr').filter({ hasText: 'Kleingarten Ostend' });
  await expect(mango.getByTestId('box-art')).toHaveText('Edge Light');
  await expect(mango).toContainText('Updates von Hand (Edge Light, Stufe 1)');
  await expect(mango).not.toContainText('ohne Vertrauens-Set');
  await expect(boxes.locator('tr').filter({ hasText: 'Neubau am Feldrain' }).getByTestId('box-art'))
    .toHaveText('Box-Art unbekannt');

  // Filtern nach Box-Art.
  await page.locator('.vp-box-filter-panel > summary').click();
  await page.getByRole('combobox', { name: 'Box-Art' }).click();
  await page.getByRole('option', { name: 'Edge Light (1)' }).click();
  await expect(boxes.locator('tbody tr')).toHaveCount(1);
  await expect(boxes).toContainText('Kleingarten Ostend');

  // „Update verwalten": kein Docker-Release, sondern der Grund.
  await page.getByRole('button', { name: 'Update verwalten für Kleingarten Ostend · edge-m4ng0q1' }).click();
  const drawer = page.getByRole('dialog');
  // Stufe 1 (S0): das Edge-Light-Release ist gesperrt, und der Grund sagt, was zu tun ist.
  await expect(drawer.getByTestId('drawer-keine-passenden')).toContainText('diese Box hat Stufe 1');
  await expect(drawer.getByTestId('drawer-keine-passenden')).toContainText('nachrüsten');
  await expect(drawer.getByRole('button', { name: 'Aktualisieren', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();

  // „Update verteilen" der Docker-Linie: die Edge-Light-Box steht ausgegraut mit Grund im Dialog.
  await page.getByTestId('linie-docker').getByRole('button', { name: 'Update verteilen' }).click();
  const rollout = page.getByRole('dialog');
  const gesperrt = rollout.getByTestId('candidate-gesperrt');
  await expect(gesperrt).toContainText('Kleingarten Ostend');
  await expect(gesperrt).toContainText('diese Box ist eine Edge Light');
  await expect(gesperrt.locator('input')).toBeDisabled();
  await expect(rollout.getByTestId('choose-all')).toContainText('Alle passenden Geräte (5)');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Je Software-Linie eine Karte: Docker-Box und Edge Light nebeneinander, Stufe 1 benannt (S0)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  const docker = page.getByTestId('linie-docker');
  const light = page.getByTestId('linie-light');
  // Das jüngste Release ist Edge Light - das Docker-Release steht trotzdem oben.
  await expect(docker).toContainText('edge-2026.09.10');
  await expect(docker).toContainText('1 von 4 Docker-Boxen meldet diese Version');
  await expect(docker.getByRole('button', { name: 'Update verteilen' })).toBeEnabled();
  await expect(light).toContainText('edge-light-2026.09.12');
  await expect(light).toContainText('0 von 1 Edge-Light-Box melden diese Version');
  await expect(light.getByTestId('linie-stufe1'))
    .toContainText('1 davon nimmt keine Updates aus dem Portal an (Stufe 1, nur von Hand)');
  // Die einzige Edge-Light-Box hat Stufe 1: es gibt niemanden, an den verteilt werden könnte.
  await expect(light.getByRole('button', { name: 'Update verteilen' })).toBeDisabled();

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const over = await page.evaluate(() => {
      const raus: string[] = [];
      const breite = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('[data-testid="box-linien"] *')) {
        const r = el.getBoundingClientRect();
        const eltern = el.parentElement?.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > breite + 1 || (eltern && r.right > eltern.right + 1)) raus.push(el.className || el.tagName);
      }
      return { seite: document.documentElement.scrollWidth - innerWidth, raus };
    });
    expect(over.seite, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
    expect(over.raus, `Linien-Karten bei ${width}px`).toEqual([]);
    // Nebeneinander am Rechner, untereinander am Telefon.
    const [a, b] = await Promise.all([docker.boundingBox(), light.boundingBox()]);
    if (width === 1440) expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    else expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  }
  expect(errors).toEqual([]);
});

test('Versionsübersicht bleibt bei 320, 768, 1024 und 1440 px innerhalb des Bildschirms', async ({ page }, info) => {
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
    expect(metrics.tableOverflow, `Versionen bei ${width}px`).toBeLessThanOrEqual(1);
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

test('Updates: Online-Status je Box mit Zählung und Schnellfilter, ohne Überlauf', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  const table = page.getByTestId('box-versions');
  await expect(table).toBeVisible();
  // Derselbe Stand wie im Reiter „Registrierung" - eine Regel, ein Wortlaut.
  await expect(page.getByTestId('online-zaehlung')).toHaveText('4 online · 1 offline · 1 nie gemeldet');
  const still = table.locator('tbody tr').filter({ hasText: 'Hof Lindenallee' });
  await expect(still).toContainText('Meldet sich nicht');
  await expect(still).toContainText('Letzte Meldung: vor 4 Std.');

  const gruppe = page.getByRole('group', { name: 'Boxen nach Online-Status filtern' });
  await expect(gruppe).toBeVisible();
  await gruppe.getByRole('button', { name: 'Offline 1' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await gruppe.getByRole('button', { name: 'Online 4' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(4);
  await gruppe.getByRole('button', { name: 'Alle 6' }).click();

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
