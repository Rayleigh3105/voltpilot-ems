import { createHash, generateKeyPairSync } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';

// WebKit braucht im Container unter parallelen Projekten 1-3 s je Klick; die drei Abläufe
// hier sind klickreich und lagen damit am 30-s-Vorgabewert (einzeln laufen sie in ~14 s).
test.describe.configure({ timeout: 60_000 });

test('Fernwartung: Lage, Sperrgründe und Fenster öffnen auf jeder Bildschirmgröße', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  await expect(page.getByRole('tab', { name: 'Fernwartung' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('fw-dienst')).toContainText('Tunnel-Dienst holt ab');
  await expect(page.getByText(/meldet der Tunnel-Dienst nicht zurück/)).toBeVisible();

  const boxen = page.getByTestId('fw-boxen');
  const gesperrt = boxen.locator('tr').filter({ hasText: 'edge-q2w3e4r' });
  await expect(gesperrt.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(gesperrt).toContainText('gesperrt - erst entsperren');
  // Jeder aktive Zugang hat an dieser Box schon ein Fenster: gesperrt mit Grund.
  const pilot = boxen.locator('tr').filter({ hasText: 'edge-zay5sdd' });
  await expect(pilot.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(pilot).toContainText('schon ein Fenster');

  const frei = boxen.locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Zwei freie Zugänge: nichts ist vorgewählt.
  await expect(dialog.getByRole('combobox', { name: /Techniker-Zugang/ })).toContainText('Zugang wählen');
  await dialog.getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Werkstatt-Tablet/ })).toHaveAttribute('aria-disabled', 'true');
  // Zwei Zugänge heißen gleich; der gesperrte bleibt mit Grund sichtbar, wählbar ist der aktive.
  await expect(page.getByRole('option', { name: /Alex \(Laptop\)/ })).toHaveCount(2);
  await page.getByRole('option', { name: /Alex \(Laptop\)/ }).filter({ hasNotText: 'Zugang gesperrt' }).click();
  await dialog.getByLabel('Grund *').fill('go-e prüfen');
  await dialog.getByRole('button', { name: 'Fenster öffnen' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(frei.getByText(/^bis .* · Alex \(Laptop\)$/)).toBeVisible();

  await expect(page.getByTestId('fw-protokoll')).toContainText('Fenster geöffnet');

  // Kein horizontaler Überlauf der Seite (Tabellen scrollen lokal).
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Fernwartung: ein gesperrter Zugang lässt sich nach einer Rückfrage endgültig löschen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  const zugaenge = page.getByTestId('fw-techniker');
  const alt = zugaenge.locator('tr').filter({ hasText: '10.10.32.2' });
  const neu = zugaenge.locator('tr').filter({ hasText: '10.10.32.3' });
  // Derselbe Name zweimal: der alte gesperrt, der neue aktiv.
  await expect(zugaenge.locator('tr').filter({ hasText: 'Alex (Laptop)' })).toHaveCount(2);
  await expect(alt).toContainText('gesperrt');
  await expect(neu).toContainText('aktiv');
  await expect(neu.getByRole('button', { name: 'Löschen' })).toHaveCount(0);

  // Die Rückfrage sagt in einem Satz, was passiert - und passt ganz auf den Schirm.
  const ausloeser = alt.getByRole('button', { name: 'Löschen' });
  await ausloeser.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const titel = dialog.getByRole('heading', { name: 'Zugang löschen?' });
  await expect(titel).toBeVisible();
  const satz = dialog.getByText(/verschwindet endgültig aus allen Listen und lässt sich nicht wiederherstellen\./);
  await expect(satz).toContainText('„Alex (Laptop)“ (10.10.32.2, dTkajHaC…V3kk=)');
  await expect(dialog.getByTestId('confirm-consequences')).toContainText('bleiben vergeben');
  const bestaetigen = dialog.getByRole('button', { name: 'Endgültig löschen' });
  await expect(bestaetigen).toBeInViewport({ ratio: 1 });
  await expect(satz).toBeInViewport({ ratio: 1 });
  for (const teil of [titel, satz, bestaetigen, dialog.getByRole('button', { name: 'Abbrechen' })]) {
    // Nichts abgeschnitten: kein Text ragt über seinen Kasten hinaus.
    expect(await teil.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: test.info().outputPath('loeschen-rueckfrage.png') });

  // Escape bricht ab: nichts gelöscht, der Fokus kehrt zum Auslöser zurück.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(alt).toBeVisible();
  await expect(ausloeser).toBeFocused();

  await ausloeser.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(alt).toHaveCount(0);
  await expect(zugaenge.locator('tr').filter({ hasText: 'Alex (Laptop)' })).toHaveCount(1);
  await expect(neu).toBeVisible();

  // Das Protokoll trägt den Eintrag und nennt den Zugang weiter beim Namen.
  const eintrag = page.getByTestId('fw-protokoll').locator('tr').filter({ hasText: 'Techniker-Zugang gelöscht' });
  await expect(eintrag).toContainText('Alex (Laptop)');
  await expect(eintrag).toContainText('10.10.32.2');
  await expect(eintrag).toContainText('bleiben vergeben');

  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung-nach-loeschen.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Fernwartung: ein gelöschter Zugang fehlt in der Auswahl, ein aktiver ist erst nach dem Sperren löschbar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  const zugaenge = page.getByTestId('fw-techniker');
  const alt = zugaenge.locator('tr').filter({ hasText: '10.10.32.2' });
  const neu = zugaenge.locator('tr').filter({ hasText: '10.10.32.3' });
  await alt.getByRole('button', { name: 'Löschen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(alt).toHaveCount(0);

  // Aus der Auswahl ist er auch weg: nur noch ein „Alex (Laptop)".
  const frei = page.getByTestId('fw-boxen').locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Alex \(Laptop\)/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  // Ein aktiver Zugang: erst sperren, dann erscheint „Löschen".
  await neu.getByRole('button', { name: 'Sperren' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sperren' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(neu.getByRole('button', { name: 'Löschen' })).toBeVisible();
  await expect(neu.getByRole('button', { name: 'Entsperren' })).toBeVisible();
  expect(errors).toEqual([]);
});

// ── SSH-Schlüssel des Technikers (Fenster-Schlüssel, Schritt 1) ───────────────────────────────

/** Ein frischer öffentlicher RSA-Schlüssel als .pub-Zeile; der private Teil wird nie gespeichert. */
function rsaZeile(bits: number): { zeile: string; fingerabdruck: string } {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const feld = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return Buffer.concat([l, b]);
  };
  const zahl = (b: Buffer) => (b[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
  const blob = Buffer.concat([
    feld(Buffer.from('ssh-rsa')),
    feld(zahl(Buffer.from(jwk.e, 'base64url'))),
    feld(zahl(Buffer.from(jwk.n, 'base64url'))),
  ]);
  return {
    zeile: `ssh-rsa ${blob.toString('base64')}`,
    fingerabdruck: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  };
}

/** Nichts abgeschnitten: kein Text ragt über seinen Kasten hinaus, und der Kasten liegt im Bild. */
async function nichtAbgeschnitten(teile: Locator) {
  const anzahl = await teile.count();
  expect(anzahl).toBeGreaterThan(0);
  for (let i = 0; i < anzahl; i += 1) {
    const teil = teile.nth(i);
    await teil.scrollIntoViewIfNeeded();
    expect(await teil.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const lage = await teil.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { links: r.left, rechts: r.right - document.documentElement.clientWidth };
    });
    expect(lage.links).toBeGreaterThanOrEqual(0);
    expect(lage.rechts).toBeLessThanOrEqual(0);
  }
}

test('Fernwartung: ein offenes Fenster zeigt die fertigen Befehle, ohne SSH-Schlüssel heißt es „nur Netzweg"', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  // Die Zugangsliste: Fingerabdruck oder ehrlich „keiner".
  const zugaenge = page.getByTestId('fw-techniker');
  const alex = zugaenge.locator('tr').filter({ hasText: '10.10.32.3' });
  const kim = zugaenge.locator('tr').filter({ hasText: '10.10.32.5' });
  await expect(alex).toContainText('SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc');
  await expect(alex).toContainText('RSA 3072');
  await expect(kim).toContainText('keiner');
  await expect(kim).toContainText('Fenster öffnen nur den Netzweg');
  await expect(page.getByTestId('fw-ssh-stand')).toContainText('An jeder anderen Box gelingt die Anmeldung nur mit einem Schlüssel, der schon auf der Box liegt');

  // Die Box mit zwei offenen Fenstern: die Befehle einmal, je Fenster ein Satz.
  const boxen = page.getByTestId('fw-boxen');
  await expect(boxen.getByTestId('fw-anmeldung')).toHaveCount(1);
  const mit = boxen.locator('[data-testid="fw-anmeldung"][data-box="edge-zay5sdd"]');
  await expect(mit.getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2', { exact: true })).toBeVisible();
  await expect(
    mit.getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 -L 8484:127.0.0.1:8484 root@10.10.16.2', { exact: true }),
  ).toBeVisible();
  await expect(mit).toContainText('danach im Browser: http://127.0.0.1:8484');
  await expect(mit.getByTestId('fw-anmeldung-vorhanden')).toContainText(
    '„Alex (Laptop)“: Anmeldung mit dem SSH-Schlüssel SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc',
  );
  await expect(mit.getByTestId('fw-anmeldung-fehlt')).toContainText('„Kim (Tablet)“: nur Netzweg. Der Zugang hat keinen SSH-Schlüssel');

  // Nichts abgeschnitten: Befehle, Sätze und Fingerabdruck brechen um, statt überzustehen.
  await nichtAbgeschnitten(mit.locator('.vp-fw-befehl > code'));
  await nichtAbgeschnitten(mit.locator('.vp-fw-anmeldung-fenster > li'));
  await nichtAbgeschnitten(zugaenge.locator('.vp-fw-fingerabdruck'));
  await nichtAbgeschnitten(page.getByTestId('fw-ssh-stand'));
  // Am breiten Schirm passt jeder Befehl in eine Zeile.
  if ((page.viewportSize()?.width ?? 0) >= 1200) {
    for (const hoehe of await mit.locator('.vp-fw-befehl > code').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(hoehe).toBeLessThan(40);
    }
  }

  // Kopieren meldet sich zurück und lässt die Seite ganz.
  const kopieren = mit.getByRole('button', { name: 'SSH-Befehl kopieren' });
  await kopieren.click();
  await expect(kopieren).toHaveText(/Kopiert|Markiert/);

  // Beim Öffnen sagt der Dialog, dass ein Fenster ohne SSH-Schlüssel nur den Netzweg öffnet.
  const frei = page.getByTestId('fw-boxen').locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Kim \(Tablet\)/ })).toContainText('ohne SSH-Schlüssel');
  await page.getByRole('option', { name: /Kim \(Tablet\)/ }).click();
  await expect(dialog.getByTestId('fw-fenster-box')).toHaveText('Box edge-k7m2xq3 (10.10.16.3)');
  await nichtAbgeschnitten(dialog.getByRole('heading', { name: 'Fernwartung öffnen' }));
  const warnung = dialog.getByTestId('fw-fenster-nur-netzweg');
  await expect(warnung).toContainText('Dieses Fenster öffnet nur den Netzweg. Der Zugang „Kim (Tablet)“ hat keinen SSH-Schlüssel');
  await nichtAbgeschnitten(warnung);
  await page.screenshot({ path: test.info().outputPath('fenster-nur-netzweg.png') });
  await dialog.getByLabel('Grund *').fill('Zähler prüfen');
  await dialog.getByRole('button', { name: 'Fenster öffnen' }).click();
  await expect(dialog).not.toBeVisible();
  const neu = boxen.locator('[data-testid="fw-anmeldung"][data-box="edge-k7m2xq3"]');
  await expect(neu.getByTestId('fw-anmeldung-fehlt')).toContainText('„Kim (Tablet)“: nur Netzweg');
  await expect(neu.getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.3', { exact: true })).toBeVisible();

  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung-ssh.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Fernwartung: der SSH-Schlüssel wird am Zugang hinterlegt, geprüft, ersetzt und entfernt', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');
  const neu = rsaZeile(2048);

  const zugaenge = page.getByTestId('fw-techniker');
  const kim = zugaenge.locator('tr').filter({ hasText: '10.10.32.5' });
  const ausloeser = kim.getByRole('button', { name: 'SSH-Schlüssel' });
  await ausloeser.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'SSH-Schlüssel', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Zugang „Kim (Tablet)“ (10.10.32.5)');
  await expect(dialog.getByTestId('fw-ssh-aktuell')).toContainText('Kein SSH-Schlüssel hinterlegt');

  // Die Befehle zum Erzeugen für Windows und Linux, ganz lesbar.
  const erzeugen = dialog.getByTestId('fw-ssh-erzeugen');
  await expect(erzeugen).toContainText('Windows (PowerShell)');
  await expect(erzeugen).toContainText('Linux und macOS');
  await expect(erzeugen.getByText('ssh-keygen -t rsa -b 3072 -f $env:USERPROFILE\\.ssh\\id_rsa_voltpilot', { exact: true })).toBeVisible();
  await expect(erzeugen.getByText('ssh-keygen -t rsa -b 3072 -f ~/.ssh/id_rsa_voltpilot', { exact: true })).toBeVisible();
  await expect(erzeugen.getByText('cat ~/.ssh/id_rsa_voltpilot.pub', { exact: true })).toBeVisible();
  await nichtAbgeschnitten(erzeugen.locator('.vp-fw-befehl > code'));
  await nichtAbgeschnitten(dialog.getByRole('heading', { name: 'SSH-Schlüssel', exact: true }));

  // Leer: Fehler am Feld, Fokus im Feld.
  const feld = dialog.getByLabel(/Öffentlicher SSH-Schlüssel/);
  const speichern = dialog.getByRole('button', { name: 'Schlüssel hinterlegen' });
  await speichern.click();
  await expect(dialog.getByText('Der SSH-Schlüssel fehlt.')).toBeVisible();
  await expect(feld).toBeFocused();

  // Ed25519: abgelehnt mit dem passenden Befehl.
  await feld.fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLyX1xk1mOWzuZuZ7p1cYy6mH7nqYbC3o5sJt0m3cQm kim@tablet');
  await speichern.click();
  const ablehnung = dialog.getByText(/Das ist ein Ed25519-Schlüssel\. Die Boxen nehmen nur RSA an\..*ssh-keygen -t rsa -b 3072/);
  await expect(ablehnung).toBeVisible();
  await nichtAbgeschnitten(ablehnung);
  await page.screenshot({ path: test.info().outputPath('ssh-dialog-ablehnung.png') });

  // Ein RSA-Schlüssel mit Kommentar: angenommen, der Fingerabdruck ist der echte.
  await feld.fill(`${neu.zeile} kim@tablet`);
  await speichern.click();
  const ergebnis = dialog.getByTestId('fw-ssh-fingerabdruck');
  await expect(ergebnis).toContainText(`${neu.fingerabdruck} (RSA 2048)`);
  await expect(ergebnis.getByText('ssh-keygen -lf ~/.ssh/id_rsa_voltpilot.pub', { exact: true })).toBeVisible();
  await nichtAbgeschnitten(ergebnis.locator('.vp-fw-befehl > code'));
  await nichtAbgeschnitten(ergebnis.locator('strong'));
  await page.screenshot({ path: test.info().outputPath('ssh-dialog-hinterlegt.png') });
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(ausloeser).toBeFocused();

  // Liste, Fensterzeile und Protokoll folgen.
  await expect(kim).toContainText(neu.fingerabdruck);
  await expect(kim).toContainText('RSA 2048');
  const pilot = page.getByTestId('fw-boxen').locator('[data-testid="fw-anmeldung"][data-box="edge-zay5sdd"]');
  await expect(pilot.getByTestId('fw-anmeldung-fehlt')).toHaveCount(0);
  await expect(pilot.getByTestId('fw-anmeldung-vorhanden')).toHaveCount(2);
  const gesetzt = page.getByTestId('fw-protokoll').locator('tr').filter({ hasText: 'SSH-Schlüssel gesetzt' });
  await expect(gesetzt).toContainText('Kim (Tablet)');
  await expect(gesetzt).toContainText(`${neu.fingerabdruck} · RSA 2048`);

  // Entfernen fragt nach und führt zurück zum reinen Netzweg.
  await ausloeser.click();
  await expect(dialog.getByTestId('fw-ssh-aktuell')).toContainText(neu.fingerabdruck);
  await dialog.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(dialog.getByTestId('fw-ssh-entfernen')).toContainText('nur noch den Netzweg');
  await nichtAbgeschnitten(dialog.getByTestId('fw-ssh-entfernen'));
  await dialog.getByRole('button', { name: 'Schlüssel entfernen' }).click();
  await expect(dialog.getByText(/SSH-Schlüssel entfernt/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(kim).toContainText('keiner');
  await expect(pilot.getByTestId('fw-anmeldung-fehlt')).toHaveCount(1);
  await expect(page.getByTestId('fw-protokoll').locator('tr').filter({ hasText: 'SSH-Schlüssel entfernt' })).toContainText(
    'der Zugang öffnet nur noch den Netzweg',
  );

  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('Fernwartung: ein neuer Zugang bekommt seinen SSH-Schlüssel gleich beim Anlegen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');
  const neu = rsaZeile(3072);

  await page.getByRole('button', { name: 'Zugang anlegen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('fw-ssh-erzeugen')).toContainText('Windows (PowerShell)');
  await dialog.getByLabel('Name *').fill('Robin (Notebook)');
  await dialog.getByLabel(/Öffentlicher WireGuard-Schlüssel/).fill('J6rNG4CFG4rBxl+z8To/r1PyuoEkEGjeXHqlbzGGwZ8=');
  // Ein zu kurzer Schlüssel hält das Anlegen auf und nennt Länge und Befehl.
  await dialog.getByLabel(/Öffentlicher SSH-Schlüssel/).fill(rsaZeile(1024).zeile);
  await dialog.getByRole('button', { name: 'Zugang anlegen' }).click();
  await expect(dialog.getByText(/nur 1024 Bit, verlangt sind mindestens 2048.*ssh-keygen -t rsa -b 3072/)).toBeVisible();
  await expect(dialog.getByLabel(/Öffentlicher SSH-Schlüssel/)).toBeFocused();

  await dialog.getByLabel(/Öffentlicher SSH-Schlüssel/).fill(`${neu.zeile} robin@notebook`);
  await page.screenshot({ path: test.info().outputPath('zugang-anlegen.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Zugang anlegen' }).click();
  await expect(dialog.getByTestId('fw-techniker-konfig')).toContainText('„Robin (Notebook)“');
  await expect(dialog.getByTestId('fw-ssh-fingerabdruck')).toContainText(`${neu.fingerabdruck} (RSA 3072)`);
  await nichtAbgeschnitten(dialog.getByTestId('fw-ssh-fingerabdruck').locator('strong'));
  await dialog.getByRole('button', { name: 'Fertig' }).click();
  await expect(dialog).not.toBeVisible();

  const robin = page.getByTestId('fw-techniker').locator('tr').filter({ hasText: 'Robin (Notebook)' });
  await expect(robin).toContainText(neu.fingerabdruck);
  await expect(page.getByTestId('fw-protokoll').locator('tr').filter({ hasText: 'Techniker-Zugang angelegt' })).toContainText(
    `SSH ${neu.fingerabdruck}`,
  );
  expect(errors).toEqual([]);
});
