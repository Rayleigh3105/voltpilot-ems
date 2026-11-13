import { expect, test } from '@playwright/test';

/** Kein waagrechter Überlauf der Seite (Muster `box-updates.spec.ts`). */
async function ueberlauf(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
}

test('Plattform › Übersicht: vier Kacheln, Braucht dich, Flotte, Dienste - Antwort zuerst', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Die Reiterleiste ist nur die Rechner-Fassung (§4.3) - ohne das zeigt `mobile-webkit`s
  // Standard-Ansicht (390 px) die Zeilen-Liste statt des Tablists.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/plattform-uebersicht.html');

  await expect(page.getByRole('tab', { name: 'Übersicht', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('ueb-stand')).toContainText('alle 30 s');

  // Vier Kacheln, je eine Ausnahme-Zahl.
  const kacheln = page.getByTestId('ueb-kacheln');
  await expect(kacheln).toContainText('Verbindung');
  await expect(kacheln).toContainText('Software');
  await expect(kacheln).toContainText('Steuerung');
  await expect(kacheln).toContainText('Plan');

  // Braucht dich, in der Rangfolge aus dem Report: Fehler > Zurückhalten >
  // offline mit Anfrage > Stufe 1 > Fenster ohne Schlüssel > Werkstatt nicht
  // bereit > nicht zugeordnete Anmeldung.
  const zeilen = page.getByTestId('ueb-braucht-zeile');
  await expect(zeilen).toHaveCount(7);
  await expect(zeilen.nth(0)).toContainText('Pumpwerk Ost');
  await expect(zeilen.nth(1)).toContainText('Gewerbepark West');
  await expect(zeilen.nth(2)).toContainText('Hof Lindenallee');
  await expect(zeilen.nth(3)).toContainText('Kleingarten Ostend');
  await expect(zeilen.nth(4)).toContainText('VP-BOX-1001');
  await expect(zeilen.nth(5)).toContainText('edge-m1');
  await expect(zeilen.nth(6)).toContainText('edge-q7xk2p9');

  // Eine Zeile führt in die Geräteakte - nie in ein Fenster.
  await zeilen.nth(0).click();
  await expect(page.getByTestId('akte-zustand')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Flotte als Gerätewand (Konzept vp-flottenbild-konzept, Weg B): jede Box ein
  // Gerät mit Kunde und Anlage - auch die gesunden, „ich brauch ewig, bis ich da
  // was erkenne" (Captain). Ein Wort steht nur bei einer Abweichung, eine Legende
  // gibt es nicht; Tippen öffnet die Akte (eigener Aufruf, da die Vorschau ohne
  // echtes Routing navigiert - kein Browserverlauf).
  await page.goto('/e2e/plattform-uebersicht.html');
  const flotte = page.getByTestId('ueb-flotte');
  await expect(flotte).toContainText('9 Boxen · 4 Kunden');
  const geraete = flotte.getByTestId('ueb-flotte-box');
  await expect(geraete).toHaveCount(9);
  // Störung vorn, dann Hinweise, dann die ruhigen.
  // WCAG 2.5.3 (Label in Name): das Zustandswort steht VORN und ohne Komma - ein Komma im Namen
  // wäre kein Teilstring des sichtbaren Texts mehr (axe label-content-name-mismatch).
  await expect(geraete.nth(0)).toHaveAccessibleName(/^offline Familie Beispiel Hof Lindenallee/);
  await expect(geraete.nth(1)).toHaveAccessibleName(/^verzögert Kunststoffwerk Ahrenberg Werk Ahrenberg Box Halle 3/);
  await expect(geraete.nth(2)).toHaveAccessibleName(/^Update läuft Stadtwerke Musterstadt Werkstatt am Bach/);
  await expect(geraete.nth(3)).toHaveAccessibleName(/^nur von Hand Familie Beispiel Kleingarten Ostend/);
  await expect(geraete.nth(0)).toContainText('offline');
  // Mehrere Boxen an EINER Anlage tragen ihren Gerätenamen dazu - in einer eigenen Zeile.
  await expect(geraete.nth(1)).toContainText('Box Halle 3');
  await expect(flotte.getByText('Box Leitstand', { exact: true })).toBeVisible();
  // Gesunde Boxen tragen kein Wort - nur ihre Leuchte, auch nicht im Namen (sonst stünde dort ein
  // Wort, das im sichtbaren Text gar nicht vorkommt).
  await expect(geraete.nth(8)).toHaveAccessibleName(/^Stadtwerke Musterstadt Solarpark Sonnenhof: Geräteakte öffnen$/);
  await expect(geraete.nth(8)).not.toContainText('verbunden');
  await expect(flotte).not.toContainText('meldet sich nicht');
  // Eine Anlage ohne Box: ein Hinweis mit Weg zur Kundenakte statt einer Zeile „· 0".
  const ohneBox = page.getByTestId('ueb-flotte-ohnebox');
  await expect(ohneBox).toContainText('1 Anlage ohne Box');
  await expect(ohneBox.getByRole('link', { name: /Familie Neumann/ })).toHaveAttribute('href', /^#\/plattform\/benutzer\/t\d+$/);
  await geraete.nth(0).click();
  await expect(page.getByTestId('akte-zustand')).toBeVisible();

  // Dienste: Tunnel- und Werkstatt-Dienst mit Alter (E7).
  await page.goto('/e2e/plattform-uebersicht.html');
  const dienste = page.getByTestId('ueb-dienste');
  await expect(dienste).toContainText('Tunnel-Dienst');
  await expect(dienste).toContainText('Werkstatt-Dienst');

  // Bewusst ohne Geld (Captain-Entscheid Q2).
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('€');
  expect(text).not.toMatch(/verdient|gespart|Erlös/i);

  expect(errors).toEqual([]);
});

test('Plattform › Übersicht: Braucht dich - erledigen, einklappbar wieder ansehen, zurückholen', async ({ page }) => {
  await page.goto('/e2e/plattform-uebersicht.html');
  const zeilen = page.getByTestId('ueb-braucht-zeile');
  const vorher = await zeilen.count();
  await expect(page.getByTestId('ueb-braucht-dich')).toBeVisible();

  const erste = zeilen.first();
  await erste.getByRole('button', { name: /als erledigt markieren/i }).click();
  await expect(zeilen).toHaveCount(vorher - 1);

  const auf = page.getByRole('button', { name: /Erledigte anzeigen/ });
  await expect(auf).toContainText('(1)');
  await auf.click();
  await expect(page.locator('.vp-ueb-braucht-erledigte-zeile')).toHaveCount(1);

  await page.getByRole('button', { name: /zurückholen/ }).click();
  await expect(zeilen).toHaveCount(vorher);
});

test('Plattform › Übersicht: schnelles Hintereinander-Klicken auf mehrere Häkchen markiert ALLE Zeilen als erledigt', async ({ page }) => {
  await page.goto('/e2e/plattform-uebersicht.html');
  const zeilen = page.getByTestId('ueb-braucht-zeile');
  const vorher = await zeilen.count();
  expect(vorher).toBeGreaterThan(1);

  // Alle Häkchen in einem Zug anklicken - kein Warten zwischen den Klicks,
  // genau wie der Captain, der Zeile für Zeile schnell abhakt (Bug-Report).
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLButtonElement>('.vp-ueb-braucht-erledigt-knopf')
      .forEach((knopf) => knopf.click());
  });

  await expect(zeilen).toHaveCount(0);
  await expect(page.getByText(/Keine Box braucht dich gerade/)).toBeVisible();
  const auf = page.getByRole('button', { name: /Erledigte anzeigen/ });
  await expect(auf).toContainText(`(${vorher})`);
  await auf.click();
  await expect(page.locator('.vp-ueb-braucht-erledigte-zeile')).toHaveCount(vorher);
});

test('Plattform › Übersicht: Software-Kachel führt auf die Software-Seite', async ({ page }) => {
  await page.goto('/e2e/plattform-uebersicht.html');
  await page.getByTestId('ueb-kacheln').getByRole('button', { name: /Software/ }).click();
  await expect(page.getByRole('tab', { name: 'Software', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('Plattform › Übersicht am Telefon: Zeilen statt Reiterleiste, Wort-Budget, kein Überlauf', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/plattform-uebersicht.html');

  // Die waagrecht scrollende Reiterleiste weicht Zeilen am Ende (§4.3).
  await expect(page.getByRole('tablist', { name: 'Plattform' })).toBeHidden();
  const reiter = page.getByTestId('ueb-reiter-zeilen');
  await expect(reiter).toContainText('Software');
  await expect(reiter).toContainText('Werkstatt');
  await expect(reiter).toContainText('Fernwartung');
  await expect(reiter).toContainText('Katalog');
  await reiter.getByText('Fernwartung', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fernwartung' })).toBeVisible();
  await page.goto('/e2e/plattform-uebersicht.html');

  // Erster Bildschirm: Kopf + vier Kacheln - das Board misst hier 50 Wörter.
  const woerter = await page.evaluate(() => {
    const kopf = document.querySelector('.vp-admin-head');
    const kacheln = document.querySelector('[data-testid="ueb-kacheln"]');
    const text = [kopf, kacheln].filter(Boolean).map((el) => el!.textContent ?? '').join(' ');
    return text.trim().split(/\s+/).filter(Boolean).length;
  });
  expect(woerter).toBeLessThanOrEqual(50);

  // 768 px ist die Stichprobe des Mobil-Durchgangs vp-adminview-mobile-rework (Tablet - weder
  // Telefon noch Rechner; genau dort lief eine Fernwartungs-Tabelle über den Rand, Fix in
  // Fernwartung.css). Die Übersicht selbst zeigt hier keinen Befund.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const seite = await ueberlauf(page);
    expect(seite, `Seitenüberlauf bei ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('Plattform › Übersicht: Flotte mit 40 Boxen - am Rechner alle, am Telefon klappen die ruhigen zu (E2=A)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/plattform-uebersicht.html?flotte=gross');
  const flotte = page.getByTestId('ueb-flotte');
  await expect(flotte).toContainText('40 Boxen · 35 Kunden');
  await expect(flotte.getByTestId('ueb-flotte-box')).toHaveCount(40);
  await expect(flotte.getByRole('button', { name: /weitere Boxen/ })).toHaveCount(0);
  // Fünf Geräte je Reihe: die Wand füllt die Breite unter „Braucht dich".
  const reihe = await flotte.getByTestId('ueb-flotte-box').evaluateAll((els) => {
    const top = els[0].getBoundingClientRect().top;
    return els.filter((el) => Math.abs(el.getBoundingClientRect().top - top) < 2).length;
  });
  expect(reihe).toBe(5);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/plattform-uebersicht.html?flotte=gross');
  const klappe = flotte.getByRole('button', { name: /36 weitere Boxen · alle verbunden/ });
  await expect(klappe).toHaveAttribute('aria-expanded', 'false');
  // Offen bleiben die vier mit Abweichung (offline, verzögert, Update läuft, nur von Hand).
  await expect(flotte.getByTestId('ueb-flotte-box').filter({ visible: true })).toHaveCount(4);
  const zwei = await flotte.getByTestId('ueb-flotte-box').filter({ visible: true }).evaluateAll((els) =>
    els.slice(0, 2).map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(zwei[0], 'zwei Geräte je Reihe am Telefon').toBe(zwei[1]);
  await klappe.click();
  await expect(klappe).toHaveAttribute('aria-expanded', 'true');
  await expect(flotte.getByTestId('ueb-flotte-box').filter({ visible: true })).toHaveCount(40);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(1);
  // Das Wort und die Namen bleiben in ihrer Kachel - auch „nur von Hand" am schmalen Telefon.
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Gemessen gegen die INNENkante der Kachel (ohne Polster) - ein Wort, das ins
    // Polster ragt, stößt sichtbar an den Rand, auch wenn nichts über die Karte hinausgeht.
    const ueberstand = await flotte.getByTestId('ueb-flotte-box').evaluateAll((els) => els.flatMap((el) => {
      const k = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const links = k.left + parseFloat(st.borderLeftWidth) + parseFloat(st.paddingLeft);
      const rechts = k.right - parseFloat(st.borderRightWidth) - parseFloat(st.paddingRight);
      const raus = (r: DOMRect) => r.width > 0 && (r.right > rechts + 0.5 || r.left < links - 2.5);
      const out = [...el.querySelectorAll('*')].filter((c) => raus(c.getBoundingClientRect()))
        .map((c) => `${el.getAttribute('aria-label')}: <${c.tagName.toLowerCase()}> ${c.textContent}`);
      // Auch Text, der aus seinem Element läuft (ein gewollt abgeschnittener Text zählt mit seinem Kasten).
      const gang = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = gang.nextNode(); n; n = gang.nextNode()) {
        const eltern = n.parentElement!;
        if (!n.textContent?.trim()) continue;
        const geschnitten = getComputedStyle(eltern).overflowX === 'hidden';
        const bereich = document.createRange();
        bereich.selectNodeContents(n);
        if (raus(geschnitten ? eltern.getBoundingClientRect() : bereich.getBoundingClientRect())) {
          out.push(`${el.getAttribute('aria-label')}: Text „${n.textContent}"`);
        }
      }
      return out;
    }));
    expect(ueberstand, `Überstand in Kacheln bei ${width}px`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

