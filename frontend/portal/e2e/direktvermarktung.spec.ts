import { expect, test, type Page } from '@playwright/test';
import type { DirektvermarktungStandDaten, DirektvermarktungStatus, DirektvermarktungZustand } from '../src/direktvermarktung';

/**
 * Direktvermarktung (Konzept vp-direktvermarktung-konzept d2, Stufe 3 ohne Zustellung): die Bühne beweist
 * PS-D18 ("Kommt ein Kunde allein durch?") bei 375 px und bei 1440 px - die echte Seite im Inhaltsrahmen der
 * Schale, gegen per `page.route` verdrahtete Routen (Muster `anlage-technik-solaranlage.spec.ts`).
 *
 * Live durchlaufen wird, was diese Stufe tatsächlich steuert: „Nicht verbunden" bis „Zustimmen" (wartet dann
 * auf die Zugangsdatei - ein eigener, sicherheitskritischer Auftrag). Die Lagen DANACH (verbunden, begrenzt,
 * endet) kommen erst mit der echten Box-Zustellung zustande und werden hier deshalb über gesäte GET-Antworten
 * geprüft, nicht über einen durchgespielten Klick-Fluss, der eine Zustellung vortäuschen würde, die dieser
 * Auftrag nicht baut.
 */

const SITE_ID = '00000000-0000-0000-0000-00000000a001';
const BREITEN = [375, 1440] as const;

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const KATALOG = [{ partner: 'luox', name: 'luox energy', vertragLink: 'https://example.invalid/erloes' }];

function leer(): DirektvermarktungStatus {
  return {
    aktuell: null, geplant: null, partner: null, geplanterPartner: null, stand: null, verlaufKurz: [],
    katalog: KATALOG, darf: true,
  };
}

/** Relative zur wirklichen Uhr des Testlaufs - feste Zeitstempel wären flaky, sobald der Lauf später läuft. */
function vorSekunden(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

function mitEintrag(zustand: DirektvermarktungZustand, ende: string | null = null,
    stand: Partial<DirektvermarktungStandDaten> | null = null): DirektvermarktungStatus {
  // Physikalisch widerspruchsfrei (Firstmate-Hinweis, Board-Runde pr2000-bilder): die Einspeisung folgt der
  // Vorgabe - bei 0 % geht nichts mehr ins Netz, die Erzeugung bleibt (Speicher/Eigenverbrauch nehmen sie auf;
  // dieser Zwilling kennt nur die zwei Pfade Haus/Netz, siehe wohinDerStromGeht()).
  const vorgabePct = stand?.vorgabePct ?? 100;
  const erzeugungW = stand?.erzeugungW ?? 14100;
  const einspeisungW = stand?.einspeisungW ?? Math.round(erzeugungW * (vorgabePct / 100));
  return {
    aktuell: {
      id: 'e-1', partner: 'luox', zustand, zustimmungAm: vorSekunden(500000), zustimmungVon: 'kunde',
      startdatum: vorSekunden(400000), ende, revision: 1,
    },
    geplant: null, partner: { partner: 'luox', name: 'luox energy', vertragLink: null }, geplanterPartner: null,
    stand: stand === null ? null : {
      tunnelObenSeit: vorSekunden(300), handshakeAm: vorSekunden(10), gegenstelle: '10.44.0.1',
      letzteAbfrageAm: vorSekunden(12), abfragenJeMinute: 4, letzteSchreibungAm: vorSekunden(240),
      lebenszeichenAm: vorSekunden(12), netzbetreiberPct: 100, referenzW: 85000,
      ...stand, vorgabePct, erzeugungW, einspeisungW,
    },
    verlaufKurz: [], katalog: KATALOG, darf: true,
  };
}

/** Der Auffänger steht VOR den spezifischen Routen - Playwright prüft zuletzt registrierte zuerst. */
async function grundrauschen(page: Page) {
  await page.route('**/api/v1/**', (r) => r.fulfill(json({})));
}

async function keinUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth
      <= document.documentElement.clientWidth + 1)).toBe(true);
}

