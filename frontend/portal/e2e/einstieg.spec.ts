import { expect, test, type Page } from '@playwright/test';

/**
 * Konzept „Energiemanagement ohne Fachsprache“ K2/K6/K8 auf der Bühne `startansicht` (Unternehmen Ahrenberg, `&rechte`
 * mit der Selbstauskunft der Person): oben auf der Übersicht steht, was die Rolle zuerst fragt — ohne neue Rechte.
 *
 * - Energiemanager (IK): der Fahrplan „Ihr Energiemanagement“ — sechs Schritte, je ein Satz und eine Handlung, keine
 *   Zahl über das Ganze (G4).
 * - Leser (CB) und „Einsicht“ (RF): „Belege finden“.
 * - Kundenadministrator (JW): am Rechner wie bisher; am Telefon steht die Datenlage zuerst (K8).
 */
const JETZT = new Date('2026-10-20T10:00:00+02:00');

async function oeffne(page: Page, person: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&rechte=1&person=${person}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const oben = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="uebersicht-oben"] > *')].map((e) => e.getAttribute('data-testid')));
const querlauf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const breite of [375, 1440]) {
  test(`K2 · Energiemanager bei ${breite} px: der Fahrplan steht oben — je Schritt ein Satz und eine Handlung, keine Zahl über das Ganze`, async ({ page }) => {
    const konsole: string[] = [];
    page.on('console', (m) => m.type() === 'error' && konsole.push(m.text()));
    await oeffne(page, 'IK', breite);
    const fahrplan = page.getByTestId('baustein-fahrplan');
    await expect(fahrplan.getByRole('heading', { level: 2 })).toHaveText('Ihr Energiemanagement');
    await expect(fahrplan.locator('.vp-fp-titel')).toHaveText([
      'Messen einrichten',
      'Energieeinsätze bewerten',
      'Kennzahlen mit Vergleichszeitraum',
      'Ziele und Maßnahmen',
      'Nachweise führen',
      'Jährlicher Rückblick',
    ]);
    await expect(page.getByTestId('fahrplan-messen-stand')).toHaveText('Gemessen wird an: Werk Ahrenberg, Werk Lindach.');
    await expect(page.getByTestId('fahrplan-bewerten-stand')).toHaveText('Der Umfang ist noch nicht festgelegt.');
    await expect(page.getByTestId('fahrplan-kennzahlen-stand')).toHaveText('5 Kennzahlen, noch ohne Bezugsbasis.');
    await expect(page.getByTestId('fahrplan-rueckblick-stand')).toHaveText('Noch keine Managementbewertung angelegt.');
    await expect(fahrplan).not.toContainText(/von\s+6|erledigt|vollständig|konform|Nicht abrufbar/);
    // Der Fahrplan steht vor den Kennzahlen der Anlagen; am Telefon folgt ihm die Datenlage (K8).
    expect(await oben(page)).toEqual(breite < 720 ? ['baustein-fahrplan', 'baustein-messstellen'] : ['baustein-fahrplan']);
    // Die Sätze stehen einmal auf der Seite, im Hinweis „Was VoltPilot leistet“ (K7).
    await expect(page.getByTestId('grenzhinweis')).toHaveCount(1);
    expect(await querlauf(page)).toBe(0);
    expect(konsole).toEqual([]);
    // Eine Handlung führt dorthin, wo der Schritt entsteht.
    await page.getByTestId('fahrplan-bewerten-handlung').click();
    await expect(page).toHaveURL(/#\/portfolio\/bewertung$/);
  });

  test(`K6 · Leser und „Einsicht“ bei ${breite} px: „Belege finden“ führt zu Berichten, Dokumenten und Managementbewertung`, async ({ page }) => {
    for (const person of ['CB', 'RF']) {
      await oeffne(page, person, breite);
      const belege = page.getByTestId('baustein-belege');
      await expect(belege.getByRole('heading', { level: 2 })).toHaveText('Belege finden');
      await expect(belege.locator('.vp-ub-name')).toHaveText(['Berichte', 'Dokumente', 'Managementbewertung']);
      await expect(page.getByTestId('baustein-fahrplan')).toHaveCount(0);
      expect(await querlauf(page)).toBe(0);
    }
    await page.getByTestId('belege-berichte').click();
    await expect(page).toHaveURL(/#\/portfolio\/berichte$/);
  });

  test(`K6/K8 · Kundenadministrator bei ${breite} px: am Rechner wie bisher, am Telefon die Datenlage zuerst`, async ({ page }) => {
    await oeffne(page, 'JW', breite);
    await expect(page.getByTestId('uebersicht-bausteine')).toBeVisible();
    if (breite < 720) {
      expect(await oben(page)).toEqual(['baustein-messstellen']);
      const vorTabelle = await page.evaluate(() => {
        const o = document.querySelector('[data-testid="uebersicht-oben"]');
        const t = document.querySelector('.vp-portfolio-anlagen');
        return !!o && !!t && Boolean(o.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(vorTabelle).toBe(true);
    } else {
      await expect(page.getByTestId('uebersicht-oben')).toHaveCount(0);
    }
    await expect(page.getByTestId('baustein-fahrplan')).toHaveCount(0);
    await expect(page.getByTestId('baustein-belege')).toHaveCount(0);
  });
}
