import { expect, test, type Page } from '@playwright/test';
import type { RegisterEinheit, SiteAsset } from '../src/api';

/**
 * S3 (vp-mastr-mehrere-einheiten-konzept, E1=B Sonnenrose): die neue Gruppe
 * "Solaranlage" bei 375 und 1440 px - kein Querlauf der Seite oder eines
 * einzelnen Elements, GEMESSEN am Dokument. Bühne ist `anlage-technik.html`
 * (die echte Seite im Inhaltsrahmen der Schale); die Cloud ist per
 * `page.route` verdrahtet.
 */

const BREITEN = [375, 1440] as const;
const SITE_ID = '00000000-0000-0000-0000-00000000a001';

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

function einheit(over: Partial<RegisterEinheit> = {}): RegisterEinheit {
  return {
    id: 'e-1',
    art: 'pv',
    registry: 'mastr',
    registryUnitId: 'SEE123456789012',
    bezeichnung: null,
    inbetriebnahme: '2014-06-01',
    leistungKwp: 8.4,
    speicherKwh: null,
    speicherKw: null,
    bestaetigtAm: '2026-11-12T10:00:00Z',
    registryFetchedAt: null,
    abweichungVonRegister: false,
    flaechen: [{ richtungGrad: 180, neigungGrad: 30, anteilKwp: 8.4, module: 20, quelle: 'register' }],
    ...over,
  };
}

const PV_ASSET: SiteAsset = {
  id: 'a-pv',
  type: 'pv',
  deviceId: null,
  capacityKwh: null,
  maxChargeKw: null,
  maxDischargeKw: null,
  roundtripEfficiencyPct: null,
  speicherschonung: null,
  pvCapacityKwp: 14.7,
  moduleCount: 35,
  azimuthDeg: 180,
  tiltDeg: 30,
  commissionedOn: '2014-06-01',
  registry: 'mastr',
  registryUnitId: 'SEE123456789012',
  registryFetchedAt: null,
};

async function verdrahte(page: Page, einheiten: RegisterEinheit[]) {
  // Playwright prüft ZULETZT registrierte Routen ZUERST - der Auffänger muss
  // also vor den spezifischen Routen stehen, sonst gewinnt er immer.
  await page.route('**/api/v1/**', (r) => r.fulfill(json({})));
  // Die Karte "Gemeinsame Steuerung" (unverändert von dieser Scheibe) braucht
  // eine echte Liste, kein leeres Objekt.
  await page.route('**/api/v1/funktionen', (r) => r.fulfill(json({ standorte: [] })));
  await page.route('**/api/v1/sites/*/anlagensteuerungen', (r) => r.fulfill(json({ steuerungen: [] })));
  await page.route('**/api/v1/sites/*/register-einheiten', (r) => r.fulfill(json(einheiten)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([PV_ASSET])));
  await page.route('**/api/v1/sites/*/einspeiseverguetung', (r) =>
    r.fulfill(json({ zustand: 'ohne_angabe', wirksamCtKwh: null, angegebenCtKwh: null, inbetriebnahmeAbSolarspitzengesetz: null, hergeleitetCtKwh: null, hergeleitetGenaehert: false, inbetriebnahme: null, leistungKwp: null, eegEndeAm: null, ohneVerguetungBeiNegativpreis: false, anzulegenderWertCtKwh: null })),
  );
}

test.describe('Solaranlage-Gruppe (S3, E1=B)', () => {
  for (const breite of BREITEN) {
    test(`zeigt die Sonnenrose bei zwei Einheiten ohne Querlauf (${breite}px)`, async ({ page }) => {
      await verdrahte(page, [
        einheit({ id: 'e-alt', registryUnitId: 'SEE111111111111', leistungKwp: 8.4, inbetriebnahme: '2014-06-01' }),
        einheit({
          id: 'e-neu',
          registryUnitId: 'SEE222222222222',
          leistungKwp: 6.3,
          inbetriebnahme: '2024-06-01',
          flaechen: [{ richtungGrad: 90, neigungGrad: 12.5, anteilKwp: 6.3, module: 15, quelle: 'register' }],
        }),
      ]);
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`/e2e/anlage-technik.html?anlage=${SITE_ID}`);

      const rose = page.locator('.vp-sonnenrose');
      await expect(rose).toBeVisible();
      await expect(page.getByText('14,7').first()).toBeVisible();

      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });

      // Kein Querlauf des Dokuments.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      // Die Sonnenrose selbst bleibt innerhalb ihrer Karte.
      const roseBox = await rose.boundingBox();
      const groupBox = await page.locator('section#technik-registrierung').boundingBox();
      expect(roseBox).not.toBeNull();
      expect(groupBox).not.toBeNull();
      if (roseBox && groupBox) {
        expect(roseBox.x).toBeGreaterThanOrEqual(groupBox.x - 1);
        expect(roseBox.x + roseBox.width).toBeLessThanOrEqual(groupBox.x + groupBox.width + 1);
      }
      expect(consoleErrors).toEqual([]);
    });

    test(`zeigt eine Vorschlags-Einheit als Hinweis ohne Querlauf (${breite}px)`, async ({ page }) => {
      await verdrahte(page, [
        einheit(),
        einheit({ id: 'e-vorschlag', registryUnitId: 'SEE333333333333', bestaetigtAm: null, flaechen: [] }),
      ]);
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`/e2e/anlage-technik.html?anlage=${SITE_ID}`);

      await expect(page.getByText(/weitere Einheit an Ihrem Anschluss gefunden/)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test(`"Anlage verknüpfen" (Lokations-Suche) ohne Querlauf, Richtung-Schritt inklusive (${breite}px)`, async ({ page }) => {
      await verdrahte(page, []);
      await page.route('**/api/v1/sites/*/mastr-lokation-lookup', (r) =>
        r.fulfill(
          json({
            lokationMastrNummer: 'SEL926735321862',
            einheiten: [
              {
                vorschau: {
                  mastrNummer: 'SEE111111111111',
                  kind: 'pv',
                  name: null,
                  status: 'In Betrieb',
                  plantType: 'Gebäudesolaranlage',
                  powerKw: 8.4,
                  inverterPowerKw: null,
                  moduleCount: 20,
                  azimuthLabel: 'Ost-West',
                  azimuthDeg: null,
                  tiltLabel: null,
                  tiltDeg: null,
                  commissionedOn: '2014-06-01',
                  storageCapacityKwh: null,
                  chargePowerKw: null,
                  batteryTechnology: null,
                  plz: '89150',
                  ort: 'Laichingen',
                  linkedUnitNumber: null,
                  warnings: ['Die Ausrichtung „Ost-West“ lässt sich nicht auf eine einzelne Himmelsrichtung abbilden.'],
                },
                vorausgewaehlt: true,
                grund: null,
              },
            ],
          }),
        ),
      );
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`/e2e/anlage-technik.html?anlage=${SITE_ID}`);

      await page.getByRole('button', { name: /Registrierung|Einheiten verwalten/ }).click();
      await page.getByRole('button', { name: /Neu aus dem Register abrufen|Weitere Einheit verknüpfen/ }).click();
      await page.getByLabel('MaStR-Nummer Ihrer Anlage').fill('SEE111111111111');
      await page.getByRole('button', { name: 'Im Register nachschlagen' }).click();
      await expect(page.getByText(/Im Register gefunden/)).toBeVisible();
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      await page.getByRole('button', { name: 'Weiter' }).click();
      await expect(page.getByText(/kennt das Register keine feste Himmelsrichtung/)).toBeVisible();
      overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
