import { expect, test, type Page } from '@playwright/test';

/**
 * Wächter für die kleinen UI-Pannen aus dem Privatkunden-Durchgang (04.11.2026): Seitenleisten-Sprung, Farbe der
 * Geld-Kachel, Wortbruch in „Rollen & Zuordnung", abgeschnittener Wert neben dem Menü, doppelte Adresse.
 * Sie laufen auf der Hilfe-Bühne (`help.html`, fiktive Daten, kein Server).
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'misst selbst mehrere Breiten');
});

const HILFE = '/e2e/help.html';

/** Zeichnet bei jedem Bild die Oberkante des Eintrags „Verlauf" (Seitenleiste ODER Telefon-Leiste) auf. */
async function verlaufSpur(page: Page, selektor: string) {
  await page.addInitScript((sel) => {
    const spur: number[] = [];
    (window as unknown as { __spur: number[] }).__spur = spur;
    const tick = () => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent?.trim().startsWith('Verlauf'));
      if (el) spur.push(Math.round(el.getBoundingClientRect()[sel.includes('bottombar') ? 'left' : 'top'] * 10) / 10);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selektor);
}

test('die Seitenleiste springt nicht, wenn „Fahrplan" mit der Oberfläche der Anlage eintrifft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await verlaufSpur(page, '.vp-sidebar .vp-navitem');
  await page.goto(`${HILFE}?state=single#/anlage/help-site`);
  await expect(page.locator('.vp-sidebar .vp-navitem', { hasText: 'Fahrplan' })).toBeVisible();
  await page.waitForTimeout(400);
  const spur = await page.evaluate(() => (window as unknown as { __spur: number[] }).__spur);
  expect(spur.length).toBeGreaterThan(3);
  // Von der ersten bis zur letzten Beobachtung steht „Verlauf" an derselben Stelle.
  expect(new Set(spur).size, `Oberkanten von „Verlauf": ${[...new Set(spur)].join(', ')}`).toBe(1);
  await expect(page.locator('[data-bereich-platz]')).toHaveCount(0);
});

test('die Telefon-Leiste rückt nicht nach, wenn „Fahrplan" eintrifft', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await verlaufSpur(page, '.vp-bottombar .vp-bottombar-item');
  await page.goto(`${HILFE}?state=single#/anlage/help-site`);
  await expect(page.locator('.vp-bottombar .vp-bottombar-item', { hasText: 'Fahrplan' })).toBeVisible();
  await page.waitForTimeout(400);
  const spur = await page.evaluate(() => (window as unknown as { __spur: number[] }).__spur);
  expect(spur.length).toBeGreaterThan(3);
  expect(new Set(spur).size, `linke Kanten von „Verlauf": ${[...new Set(spur)].join(', ')}`).toBe(1);
});

test('die Geld-Kachel färbt nach Vorzeichen: Gewinn grün, Verlust in der Warnfarbe, nie umgekehrt', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Die Bühne trägt Daten vom 10.09.2026 - die Uhr der Seite steht auf deren „jetzt".
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  const farbe = async (fall: 'plus' | 'minus') => {
    await page.goto(`${HILFE}?geld=${fall}#/anlage/help-site/fahrplan`);
    await page.reload();
    const wert = page.locator('.vp-antw-wert.is-geld').first();
    await expect(wert).toBeVisible();
    await expect(wert).toContainText(fall === 'minus' ? '−' : '+');
    await expect(wert).toHaveClass(fall === 'minus' ? /is-minus/ : /is-plus/);
    return wert.evaluate((el) => getComputedStyle(el).color);
  };
  const gruen = await farbe('plus');
  const warn = await farbe('minus');
  expect(warn).not.toBe(gruen);
  // Ohne Vorzeichen (Totband) bleibt die Zahl neutral: dieselbe Farbe wie ein gewöhnlicher Wert, kein Gewinn-Grün.
  const neutral = await page.locator('.vp-antw-wert.is-geld').first().evaluate((el) => {
    el.classList.remove('is-plus', 'is-minus');
    return [getComputedStyle(el).color, getComputedStyle(document.body).color];
  });
  expect(neutral[0]).not.toBe(gruen);
  expect(neutral[0]).not.toBe(warn);
});