test.describe('Direktvermarktung: der Kunde kommt allein durch (PS-D18)', () => {
  for (const breite of BREITEN) {
    test(`Nicht verbunden -> wählen -> zustimmen -> Zugangsdatei hochladen, ${breite}px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: breite < 500 ? 844 : 960 });
      await grundrauschen(page);
      let stand: DirektvermarktungStatus = leer();
      await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung`, (r) => {
        if (r.request().method() === 'GET') return r.fulfill(json(stand));
        return r.continue();
      });
      await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung/waehlen`, (r) => {
        stand = mitEintrag('entwurf');
        stand.aktuell!.zustimmungAm = null;
        return r.fulfill(json(stand));
      });
      await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung/zustimmen`, (r) => {
        stand = mitEintrag('wartet_auf_zugang');
        return r.fulfill(json(stand));
      });
      await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung/zugang`, (r) => {
        stand = mitEintrag('verbindet', null, null);
        return r.fulfill(json({ name: 'ABC_1234567', gueltigBis: '2027-11-26T00:00:00Z', fingerabdruck: 'ab:cd:ef' }));
      });

      await page.goto('/e2e/direktvermarktung.html');
      await expect(page.getByRole('heading', { name: 'Direktvermarktung' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Direktvermarkter wählen' })).toBeVisible();
      await page.getByRole('button', { name: 'Direktvermarkter wählen' }).click();

      // Blatt: Partner wählen.
      await expect(page.getByText('Wer vermarktet Ihren Strom?')).toBeVisible();
      await page.getByText('luox energy', { exact: true }).click();
      await page.getByRole('button', { name: /Weiter mit/ }).click();

      // Blatt: Vertragsfrage - der Partnerlink steht sichtbar im Weg (Captain-Wunsch).
      await expect(page.getByRole('heading', { name: /Haben Sie schon einen Vertrag/ })).toBeVisible();
      await expect(page.getByRole('link', { name: /Erlös bei luox energy berechnen/ })).toBeVisible();
      await page.getByRole('button', { name: 'Ja, Vertrag ist da' }).click();

      // Blatt: Zustimmen.
      await expect(page.getByText('Sehen, was Ihre Anlage einspeist')).toBeVisible();
      await expect(page.getByText('BLEIBT IMMER SO')).toBeVisible();
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Zustimmen' }).click();

      // Zurück auf der Seite: die Zugangsdatei fehlt noch (§5.7).
      await expect(page.getByRole('heading', { name: 'Zugangsdatei hochladen' })).toBeVisible();
      await expect(page.getByText(/hat sie per E-Mail geschickt/)).toBeVisible();
      await keinUeberlauf(page);

      // Datei wählen, Passwort eintragen, hochladen - derselbe Flug ohne Box-Herzschlag, deshalb
      // "Stand unbekannt" danach (kein erfundenes "verbunden" ohne ein erstes Lebenszeichen).
      await page.getByLabel('Zugangsdatei (.zip)').setInputFiles({
        name: 'ABC_1234567.zip', mimeType: 'application/zip', buffer: Buffer.from('fiktiver-zip-inhalt'),
      });
      await page.getByLabel('Passwort').fill('geheim123');
      await page.getByRole('button', { name: /Datei hochladen/ }).click();
      await expect(page.getByText('Stand unbekannt')).toBeVisible();
      await keinUeberlauf(page);
    });
  }
});

test.describe('Direktvermarktung: Lagen im Alltag (Konzept §7.6), gesät', () => {
  const FAELLE: { titel: string; status: () => DirektvermarktungStatus; erwartet: RegExp }[] = [
    { titel: 'verbunden und frei', status: () => mitEintrag('verbunden', null, {}), erwartet: /Verbunden mit luox energy/ },
    {
      titel: 'luox begrenzt (Bernstein, kein Fehler)',
      status: () => mitEintrag('verbunden', null, { vorgabePct: 0 }),
      erwartet: /begrenzt auf 0 %/,
    },
    { titel: 'endet zum Stichtag', status: () => mitEintrag('endet', '2026-11-30'), erwartet: /Endet am 30\.11\.2026/ },
  ];

  for (const fall of FAELLE) {
    for (const breite of BREITEN) {
      test(`${fall.titel}, ${breite}px`, async ({ page }) => {
        await page.setViewportSize({ width: breite, height: breite < 500 ? 844 : 960 });
        await grundrauschen(page);
        await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung`, (r) => r.fulfill(json(fall.status())));
        await page.goto('/e2e/direktvermarktung.html');
        await expect(page.getByText(fall.erwartet)).toBeVisible();
        await keinUeberlauf(page);
      });
    }
  }
});

/**
 * EZ-8-Abgleich (kein Datenbezug, keine Sperre): der Wählen-Schritt nennt ruhig den
 * Namen eines älteren, hardwaregestützten Direktvermarkter-Felds der Anlagensteuerung, wenn die Anlage
 * eines trägt (`GET .../netz-vermarktung`) - blockiert nichts, das Feld selbst bleibt unverändert.
 */
test.describe('Direktvermarktung: EZ-8-Abgleich im Wählen-Schritt', () => {
  for (const breite of BREITEN) {
    test(`nennt den älteren Direktvermarkter, blockiert nichts, ${breite}px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: breite < 500 ? 844 : 960 });
      await grundrauschen(page);
      await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung`, (r) => r.fulfill(json(leer())));
      await page.route(`**/api/v1/sites/${SITE_ID}/netz-vermarktung`, (r) => r.fulfill(json({
        site_id: SITE_ID, netzbetreiber: 'Stadtwerke Nord', direktvermarkter: 'Stadtwerke Nord',
        direktvermarkter_kanal: 'relais_ma', einspeisemanagement: null, einspeisemanagement_prozent: null,
        namen_aus_bild: null, hinweise: [], revision: 1,
      })));
      await page.goto('/e2e/direktvermarktung.html');
      await page.getByRole('button', { name: 'Direktvermarkter wählen' }).click();
      await expect(page.getByText('Wer vermarktet Ihren Strom?')).toBeVisible();
      await expect(page.getByText(/bereits einen Direktvermarkter \(Stadtwerke Nord\)/)).toBeVisible();
      // Ruhig heißt: der Weg bleibt frei, nichts sperrt den Wechsel.
      await expect(page.getByRole('button', { name: /Weiter mit/ })).toBeEnabled();
      await keinUeberlauf(page);
    });
  }

  test('ohne ein solches Feld steht im Wählen-Schritt keine Zeile dazu', async ({ page }) => {
    await grundrauschen(page);
    await page.route(`**/api/v1/sites/${SITE_ID}/direktvermarktung`, (r) => r.fulfill(json(leer())));
    await page.route(`**/api/v1/sites/${SITE_ID}/netz-vermarktung`, (r) => r.fulfill(json({
      site_id: SITE_ID, netzbetreiber: null, direktvermarkter: null, direktvermarkter_kanal: 'keiner',
      einspeisemanagement: null, einspeisemanagement_prozent: null, namen_aus_bild: null, hinweise: [], revision: 1,
    })));
    await page.goto('/e2e/direktvermarktung.html');
    await page.getByRole('button', { name: 'Direktvermarkter wählen' }).click();
    await expect(page.getByText('Wer vermarktet Ihren Strom?')).toBeVisible();
    await expect(page.getByText(/bereits einen Direktvermarkter/)).toHaveCount(0);
  });
});
