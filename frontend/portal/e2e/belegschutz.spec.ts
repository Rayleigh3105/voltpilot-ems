import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Gefahrenzone mit Belegschutz (UEMS AP-12 IP-12, Referenzfall B12) bei 375 und 1440 px: die Komponente hinter
 * MS-12 entfernen → die Rückfrage schließt, die Gefahrenzone nennt den Satz mit den vier Ständen und den Weg zur
 * Messstelle. Kein Querlauf der Seite, der Rückfrage oder eines einzelnen Elements, keine Konsolenfehler — GEMESSEN,
 * nicht behauptet. Bühne `belegschutz.html`, die Cloud-Antwort steht in der Bühne.
 *
 * Mit `BELEGSCHUTZ_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild und `messung-<schritt>-<breite>.json` ab
 * (vorher · rueckfrage · beleg) — die Vorschau für die Freigabe.
 */

const BILDER = process.env.BELEGSCHUTZ_BILDER;
const BREITEN = [375, 1440] as const;
const NAME = 'Zähler Energiekarte EK-3 (Montage M1)';

async function messeUndFotografiere(page: Page, breite: number, schritt: string, fehler: string[]) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const m = await page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-gz *, .vp-modal *, .vp-bs-wrap *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody, .vp-bs-wrap')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
    };
  }, breite);
  expect(m.seite, `${schritt} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${schritt} ${breite}: Rückfrage`).toBe(0);
  expect(m.draussen, `${schritt} ${breite}: Elemente`).toEqual([]);
  expect(fehler, `${schritt} ${breite}: Konsolenfehler`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${schritt}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${schritt}-${breite}.png`), fullPage: true });
}

for (const breite of BREITEN) {
  test(`Belegschutz: die Komponente hinter MS-12 entfernen nennt Stände und Weg (${breite} px)`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    const fehler: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') fehler.push(msg.text());
    });
    await page.goto('/e2e/belegschutz.html');
    await expect(page.getByTestId('kein-zustand')).toHaveCount(0);
    // Seit main d1b97ac39 steht „Komponente entfernen …“ im Menü „⋯“ (Weitere Aktionen) des Geräte-Kopfs.
    const menue = page.getByRole('button', { name: 'Weitere Aktionen' });
    await expect(menue).toBeVisible();
    await messeUndFotografiere(page, breite, 'vorher', fehler);

    await menue.click();
    await page.getByRole('menuitem', { name: /Komponente entfernen/ }).click();
    const rueckfrage = page.getByRole('dialog');
    await expect(rueckfrage).toBeVisible();
    await rueckfrage.getByRole('textbox').fill(NAME);
    await messeUndFotografiere(page, breite, 'rueckfrage', fehler);
    await rueckfrage.getByRole('button', { name: /Endgültig entfernen/ }).click();

    const beleg = page.getByTestId('gz-berichts-belege');
    await expect(beleg).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(beleg).toContainText('Diese Komponente ist Beleg in 4 freigegebenen Berichtsständen (BR-2026-0001 Nr. 1, '
      + 'BR-2026-0001 Nr. 2, BR-2026-0002 Nr. 1, BR-2026-0004 Nr. 1). Löschen ist nicht möglich — beenden Sie die '
      + 'Bindung stattdessen.');
    await expect(beleg.getByRole('link', { name: 'Zur Messstelle MS-12 Montage Linie M1' })).toBeVisible();
    await expect(page.getByLabel('Entfernen nicht möglich').getByRole('button')).toHaveCount(0);
    await messeUndFotografiere(page, breite, 'beleg', fehler);
  });
}