test('„Netzanschlusszähler" bricht in „Rollen & Zuordnung" nicht mitten im Wort', async ({ page }) => {
  for (const width of [1180, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HILFE}?state=single&technik=1&lang=1#/anlage/help-site/modell`);
    const name = page.locator('.vp-role-member-name', { hasText: 'Netzanschlusszähler' }).first();
    await expect(name).toBeVisible();
    const zeilen = await name.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el.firstChild!);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    });
    expect(zeilen, `@ ${width}: das Wort steht in einer Zeile`).toBe(1);
  }
});

test('der Wert in der Gerätetabelle bleibt ganz und liegt nie unter dem Menü', async ({ page }) => {
  for (const width of [1180, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HILFE}?state=single&technik=1&lang=1#/anlage/help-site/modell`);
    await expect(page.getByText('frei', { exact: true })).toBeVisible();
    const zeilen = await page.locator('.vp-auf-t-zeile.is-geraet').evaluateAll((els) =>
      els.map((z) => {
        const wert = z.querySelector('.vp-auf-t-wert')!.getBoundingClientRect();
        const mehr = z.querySelector('.vp-auf-t-mehr')?.getBoundingClientRect();
        const w = z.querySelector('.vp-auf-t-wert') as HTMLElement;
        return { text: w.textContent, ganz: w.scrollWidth <= w.clientWidth + 1, frei: !mehr || wert.right <= mehr.left + 0.5 };
      }),
    );
    expect(zeilen.length).toBeGreaterThan(0);
    for (const z of zeilen) {
      expect(z.ganz, `@ ${width}: „${z.text}" ist abgeschnitten`).toBe(true);
      expect(z.frei, `@ ${width}: „${z.text}" liegt unter dem Menü`).toBe(true);
    }
  }
});

test('die Standortzeile nennt die Adresse nicht noch einmal, wenn der Name sie schon ist', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${HILFE}?state=single&lang=1#/anlage/help-site/modell`);
  const zeile = page.locator('.vp-auf-ort');
  await expect(zeile).toContainText('Sandgrabener Str. 10A');
  const text = (await zeile.textContent())!;
  expect(text.split('Sandgrabener Str. 10A').length - 1).toBe(1);
  await expect(zeile).toContainText('86989 Steingaden');
});

