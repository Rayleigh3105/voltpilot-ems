import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Plattform-Administrator › Benutzer › Kunde öffnen › „Wie der Kunde es sieht" (vormals „In Mandanten-Ansicht
 * springen"), OHNE Unterstützung.
 * Seit dem 26.10.2026 ist der Mandanten-Umschalter wieder offen (Entscheidung des Betreibers): die API nimmt den
 * Mandanten an, der Sprung landet in seiner Ansicht - auch bei einem Mandanten ohne Standort und beim gemerkten
 * Mandanten nach dem Neuladen. Ist der Schalter aus (Not-Aus, `?schalter=aus`), nennt die Karte Grund und Weg statt
 * „Kein Standort zugewiesen". Wirt: `mandantensprung.html` (ganzer `App`, gefälschter Server).
 */
async function oeffne(page: Page, mandant: string): Promise<Locator> {
  await page.goto('/e2e/mandantensprung.html#/mandanten');
  await page.getByRole('button', { name: `Details zu ${mandant}` }).click();
  const dialog = page.getByRole('region', { name: mandant });
  await expect(dialog.getByRole('heading', { name: 'Unterstützung' })).toBeVisible();
  return dialog;
}

/** Kein Querrollen der Seite; jedes Element der Fläche bleibt in ihr und schneidet seinen Text nicht ab. */
async function passt(page: Page, flaeche: Locator, teile: string) {
  const mass = await flaeche.evaluate((f, auswahl) => {
    const rand = f.getBoundingClientRect();
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      ueberstehend: [...f.querySelectorAll<HTMLElement>(auswahl)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < rand.left - 1 || r.right > rand.right + 1 || e.scrollWidth > e.clientWidth + 1);
      }).map((e) => (e.textContent ?? '').trim().slice(0, 50)),
    };
  }, teile);
  expect(mass.seite, 'die Seite rollt nicht quer').toBeLessThanOrEqual(1);
  expect(mass.ueberstehend, 'nichts steht über oder ist abgeschnitten').toEqual([]);
}

