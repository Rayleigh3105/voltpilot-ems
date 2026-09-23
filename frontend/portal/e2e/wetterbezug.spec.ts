import { test, expect } from '@playwright/test';

// AP-17 IP-12c: Abschnitt „Wetter“ an der Gradtagzahl auf der echten Bezugsgrößen-Seite. Nur Antworten ersetzen:
// dargestellt werden die echten Portal-Komponenten (Muster betriebszeit-kennzeichen.spec.ts).
const LINDACH = 'Für den Standort Lindach kann VoltPilot kein Wetter beziehen: die Koordinaten fehlen. Eine Wetterbereinigung über Gradtage ist hier erst möglich, wenn der Standort Koordinaten hat.';

for (const breite of [375, 1440]) {
  test(`${breite}: Wetter beziehen, Zustand „x von y Tagen“, lösen — und ohne Koordinaten der Satz`, async ({ page }) => {
    test.setTimeout(90_000);
    const fehler: string[] = [];
    page.on('pageerror', e => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 900 : 1000 });
    await page.clock.setFixedTime(new Date('2027-04-03T10:00:00Z'));
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bezugsgroessen');
    await expect(page.getByRole('heading', { name: 'Bezugsgrößen', exact: true })).toBeVisible();
    await page.evaluate(async (lindach) => {
      const modul = '/src/api.ts';
      const { api } = await import(modul);
      const rollen = '/src/rollen.ts';
      const { darf } = await import(rollen);
      const liste = await api.bezugsgroessen();
      const vorlage = liste.bezugsgroessen[0];
      // Das Recht hängt am Standort der Karte (geltung_id bei Geltung Standort, wie beim Messkanal): nur ein echter
      // Standort der Bühne, den die Person verwalten darf, schaltet den Knopf — eine fremde Kennung nie.
      const { standorte } = await api.standorte();
      const st = standorte.find((s: { id: string }) => darf('bezugsgroesse.verwalten', s.id)) ?? standorte[0];
      const andere = standorte.find((s: { id: string }) => s.id !== st.id) ?? st;
      const werk = { ...vorlage, id: 'bz-8', kennzeichen: 'BZ-8', name: 'Gradtagzahl Werk Ahrenberg', art: 'gradtagzahl', einheit: 'Kd', periode_art: 'monat', geltung_art: 'standort', geltung_id: st.id, geltung_name: st.name, hat_werte: false, archiviert_am: null };
      const lindachBz = { ...werk, id: 'bz-9', kennzeichen: 'BZ-9', name: 'Gradtagzahl Lindach', geltung_id: andere.id, geltung_name: andere.name };
      api.bezugsgroessen = async () => ({ bezugsgroessen: [werk, lindachBz], bezugsflaechen: [] });
      api.bezugsgroesseWerte = async (id: string) => ({ id, kennzeichen: 'BZ', wertart: 'periodenwert', einheit: 'Kd', periode_art: 'monat', werte: [] });
      api.kanalbindungen = async () => [];
      const bindung = { raumtemperatur: 20, heizgrenze: 15, regel: 'Gradtage G20/15', von: '2027-03-01', gebunden_von: 'Ines Kaltenbach', gebunden_am: '2027-04-03T09:00:00Z',
        quelle: 'Open-Meteo-Archiv', letzter_abruf: '2027-04-03T04:10:00Z', stand: { monat: '2027-03', tage: 27, tage_erwartet: 31, zustand: 'unvollständig' } };
      let gebunden = false;
      const w = window as unknown as { wetterAufrufe: string[] };
      w.wetterAufrufe = [];
      api.wetterbezug = async (id: string) => id === 'bz-9'
        ? { moeglich: true, koordinaten: false, satz: lindach, bindung: null }
        : { moeglich: true, koordinaten: true, bindung: gebunden ? bindung : null };
      api.wetterBinden = async (id: string, body: { von: string }) => { w.wetterAufrufe.push(`PUT ${id} ${body.von}`); gebunden = true; return { moeglich: true, koordinaten: true, bindung }; };
      api.wetterLoesen = async (id: string) => { w.wetterAufrufe.push(`DELETE ${id}`); gebunden = false; };
    }, LINDACH);
    await page.getByRole(breite === 375 ? 'button' : 'tab', { name: 'Kennzahlen', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Kennzahlen', exact: true })).toBeVisible();
    await page.getByRole(breite === 375 ? 'button' : 'tab', { name: 'Bezugsgrößen', exact: true }).first().click();
    const karten = page.getByTestId('bezugsgroesse-karte');
    await expect(karten).toHaveCount(2);

    const werk = karten.filter({ hasText: 'Gradtagzahl Werk Ahrenberg' });
    await werk.getByText('Wetter', { exact: true }).click();
    await werk.getByRole('button', { name: 'Wetter beziehen', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Wetter beziehen', exact: true }).click();
    await expect(werk.getByTestId('wetter-zustand')).toHaveText('bezogen aus Open-Meteo-Archiv, zuletzt am 03.04.2027 06:10, März 2027: 27 von 31 Tagen');
    await expect(werk.getByText('Temperatur von VoltPilot bezogen (Wetter-Archiv), nicht am Standort gemessen.')).toBeVisible();

    const lindach = karten.filter({ hasText: 'Gradtagzahl Lindach' });
    await lindach.getByText('Wetter', { exact: true }).click();
    await expect(lindach.getByTestId('wetter-koordinaten-fehlen')).toHaveText(LINDACH);
    await expect(lindach.getByRole('button', { name: 'Wetter beziehen', exact: true })).toHaveCount(0);

    await werk.getByRole('button', { name: 'Bezug lösen', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Bezug lösen', exact: true }).click();
    await expect(werk.getByRole('button', { name: 'Wetter beziehen', exact: true })).toBeVisible();
    const aufrufe = await page.evaluate(() => (window as unknown as { wetterAufrufe: string[] }).wetterAufrufe);
    expect(aufrufe[0]).toMatch(/^PUT bz-8 \d{4}-\d{2}-01$/);
    expect(aufrufe[1]).toBe('DELETE bz-8');

    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