test('die Knopfreihe über der Gerätetabelle überlagert die Zählzeile nie', async ({ page }) => {
  for (const width of [375, 768, 1180, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HILFE}?state=single&technik=1#/anlage/help-site/modell`);
    const technik = page.locator('.vp-auf-technik-add');
    await expect(technik).toBeVisible();
    const kasten = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const zahl = await kasten('.vp-auf-zahlen');
    const t = (await technik.boundingBox())!;
    const neu = await kasten('.vp-auf-neu');
    const schneidet = (a: typeof t, b: typeof t) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(schneidet(zahl, t), `@ ${width}: Technik-Knopf auf der Zählzeile`).toBe(false);
    expect(schneidet(neu, t), `@ ${width}: Technik-Knopf auf „Gerät hinzufügen"`).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('die Fehlerkarte „Daten konnten nicht geladen werden" setzt Titel eng und Text ruhig', async ({ page }) => {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(`${HILFE}?state=error#/`);
    const titel = page.locator('.vp-empty h3', { hasText: 'Daten konnten nicht geladen werden' });
    await expect(titel).toBeVisible();
    const mass = await page.evaluate(() => {
      const zeile = (el: Element) => {
        const c = getComputedStyle(el);
        return parseFloat(c.lineHeight) / parseFloat(c.fontSize);
      };
      const h3 = document.querySelector('.vp-empty h3') as Element;
      const p = document.querySelector('.vp-empty p') as Element;
      return { titel: zeile(h3), text: zeile(p) };
    });
    // Körpertext liegt bei 1,6: ein Titel in dieser Höhe läuft über zwei Zeilen 32 px auseinander.
    expect(mass.titel, `Titel bei ${width} px`).toBeLessThanOrEqual(1.4);
    expect(mass.text, `Text bei ${width} px`).toBeLessThanOrEqual(1.5);
  }
});

test('der Link „Erneut laden" in der Fehlerzeile der Wallbox dehnt seine Zeile nicht auf 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${HILFE}?state=single#/anlage/help-site/geraet/VP-DEMO-0001/cp-CP-CARPORT`);
  const meldung = page.locator('.vp-alert', { hasText: 'OCPP-Gerätedaten konnten nicht geladen werden' });
  await expect(meldung).toBeVisible();
  const mass = await meldung.evaluate((el) => {
    const c = getComputedStyle(el);
    const zeile = parseFloat(c.lineHeight);
    const polster = parseFloat(c.paddingTop) + parseFloat(c.paddingBottom);
    return { zeilen: Math.round((el.getBoundingClientRect().height - polster) / zeile * 10) / 10, zeile };
  });
  // Zwei Textzeilen (der Link steht in der zweiten), nicht zwei plus eine 44-px-Knopfzeile.
  expect(mass.zeilen).toBeLessThanOrEqual(2.1);
  // Die Treffläche des Links bleibt trotzdem fingergroß.
  const link = await meldung.getByRole('button', { name: 'Erneut laden' }).boundingBox();
  expect(link?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('Dialoge am Telefon: Blatt von unten in Inhaltshöhe, Hauptknopf über „Abbrechen"; am Rechner unverändert', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${HILFE}?state=single#/anlage/help-site/modell?neu=box`);
  const dialog = page.getByRole('dialog', { name: 'VoltPilot-Box hinzufügen' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500); // die Einblendung (translateY) ist durch
  const m = await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const body = el.querySelector('.dbody')!;
    const inhaltEnde = Math.max(...[...body.children].map((c) => c.getBoundingClientRect().bottom));
    const knoepfe = [...el.querySelectorAll('.dfoot button')].map((b) => ({ text: b.textContent!.trim(), top: b.getBoundingClientRect().top }));
    return { top: box.top, bottom: box.bottom, vh: innerHeight, luecke: el.querySelector('.dfoot')!.getBoundingClientRect().top - inhaltEnde, knoepfe };
  });
  // In Inhaltshöhe, am unteren Rand verankert - kein bildschirmhohes Blatt mit leerem Feld vor dem Fuß.
  expect(m.top, 'Blatt füllt den Bildschirm').toBeGreaterThan(48);
  expect(Math.abs(m.bottom - m.vh)).toBeLessThanOrEqual(1);
  expect(m.luecke, 'toter Raum zwischen Formular und Fußknöpfen').toBeLessThanOrEqual(40);
  const haupt = m.knoepfe.find((k) => k.text === 'VoltPilot-Box hinzufügen')!;
  const abbrechen = m.knoepfe.find((k) => k.text === 'Abbrechen')!;
  expect(haupt.top, 'Hauptknopf steht über „Abbrechen"').toBeLessThan(abbrechen.top);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
  const rechner = await dialog.evaluate((el) => {
    const k = [...el.querySelectorAll('.dfoot button')].map((b) => ({ text: b.textContent!.trim(), left: b.getBoundingClientRect().left }));
    return { zentriert: Math.abs(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2 - innerWidth / 2) <= 2, k };
  });
  expect(rechner.zentriert).toBe(true);
  expect(rechner.k.find((x) => x.text === 'Abbrechen')!.left).toBeLessThan(rechner.k.find((x) => x.text !== 'Abbrechen')!.left);
});
