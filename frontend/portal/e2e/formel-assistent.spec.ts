import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const referenz = JSON.parse(readFileSync(new URL('../../../docs/contracts/v2/uems-referenzunternehmen.json', import.meta.url), 'utf8'));

const ms = ['MS-01', 'MS-02', 'MS-07'].map(kz => referenz.messstellen.find(m => m.kennzeichen === kz)!);
const anteile = ms[2].kostenstellen_anteile.map(a => ({ id: a.kostenstelle, kostenstelle: { id: a.kostenstelle, kennzeichen: a.kostenstelle }, name: referenz.kostenstellen.find(k => k.kennzeichen === a.kostenstelle)?.name ?? '', anteil_prozent: String(a.anteil_prozent), gueltig_ab: a.gueltig_ab, gueltig_bis: a.gueltig_bis }));
const gespeichert = { eingang_art: 'verteilung', quell_messstelle_id: 'MS-07', verteilung_ziel: '4100', anteil: 'gesamt', vorzeichen: '+', faktor: 1 };
const { anteil: _gesamt, ...fassungGespeichert } = gespeichert;
async function cloud(page: Page) {
  const anfragen: { path: string; body: Record<string, any> }[] = [];
  await page.clock.setFixedTime(new Date('2026-10-18T10:00:00Z'));
  await page.route('**/api/v1/**', async route => {
    const u = new URL(route.request().url()), path = u.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (route.request().method() === 'POST') {
      anfragen.push({ path, body: route.request().postDataJSON() });
      return json({ id: 'MS-20', kennzeichen: 'MS-20', name: route.request().postDataJSON().name, art: 'berechnet' });
    }
    const geraete = ['K-3', 'K-6'].map(entityId => ({ entityId, deviceId: 'BOX-1', name: ms.find(m => m.fuehrende_quelle[0].komponente === entityId)!.name, grund: null }));
    if (path.endsWith('/summenwert-quellen')) return json(geraete);
    if (path.endsWith('/entities')) return json({ entities: geraete.map(g => ({ id: g.entityId, label: g.name })) });
    if (path.endsWith('/messkanaele')) return json({ messkanaele: [] });
    if (path.endsWith('/measurement-selection/catalog')) {
      const m = ms.find(m => m.fuehrende_quelle[0].komponente === u.searchParams.get('entityId'))!;
      return json({ total: 1, points: [{ pointKey: m.fuehrende_quelle[0].kanal, labelDe: m.name, group: 'Energie', quantity: 'active_energy', direction: 'import', aggregationKind: 'counter', unit: 'kWh', selected: true, decodedValue: null, lastReadAt: null, estimatedDataPerYearBytes: 0 }] });
    }
    if (path.endsWith('/verteilung')) return json({ messstelle_id: 'MS-07', anteile });
    if (path.endsWith('/formel')) return json({ messstelle_id: 'MS-20', hauptgroesse: ms[2].hauptgroesse, terme: [{ ...fassungGespeichert, position: 0, groesse: ms[2].hauptgroesse, gilt_als_erzeugung: false }], fassung_am: { fassung: { formel_typ: 'gewichtete_summe' } } });
    if (path === '/api/v1/messstellen') return json({ register: ms.map(m => ({ id: m.kennzeichen, kennzeichen: m.kennzeichen, name: m.name, art: m.art, hauptgroesse: m.hauptgroesse, archiviert_am: null, elektrische_stellung: m.elektrische_stellung[0], quelle: { fuehrend: { komponente: m.fuehrende_quelle[0].komponente, geraet: { bezeichnung: m.fuehrende_quelle[0].geraet } } } })) });
    return json({});
  });
  return anfragen;
}
async function waehle(page: Page, label: string, option: RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}
async function foto(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.FORMEL_BILDER) await page.screenshot({ path: `${process.env.FORMEL_BILDER}/${name}.png`, animations: 'disabled' });
}

for (const width of [375, 1440]) {
  test(`Saldo: Hauptgröße und Tagesfassung bei ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const calls = await cloud(page);
    await page.goto('/e2e/formel-assistent.html');
    await page.getByRole('button', { name: 'Summenwert anlegen', exact: true }).click();
    await waehle(page, 'Formel-Typ', /^Saldo/);
    for (const kz of ['MS-01', 'MS-02']) {
      await waehle(page, 'Messstelle als Eingang', new RegExp(`^${kz}`));
      await page.getByRole('button', { name: 'Eingang aufnehmen', exact: true }).click();
    }
    await expect(page.getByText('Wirkenergie · saldiert · kWh', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Formel-Typ', exact: true }).scrollIntoViewIfNeeded();
    await foto(page, `typen-${width}`);
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await foto(page, `saldo-${width}`);
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name des Summenwerts' }).fill('Netz-Saldo Halle 1');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText('„Netz-Saldo Halle 1“ ist angelegt')).toBeVisible();
    expect(calls[0].body).toMatchObject({ formel_typ: 'saldo', gueltig_ab: '2026-10-18', kontext: { art: 'anlage', site_id: 'AN-1' }, terme: [
      { eingang_art: 'messstelle', quell_messstelle_id: 'MS-01', vorzeichen: '+', faktor: 1 },
      { eingang_art: 'messstelle', quell_messstelle_id: 'MS-02', vorzeichen: '-', faktor: 1 },
    ] });
  });
  test(`Verteilungs-Anteil und Faktorhinweis bei ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const calls = await cloud(page);
    await page.goto('/e2e/formel-assistent.html');
    await page.getByRole('button', { name: 'Summenwert anlegen', exact: true }).click();
    await page.getByRole('button', { name: 'Netzbezug Halle 1 mitzählen' }).click();
    await page.getByRole('button', { name: 'Verteilungs-Anteil hinzufügen' }).click();
    await waehle(page, 'Messstelle als Eingang', /^MS-07/);
    await waehle(page, 'Kostenstellen-Anteil', /^4100/);
    await page.getByRole('button', { name: 'Eingang aufnehmen', exact: true }).click();
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('button', { name: 'Feineinstellung (Faktor) anzeigen' }).click();
    await page.getByRole('spinbutton', { name: 'Faktor für Netzbezug Halle 1' }).fill('0.7');
    await expect(page.getByText(/Meinen Sie einen Kostenstellen-Anteil/)).toBeVisible();
    await expect(page.locator('.vp-sw-sumline strong')).toHaveText('unvollständig');
    await foto(page, `verteilung-${width}`);
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name des Summenwerts' }).fill('Prozess Spritzguss gesamt');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText('„Prozess Spritzguss gesamt“ ist angelegt')).toBeVisible();
    expect(calls[0].body.terme[1]).toEqual(gespeichert);
  });
  test(`Formel ändern erhält die Verteilungsidentität bei ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const calls = await cloud(page);
    await page.goto('/e2e/formel-assistent.html');
    await page.getByRole('button', { name: 'Formel ändern ab Tag' }).click();
    await expect(page.getByText(/^4100 von MS-07/)).toBeVisible();
    await page.getByRole('combobox', { name: 'Gültig ab', exact: true }).click();
    await page.getByRole('grid', { name: 'Gültig ab', exact: true }).press('ArrowRight');
    await page.getByRole('grid', { name: 'Gültig ab', exact: true }).press('Enter');
    await foto(page, `fassung-${width}`);
    await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(calls[0]).toEqual({ path: '/api/v1/messstellen/MS-20/formel/fassungen', body: { gueltig_ab: '2026-10-19', terme: [fassungGespeichert] } });
  });
}
