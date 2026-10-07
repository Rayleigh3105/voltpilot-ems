import { expect as baseExpect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessstelleRegisterZeile, MessstellenRegister } from '../src/api';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ersten Zugriff kalt — großzügige Frist.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * Messen m2 · die Ablese-Runde je Gebäude (Konzept Messen m1, §6.5 Variante 3A) auf der Bühne `messstelle-seite.html`
 * (`?wirt=1`, die Adresse wählt wie `App.tsx`): am 02.11.2026, 07:30 MEZ - dem Szenario-Tag des Konzepts - vier Zähler in
 * Halle 1, zuletzt abgelesen am 01.10.2026. Gestellt: das Register (die Ablesezähler) und die Antwort von
 * `POST …/ablesungen` (Menge des Zeitraums, ein Rücksprung). Misst Querlauf am Dokument; mit `RUNDE_BILDER=<Ordner>` je
 * Schritt ein Bild.
 */

const BILDER = process.env.RUNDE_BILDER;
const ERSTER_OKTOBER = '2026-10-01T00:00:00+02:00';
const STAND: Record<string, number> = { 'MS-03': 1_204_500, 'MS-06': 647_760, 'MS-07': 523_560, 'MS-08': 747_120 };

function abgelesen(z: MessstelleRegisterZeile): MessstelleRegisterZeile {
  return {
    ...z,
    lebenszyklus: 'aktiv',
    quelle: { stand: 'ablesung', fuehrend: null, davor: null, vergleichsquellen: 0, ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: ERSTER_OKTOBER, faellig_ab: '2026-12-01T00:00:00+01:00' } },
    letzter_wert: { wert: STAND[z.kennzeichen], text: null, einheit: 'kWh', zeitpunkt: ERSTER_OKTOBER },
    beobachtung: z.beobachtung ? { ...z.beobachtung, zustand: 'liefert', text: 'Abgelesen am 01.10.2026', seit: null } : z.beobachtung,
  };
}

function register(): MessstellenRegister {
  const r = ahrenbergRegister();
  return { ...r, register: r.register.map((z) => (z.kennzeichen in STAND ? abgelesen(z) : z)) };
}

interface Gesendet {
  kz: string;
  body: { zeitpunkt: string; stand: string; zuordnung_monat: string | null };
}

async function cloud(page: Page): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const pfad = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/messstellen' && req.method() === 'GET') return json(register());
    const ablesung = /^\/api\/v1\/messstellen\/([^/]+)\/ablesungen$/.exec(pfad);
    if (ablesung && req.method() === 'POST') {
      const kz = decodeURIComponent(ablesung[1]);
      const body = req.postDataJSON() as Gesendet['body'];
      gesendet.push({ kz, body });
      const stand = Number(body.stand.replaceAll('.', '').replace(',', '.'));
      if (stand < STAND[kz]) {
        return json({ code: 'ruecksprung', message: 'Rücksprung — Zählerwechsel eintragen?' }, 422);
      }
      return json({
        urteil: 'eingetragen',
        korrektur: null,
        ablesung: { quelle: 'q', zeitpunkt: body.zeitpunkt, fassung: 1, stand, monat: `${body.zuordnung_monat}-01`, woher: 'eingabe', urheber: { name: 'Jonas Wendlinger', rolle: 'kundenadministrator' }, korrektur: null, eingetragen_am: body.zeitpunkt },
        ablesezeitraum: { menge: stand - STAND[kz], zustand: 'vollständig', kennzeichen: 'Ablesezeitraum 01.10. 00:00 – 02.11. 07:30' },
      });
    }
    return json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404);
  });
  return gesendet;
}

async function bild(page: Page, breite: number, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: true });
}

test('Halle 1 ablesen: ein Zeitpunkt, „Weiter“ speichert und springt, ein Rücksprung bleibt am Zähler, „Fertig“ führt zurück', async ({ page }, info) => {
  const breite = info.project.name.includes('mobile') ? 375 : 1440;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.clock.setFixedTime(new Date('2026-11-02T06:30:00Z'));
  const gesendet = await cloud(page);
  await page.goto('/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen?ablesen=G-1');

  const runde = page.getByTestId('ablese-runde');
  await expect(runde.getByRole('heading', { level: 1 })).toHaveText(/ ablesen$/);
  await expect(runde).toContainText('4 Zähler · Werk Ahrenberg · zuletzt abgelesen am 01.10.2026');
  await expect(runde).toContainText('Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.');
  await expect(page.getByTestId('ablese-runde-fortschritt')).toContainText('0 von 4 eingetragen');
  const reihe = (kz: string) => page.getByTestId('ablese-runde-reihe').filter({ hasText: kz });
  const feld = (kz: string) => reihe(kz).getByRole('textbox');
  await expect(feld('MS-03')).toHaveAttribute('data-entscheid', 'zaehlerablesung');
  await bild(page, breite, 'runde-leer');

  // Weiter: speichert und springt zum nächsten Feld.
  await feld('MS-03').fill('1.226.200');
  await feld('MS-03').press('Enter');
  await expect(reihe('MS-03')).toContainText('gespeichert · 21.700');
  await expect(feld('MS-06')).toBeFocused();
  expect(gesendet[0]).toEqual({ kz: 'MS-03', body: { zeitpunkt: '2026-11-02T07:30:00+01:00', stand: '1.226.200', zuordnung_monat: '2026-10' } });

  // Ein Rücksprung: der Satz des Servers bleibt am Zähler, die Runde läuft weiter.
  await feld('MS-06').fill('600.000');
  await feld('MS-06').press('Enter');
  await expect(reihe('MS-06').getByRole('alert')).toHaveText('Rücksprung — Zählerwechsel eintragen?');
  await expect(feld('MS-06')).toBeFocused();
  await feld('MS-07').fill('540.640');
  await expect(page.getByTestId('ablese-runde-fortschritt')).toContainText('1 von 4 eingetragen');
  await bild(page, breite, 'runde-mitten');

  // Fertig: speichert die eingetragene Reihe; die zurückgewiesene bleibt mit ihrem Satz - die Runde bleibt offen.
  await page.getByRole('button', { name: 'Fertig' }).click();
  await expect(reihe('MS-07')).toContainText('gespeichert · 17.080');
  await expect(runde).toBeVisible();
  // Berichtigt und noch einmal Fertig: jetzt führt die Runde zurück in die Liste.
  await feld('MS-06').fill('662.180');
  await page.getByRole('button', { name: 'Fertig' }).click();
  await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
  await expect(page.getByTestId('messstellen')).toBeVisible();
  expect(gesendet.map((g) => g.kz)).toEqual(['MS-03', 'MS-06', 'MS-07', 'MS-06']);
});
