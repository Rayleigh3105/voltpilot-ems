import { expect, test } from '@playwright/test';

/**
 * **Der Vergleich eines laufenden Zeitraums** (Erlöse-Konzept
 * `data/vp-erloese-seite-konzept-e2` §3.7, Captain-Entscheid **E3 = (a)**,
 * Befund **B3**) — die Zusagen, die jsdom nicht messen kann.
 *
 * Der behobene Befund: um 12:19 stand über einem normalen Tag „53 % weniger",
 * weil ein halber Tag gegen einen vollen gerechnet wurde. Hier wird an den
 * ECHTEN Fixtures des Konzepts geprüft, dass genau diese Zahl nicht mehr
 * entsteht, dass der laufende Tag kein rotes Urteil bekommt — und dass bei
 * 375 px nichts über den Rand läuft.
 */
const PAGE = '/e2e/erloes-vergleich.html';

/** Der Chip einer Karte (Ebene 0) — Text + Wertungs-Klasse. */
async function chip(page: import('@playwright/test').Page, fall: string) {
  const el = page.locator(`[data-fall="${fall}"] .vp-delta`);
  if ((await el.count()) === 0) return null;
  return {
    text: (await el.innerText()).replace(/\s+/g, ' ').trim(),
    klasse: (await el.getAttribute('class')) ?? '',
  };
}

test('der laufende Tag vergleicht bis zur GLEICHEN Stunde — nie halb gegen ganz (L4)', async ({
  page,
}) => {
  await page.goto(PAGE);
  const karte = page.locator('[data-fall="dv-tag-laufend"]');
  await expect(karte).toBeVisible();

  // 63,23 € gegen den VOLLEN Vortag (135,22 €) wären 53 % weniger — genau die
  // Zahl des Screenshots. Sie darf auf dieser Karte nirgends mehr stehen.
  await expect(karte).not.toContainText('53 %');

  // Verglichen wird bis zur laufenden Berliner Stunde, und die Karte SAGT es.
  await expect(karte).toContainText('Bis 12 Uhr');
  await expect(karte).toContainText('heute 50,66 €');
  await expect(karte).toContainText('gestern 67,57 €');
  await expect(karte.locator('.vp-note-laufend')).toContainText('die laufende Stunde bleibt');

  const c = (await chip(page, 'dv-tag-laufend'))!;
  expect(c.text).toContain('25 % weniger');
  // Regel 3: am laufenden Tag wird NICHT gewertet — die Richtung ist eine
  // Tatsache, ein rotes Urteil über eine halbe Messung wäre eine Behauptung.
  expect(c.klasse).toContain('vp-delta-neutral');
  expect(c.klasse).not.toContain('vp-delta-schlecht');
});

test('ein abgeschlossener Zeitraum behält Wort UND Ton', async ({ page }) => {
  await page.goto(PAGE);
  const c = (await chip(page, 'dv-tag-abgeschlossen'))!;
  expect(c.text).toContain('13 % mehr als am Vortag');
  expect(c.klasse).toContain('vp-delta-gut');

  // Ein abgeschlossener Zeitraum ist die Zahl der Karte selbst — er trägt
  // keine „bis X Uhr"-Zeile und keinen Laufend-Satz.
  const karte = page.locator('[data-fall="dv-tag-abgeschlossen"]');
  await expect(karte.locator('.vp-erg-vergleich')).toHaveCount(0);
  await expect(karte.locator('.vp-note-laufend')).toHaveCount(0);
});

test('laufende Woche und laufendes Jahr zeigen NUR die zwei Beträge', async ({ page }) => {
  await page.goto(PAGE);

  for (const fall of ['eeg-woche', 'eeg-jahr']) {
    // Kein Prozent, wo die Grundlage verschieden lang ist (Regel 2).
    expect(await chip(page, fall)).toBeNull();
    const karte = page.locator(`[data-fall="${fall}"]`);
    await expect(karte).not.toContainText('%');
    await expect(karte.locator('.vp-erg-vergleich')).toContainText('bisher');
  }

  await expect(page.locator('[data-fall="eeg-woche"] .vp-erg-vergleich')).toContainText(
    'ganze Vorwoche',
  );
  await expect(page.locator('[data-fall="eeg-jahr"] .vp-erg-vergleich')).toContainText(
    'ganzes Jahr 2025',
  );
});

test('nichts läuft über den Rand — bei 375 und bei 1440', async ({ page }) => {
  const ueberlauf = () =>
    page.evaluate(() => {
      const doc = document.documentElement;
      const raus: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)) {
          raus.push(`${el.tagName}.${el.className}`);
        }
      }
      return { scrollX: doc.scrollWidth - doc.clientWidth, raus: raus.slice(0, 5) };
    });

  for (const breite of [375, 1440]) {
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto(PAGE);
    await expect(page.locator('[data-fall="eeg-jahr"] .vp-erg-vergleich')).toBeVisible();
    expect(await ueberlauf()).toEqual({ scrollX: 0, raus: [] });
  }
});
