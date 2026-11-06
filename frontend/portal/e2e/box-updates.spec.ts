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

test('Updates: Lage, Linien und Braucht dich - „Box ansehen" führt in die Geräteakte (Scheibe S2)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  // Scheibe S1 (N5): die Seite trägt seither EINEN Namen - „Software" (Reiter des Raums „Plattform").
  await expect(page.getByRole('tab', { name: 'Software', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('lage')).toContainText('1 Box hält ein Update zurück: Gewerbepark West.');
  const docker = page.getByTestId('linie-docker');
  await expect(docker.getByTestId('linie-neuestes')).toHaveText('edge-2026.09.10');
  await expect(docker.getByTestId('linie-plattformen')).toContainText('Raspberry Pi · arm64');
  const light = page.getByTestId('linie-light');
  await expect(light.getByTestId('linie-neuestes')).toHaveText('edge-light-2026.09.12');
  await expect(light.getByTestId('linie-plattformen')).toContainText('Mango · mipsle ✓');

  // Der Lauf in der Karte (G6): drei Zahlen statt eines gemischten Zustands.
  const lauf = docker.getByTestId('linie-lauf');
  await expect(lauf).toContainText('edge-2026.09.10 an 3 Boxen');
  await expect(lauf).toContainText('3angefragt (Portal)1angenommen (Box)0bestätigt (Box)');
  const aufgaben = page.getByTestId('braucht-dich').getByTestId('aufgabe');
  await expect(aufgaben).toHaveCount(3);
  await expect(aufgaben.nth(0)).toContainText('Gewerbepark West: hält das Update zurück');
  await expect(aufgaben.nth(1)).toContainText('Hof Lindenallee ist seit 4');
  await expect(aufgaben.nth(2)).toContainText('Kleingarten Ostend: nur von Hand (Stufe 1)');

  // Die Boxenliste entfällt hier (§4.3, S2): „Box ansehen" führt direkt in die Geräteakte dieser Box, nie in ein Fenster.
  await aufgaben.nth(0).getByRole('button', { name: 'Box ansehen' }).click();
  await expect(page.getByTestId('akte-zustand')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Gewerbepark West' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Box-Art: Stufe 1 - „Nachrüsten" führt in die Geräteakte statt in ein Fenster', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  const light = page.getByTestId('linie-light');
  await expect(light).toContainText('1 nur von Hand (Stufe 1)');
  await expect(light.getByRole('button', { name: 'Verteilen …' })).toHaveCount(0);
  await light.getByRole('button', { name: 'Nachrüsten: so geht’s' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kleingarten Ostend' })).toBeVisible();
  await expect(page.getByTestId('akte-reiter').getByRole('tab', { name: 'Software' })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('Update verteilen: Gruppen, „Erst eine Box“ und der Knopf, der sagt, was passiert (G6)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  await page.getByTestId('linie-docker').getByRole('button', { name: 'Releases (2)' }).click();
  await page.getByRole('dialog', { name: 'Releases · Docker-Box' }).getByRole('button', { name: /Verteilen/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Update verteilen · Docker-Box' });
  await expect(dialog.getByRole('radio', { name: /edge-2026\.09\.10/ })).toBeChecked();
  await expect(dialog.getByTestId('verteil-bereit')).toContainText('Ahrenberg Lager');
  await expect(dialog.getByTestId('verteil-bereit')).toContainText('Ahrenberg Werk 1');
  await expect(dialog.getByTestId('verteil-wartet')).toContainText('Neubau am Feldrain');
  await expect(dialog.getByTestId('verteil-angefragt')).toContainText('Werkstatt am Bach');
  await expect(dialog.getByTestId('verteil-aktuell')).toContainText('Solarpark Sonnenhof');
  await expect(dialog).toContainText('1 Box der anderen Linie kommt für dieses Release nicht in Frage.');
  // „Erst eine Box" ist vorgeschlagen - eine bereite (online) Box.
  await expect(dialog.getByRole('radio', { name: /Erst eine Box: Ahrenberg Lager/ })).toBeChecked();
  await expect(dialog.getByTestId('verteil-satz')).toContainText('Fragt jetzt 1 Box an.');
  await dialog.getByRole('button', { name: '1 Box anfragen' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Aktion ist fehlgeschlagen');
  await dialog.getByRole('radio', { name: /Alle 3 auf einmal/ }).click();
  await expect(dialog.getByRole('button', { name: '3 Boxen anfragen' })).toBeEnabled();

  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const over = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="verteil-dialog"]')!;
      return { seite: document.documentElement.scrollWidth - innerWidth, dialog: d.scrollWidth - d.clientWidth };
    });
    expect(over.seite, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
    expect(over.dialog, `Dialog bei ${width}px`).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Release-Seite: Inhalt, was neu ist, wo es läuft, wann verteilt - von dort in die Geräteakte und zum Verteilen (G7)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  await page.getByTestId('linie-docker').getByTestId('linie-neuestes').click();
  const seite = page.getByRole('dialog', { name: 'edge-2026.09.10' });
  await expect(seite.getByTestId('release-aenderungen')).toContainText('Änderungen an der Box seit edge-2026.09.02: 2');
  await expect(seite).toContainText('Core: Neuverbindung nach Funkloch (#1601)');
  await expect(seite.getByTestId('release-inhalt')).toContainText('Bild core');
  await expect(seite.getByTestId('release-inhalt')).toContainText('PC und Raspberry Pi');
  await expect(seite.getByTestId('release-laeuft-auf')).toContainText('1 von 6 Docker-Boxen: Solarpark Sonnenhof.');
  await expect(seite.getByTestId('release-verteilt')).toContainText('an 3 Boxen angefragt · 0 bestätigt');
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(over, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  // Von der Release-Seite führt eine Box seit S2 direkt in ihre Geräteakte, nie in ein zweites Fenster.
  await seite.getByRole('button', { name: 'Solarpark Sonnenhof' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Solarpark Sonnenhof' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // … und zum Verteilen (zurück auf der Software-Seite).
  await page.getByRole('button', { name: 'Plattform', exact: true }).click();
  await page.getByRole('tab', { name: 'Software', exact: true }).click();
  await page.getByTestId('linie-light').getByTestId('linie-neuestes').click();
  const light = page.getByRole('dialog', { name: 'edge-light-2026.09.12' });
  await expect(light.getByTestId('release-inhalt')).toContainText('Mango');
  await expect(light.getByTestId('release-inhalt')).toContainText('geprüft');
  await expect(light.getByTestId('release-inhalt')).toContainText('Loader, Dienst, Tunnel-Skripte');
  await light.getByRole('button', { name: 'Verteilen …' }).click();
  await expect(page.getByRole('dialog', { name: 'Update verteilen · Edge Light' })).toBeVisible();
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
  // Die einzige Edge-Light-Box hat Stufe 1: statt „Verteilen" der Weg zum Nachrüsten - in die Geräteakte.
  await expect(light.getByRole('button', { name: 'Verteilen …' })).toHaveCount(0);

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

// ---------------------------------------------------------------------------
// Scheibe S2 (Konzept `vp-adminview-konzept-k1` §4.4): die Geräte-Liste - eine
// Zeile je Box in jedem Lebensabschnitt, nie mehr nur die Aufkleber-Registry.
// ---------------------------------------------------------------------------

test('Geräte-Liste: jede Box in jedem Lebensabschnitt, eine Zeile führt in die Akte, ohne Überlauf', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  const liste = page.getByTestId('geraete-liste');
  await expect(liste).toBeVisible();
  await expect(liste).toContainText('Solarpark Sonnenhof');
  // Gedruckt, wartet und Werkstatt stehen in derselben Liste wie die verbundene Flotte.
  await expect(liste).toContainText('VP-5566-ZQTF');
  await expect(liste).toContainText('edge-xyz234q');
  await expect(liste).toContainText('VP-WRK-0007');

  // Dieselbe Online-Regel wie zuvor in der Software-Linie.
  const still = liste.locator('tr').filter({ hasText: 'Hof Lindenallee' });
  await expect(still).toContainText('Meldet sich nicht');
  const nie = liste.locator('tr').filter({ hasText: 'Neubau am Feldrain' });
  await expect(nie).toContainText('Wartet auf erste Meldung');

  // Zähl-Chips filtern die Liste.
  await page.getByRole('button', { name: /^Werkstatt \d/ }).click();
  await expect(liste.locator('tbody tr')).toHaveCount(1);
  await expect(liste).toContainText('VP-WRK-0007');
  await page.getByRole('button', { name: /^Werkstatt \d/ }).click();

  // Eine Zeile führt in die Geräteakte, nie in ein zweites Fenster.
  await page.getByRole('button', { name: 'edge-a1' }).or(liste.getByText('Solarpark Sonnenhof')).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Solarpark Sonnenhof' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.goBack();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('Geräte-Liste: EINE Filterzeile statt zweier Grau-Balken, ohne Überlauf bei 1440 und 390 px', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  const liste = page.getByTestId('geraete-liste');
  await expect(liste).toBeVisible();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const kopf = page.locator('.vp-admin-sec-head');
    await expect(kopf.locator('.vp-gu-filterzeile')).toBeVisible();
    // Beide Segmente teilen dieselbe Chip-Sprache (`.vp-gu-seg`) statt zweier roher `.vp-seg`-Balken.
    expect(await kopf.locator('.vp-gu-seg').count()).toBeGreaterThanOrEqual(2);
    const { raus } = await ueberlauf(page, '.vp-admin-sec-head');
    expect(raus, `Überlauf im Filterkopf bei ${width}px`).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }

  // Ein Chip bleibt bedienbar - kein Totholz durch die neue Auszeichnung.
  await page.getByRole('button', { name: /^Werkstatt \d/ }).click();
  await expect(liste.locator('tbody tr')).toHaveCount(1);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Scheibe S2 §4.4: die Geräteakte - EIN Ort je Box, Kopf, Reiter inline.
// ---------------------------------------------------------------------------

test('Geräteakte: Kopf mit Zustand, fünf Reiter, Fernwartung inline - ohne Überlauf bei 1440 und 390 px', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/e2e/box-updates.html#');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  await page.getByTestId('geraete-liste').getByText('Solarpark Sonnenhof').first().click();

  await expect(page.getByTestId('akte-zustand')).toContainText('Verbunden');
  const tabs = page.getByTestId('akte-reiter');
  await expect(tabs).toContainText('Überblick');
  await expect(tabs).toContainText('Software');
  await expect(tabs).toContainText('Verbindung');
  await expect(tabs).toContainText('Anlage');
  await expect(tabs).toContainText('Einrichtung');
  await expect(tabs).toContainText('Verlauf');

  // Verbindung: die Fernwartungs-Karte EINER Box inline, kein zweites Fenster.
  await tabs.getByRole('tab', { name: 'Verbindung' }).click();
  await expect(page.getByTestId('fw-karte')).toBeVisible();
  await expect(page.getByTestId('fw-karte')).toContainText('Tunnel 10.90.4.12');

  await tabs.getByRole('tab', { name: 'Software' }).click();
  await expect(page.getByText('Linie und Stand')).toBeVisible();

  // Anlage (Scheibe S3): Plan, Steuerung & Abregelung, Scharfschalten, Fassung, Werkzeuge - alles inline.
  await tabs.getByRole('tab', { name: 'Anlage' }).click();
  await expect(page.getByText('Steuerung und Abregelung')).toBeVisible();
  await expect(page.getByText('Komponenten-Fassung')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zurücknehmen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan erklären (Optimizer)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flows' })).toBeVisible();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('Geräteakte am Telefon: Überblick einer nicht verbundenen Box bleibt unter dem Wort-Budget', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/box-updates.html');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  await page.getByTestId('geraete-liste').getByText('VP-5566-ZQTF').first().click();
  await expect(page.getByTestId('akte-zustand')).toContainText('Noch nicht verbunden');
  const woerter = await page.evaluate(() => {
    const kopf = document.querySelector('.vp-admin-head');
    const erster = document.querySelector('.vp-card');
    const text = [kopf, erster].filter(Boolean).map((el) => el!.textContent ?? '').join(' ');
    return text.trim().split(/\s+/).filter(Boolean).length;
  });
  expect(woerter).toBeLessThanOrEqual(60);
});

// ---------------------------------------------------------------------------
// Scheibe S7 (Konzept §5): die fünf Zustände nach Tabelle 5.3, dazu der
// L2-Sonderfall - alle sichtbar in der Geräteakte, ohne Überlauf.
// ---------------------------------------------------------------------------

test('Geräteakte: alle fünf Zustände nach §5.3 plus der L2-Sonderfall, ohne Überlauf bei 1440 und 390 px', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const zumZustand = async (box: string) => {
    await page.getByRole('button', { name: 'Geräte', exact: true }).click();
    await page.getByTestId('geraete-liste').getByText(box).first().click();
  };

  // Verbunden (Solarpark Sonnenhof) - und der L2-Sonderfall: Herzschlag in
  // Ordnung, Messwerte seit einer Weile aus, der Kopf bleibt „Verbunden".
  await page.goto('/e2e/box-updates.html');
  await zumZustand('Solarpark Sonnenhof');
  await expect(page.getByTestId('akte-zustand')).toContainText('Verbunden');
  await expect(page.getByTestId('akte-messwert-luecke')).toContainText('Messwerte seit');
  await expect(page.getByTestId('akte-messwert-luecke')).toContainText('Datenannahme');

  // Verzögert (E6) - Werkstatt am Bach: drei ausgebliebene Herzschläge, reine Anzeige.
  await zumZustand('Werkstatt am Bach');
  await expect(page.getByTestId('akte-zustand')).toContainText('Verzögert');

  // Meldet sich nicht - Hof Lindenallee.
  await zumZustand('Hof Lindenallee');
  await expect(page.getByTestId('akte-zustand')).toContainText('Meldet sich nicht');

  // Wartet auf erste Meldung - Neubau am Feldrain (nie ein Strich-Platzhalter).
  await zumZustand('Neubau am Feldrain');
  await expect(page.getByTestId('akte-zustand')).toContainText('Wartet auf erste Meldung');

  // Unbekannt - Gewerbepark West (ein älterer Serverstand liefert das Feld gar nicht).
  await zumZustand('Gewerbepark West');
  await expect(page.getByTestId('akte-zustand')).toContainText('Stand unbekannt');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