test('ohne Unterstützung: der Sprung landet in der Ansicht des Mandanten', async ({ page }) => {
  const dialog = await oeffne(page, 'Solarhof Beispiel');
  // Dieser Mandant hat einen Standort: kein Hinweis im Kasten, beide Wege stehen da.
  await expect(dialog.getByRole('button', { name: 'Notfall-Zugriff', exact: true })).toBeVisible();
  await expect(dialog.getByRole('note')).toHaveCount(0);
  await passt(page, dialog, 'p, h3, button, .vp-alert');

  await dialog.getByRole('button', { name: 'Wie der Kunde es sieht' }).click();
  await expect(page.getByRole('heading', { name: 'Solarhof Dach' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBe('a1000000-0000-4000-8000-000000000001');
  // Die Anlagenseite selbst ändert dieser Sprung nicht (ihr Titel kürzt am Telefon mit Auslassung); hier zählt nur,
  // dass die Seite nicht quer rollt.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('Mandant ohne Standort: die Mandanten-Seite sagt, warum keine Unterstützung geht, und der Sprung öffnet sein Portfolio', async ({ page }) => {
  const dialog = await oeffne(page, 'Musterwerk Nord GmbH');
  const hinweis = dialog.getByRole('note');
  await expect(hinweis).toBeVisible();
  await expect(hinweis).toContainText('Dieser Mandant hat noch keinen Standort.');
  await expect(hinweis).toContainText('gelten immer für Standorte, nie für das ganze Unternehmen');
  await expect(hinweis).toContainText('„Wie der Kunde es sieht“ öffnet sie trotzdem');
  // Nichts wird versteckt: Anfrage, Notfall-Zugriff und Sprung bleiben, wie sie sind.
  await expect(dialog.getByRole('button', { name: 'Unterstützung anfragen' })).toBeEnabled();
  await passt(page, dialog, 'p, h3, button, .vp-alert');

  await dialog.getByRole('button', { name: 'Wie der Kunde es sieht' }).click();
  // Zwei Anlagen, kein Standort: dieselbe Landung wie für den Kunden selbst, das Portfolio.
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page).toHaveURL(/#\/portfolio$/);
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
});

test('ein gemerkter Mandant öffnet sich nach dem Neuladen wieder in seiner Ansicht', async ({ page }) => {
  // Der Umschalter merkt sich den Mandanten in der Sitzung; auch dieser Weg landet beim Mandanten.
  await page.goto('/e2e/mandantensprung.html?mandant=mit#/uebersicht');
  await expect(page.getByRole('heading', { name: 'Solarhof Dach' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
});

test('Not-Aus: bei abgeschaltetem Sprung endet er auf der Karte mit Grund und Weg', async ({ page }) => {
  await page.goto('/e2e/mandantensprung.html?schalter=aus&mandant=ohne#/uebersicht');
  const titel = page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' });
  await expect(titel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  const karte = page.locator('main .vp-card', { has: titel });
  await expect(karte).toContainText('Die Ansicht von Musterwerk Nord GmbH hat sich nicht geöffnet.');
  await expect(karte).toContainText('in dieser Umgebung abgeschaltet');
  await expect(karte).toContainText('„Unterstützung anfragen“ oder „Notfall-Zugriff“');
  await passt(page, karte, 'h1, p, button');

  // Der Weg zurück verlässt den Mandanten und zeigt wieder die Liste.
  await karte.getByRole('button', { name: 'Zu den Mandanten' }).click();
  await expect(page.getByRole('button', { name: 'Details zu Musterwerk Nord GmbH' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
});

/** Wörter im ersten Bildschirm (ohne zu scrollen) - dasselbe Zählmuster wie `erloese-minus.spec.ts`. */
async function woerterErsterBildschirm(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = window.innerHeight;
    let text = '';
    const lauf = (el: Element) => {
      for (const kind of Array.from(el.children)) {
        const r = (kind as HTMLElement).getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= h) continue;
        if (r.top >= 0 && r.bottom <= h && (kind as HTMLElement).children.length === 0) {
          text += ` ${kind.textContent ?? ''}`;
        } else {
          lauf(kind);
        }
      }
    };
    lauf(document.body);
    return text.split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w)).length;
  });
}

/**
 * Scheibe S5 (Prüfregel §8): Kundenliste und Kundenakte ohne waagrechten Überlauf bei 1440 und 390 px; die
 * Kundenakte hält am Telefon das Wort-Budget ihres ersten Bildschirms (≤ 60 Wörter).
 */
for (const breite of [1440, 390] as const) {
  test(`${breite} px: Kundenliste und Kundenakte rollen nicht quer`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
    await page.goto('/e2e/mandantensprung.html#/mandanten');
    const liste = page.locator('main');
    await expect(page.getByRole('button', { name: 'Details zu Solarhof Beispiel' })).toBeVisible();
    await passt(page, liste, 'table, button, h1, h2, td, th, .vp-badge, span');

    await page.getByRole('button', { name: 'Details zu Solarhof Beispiel' }).click();
    const akte = page.getByRole('region', { name: 'Solarhof Beispiel' });
    await expect(akte.getByRole('heading', { name: 'Unterstützung' })).toBeVisible();
    await passt(page, akte, 'table, button, h1, h2, td, th, .vp-badge, span, p');
  });
}

test('390 px: der erste Bildschirm der Kundenakte hält das Wort-Budget (≤ 60 Wörter)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/mandantensprung.html#/mandanten');
  await page.getByRole('button', { name: 'Details zu Solarhof Beispiel' }).click();
  await expect(page.getByRole('region', { name: 'Solarhof Beispiel' })).toBeVisible();
  const n = await woerterErsterBildschirm(page);
  test.info().annotations.push({ type: 'woerter', description: `kundenakte-telefon=${n}` });
  expect(n).toBeLessThanOrEqual(60);
});

/**
 * Auftrag vom 29.10.2026 („als Admin in der Mandantensicht alles können“): im Sprung bedient die Plattform-Administration,
 * was der Kundenadministrator bedient. Bis dahin lieferte `/me` ihr dort nur die Rechte einer VoltPilot-Unterstützung,
 * und die Karte „Wer bekommt Sonnenstrom zuerst?“ sagte „Dafür fehlt Ihnen das Recht.“ statt „Ändern“ (ebenso fünf
 * Stellen unter Laden und fünf unter Regeln). Wirt: `steuerung.html?sprung=1` - Plattform-Token, gemerkter Mandant und
 * `/me` aus dem Vertragsfall `sprung-*` (Kundenadministrator, unternehmensweit, Zugang „umschalter“).
 */
test('im Sprung bedient die Plattform die Karte „Wer bekommt Sonnenstrom zuerst?“ wie der Kundenadministrator', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T11:10:00Z'));
  const satz = page.getByText('Dafür fehlt Ihnen das Recht', { exact: false });
  await page.goto('/e2e/steuerung.html?sprung=1#/anlage/help-site/steuerung');
  const karte = page.getByRole('region', { name: 'Geräte und Reihenfolge' });
  await expect(karte.getByRole('heading', { name: 'Wer bekommt Sonnenstrom zuerst?' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBe('help-tenant');
  await expect(satz).toHaveCount(0);

  await karte.getByRole('button', { name: /Ändern/ }).click();
  await page.getByRole('button', { name: 'Poolpumpe nach oben' }).click();
  await expect(page.getByText(/Poolpumpe Platz 4 statt 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Reihenfolge speichern' }).click();
  // Scheibe S1: das Rückweg-Band "Wie der Kunde es sieht" trägt ebenfalls role="status" - der Toast ist gemeint.
  await expect(page.getByRole('status').filter({ hasText: 'Reihenfolge gespeichert' })).toContainText('Reihenfolge gespeichert');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  for (const reiter of ['laden', 'regeln']) {
    await page.goto(`/e2e/steuerung.html?sprung=1#/anlage/help-site/${reiter}`);
    await expect(page.getByRole('tablist', { name: 'Reiter der Steuerung' })).toBeVisible();
    await expect(satz, reiter).toHaveCount(0);
  }
});
