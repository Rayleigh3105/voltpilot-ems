import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// Nur Antworten ersetzen: dargestellt werden die echten bestehenden Portal-Komponenten.
for (const breite of [375, 1440]) {
  test(`${breite}: Leistungsschwelle bleibt an wirksamer Zahl und Fassungen sichtbar`, async ({ page }) => {
    // Kaltstart der echten Bühne darf auch unter paralleler Prüflast fertig laden.
    test.setTimeout(90_000);
    const fehler: string[] = [];
    page.on('pageerror', e => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 900 : 1000 });
    await page.clock.setFixedTime(new Date('2026-11-20T10:00:00Z'));
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bezugsgroessen');
    await expect(page.getByRole('heading', { name: 'Bezugsgrößen', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const modul = '/src/api.ts';
      const { api } = await import(modul);
      const liste = await api.bezugsgroessen();
      const b = liste.bezugsgroessen.find((x: { kennzeichen: string }) => x.kennzeichen === 'BZ-3');
      b.art = 'betriebszeit_aus_leistung'; b.name = 'Betriebszeit aus Leistung (Annahme)'; b.hat_werte = true;
      api.bezugsgroessen = async () => ({ bezugsgroessen: [b], bezugsflaechen: [] });
      const annahmen = ['aus Leistung über 5 kW (Annahme)', 'aus Leistung über 2 kW (Annahme)'];
      api.bezugsgroesseWerte = async () => ({ id: b.id, kennzeichen: b.kennzeichen, wertart: 'periodenwert', einheit: 'h', periode_art: 'monat', werte: [{
        periode_von: '2026-10-01', periode_bis: '2026-10-31', zeitpunkt: null, zeitzone: 'Europe/Berlin',
        wirksamer_betrag: '384', wirksame_fassung: 1, stand_offen: false, vorschlag: null,
        fassungen: [{ fassung: 1, betrag: '384', status: 'wirksam', kennzeichen: annahmen,
          eingetragen_am: '2026-11-01T00:01:00Z', herkunft: { art: 'messkanal' }, urheber: { name: 'Ableitung' },
          kanal: { kanal: 'Wirkleistung', regel: annahmen[0], zustand: 'vollständig', abdeckung_prozent: 100, vorlaeufig: false },
        }],
      }] });
      api.kanalbindungen = async () => [
        { id: 'fassung1', entity_id: 'maschine', kanal: 'Wirkleistung', wertart: 'gauge', von: '2026-10-01T00:00:00Z', bis: '2026-10-16T00:00:00Z', regel: annahmen[0], fassung: 1, begruendung: 'Annahme aus beobachtetem Maschinenbetrieb' },
        { id: 'fassung2', entity_id: 'maschine', kanal: 'Wirkleistung', wertart: 'gauge', von: '2026-10-16T00:00:00Z', bis: null, regel: annahmen[1], fassung: 2, begruendung: 'Standby erneut geprüft und Schwelle angepasst' },
      ];
    });
    await page.getByRole(breite === 375 ? 'button' : 'tab', { name: 'Kennzahlen', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Kennzahlen', exact: true })).toBeVisible();
    await page.getByRole(breite === 375 ? 'button' : 'tab', { name: 'Bezugsgrößen', exact: true }).first().click();
    const karte = page.getByTestId('bezugsgroesse-karte');
    await expect(karte).toHaveCount(1);
    await karte.getByText('Werte und Fassungen', { exact: true }).click();
    await expect(karte.getByText('384 h · Fassung 1', { exact: true })).toBeVisible();
    await expect(karte.getByRole('button', { name: 'Wert eingeben', exact: true })).toHaveCount(0);
    await expect(karte.getByText('aus Leistung über 5 kW (Annahme)', { exact: true }).first()).toBeVisible();
    await expect(karte.getByText('aus Leistung über 2 kW (Annahme)', { exact: true }).first()).toBeVisible();
    await karte.getByText('Messkanal', { exact: true }).click();
    await expect(karte.getByText('Fassung 2: Standby erneut geprüft und Schwelle angepasst')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
    if (process.env.BETRIEBSZEIT_BILDER) {
      mkdirSync(process.env.BETRIEBSZEIT_BILDER, { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(process.env.BETRIEBSZEIT_BILDER, `betriebszeit-${breite}.png`), fullPage: true });
    }
    await karte.getByText('Fassungen ansehen (1)', { exact: true }).click();
    await expect(karte.getByText('aus Leistung über 2 kW (Annahme)', { exact: true }).last()).toBeVisible();
  });
}
