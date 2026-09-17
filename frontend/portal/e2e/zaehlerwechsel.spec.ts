import { test, expect as baseExpect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ms06, MS_IDS, prozesseAhrenberg, kostenstellenAhrenberg, protokollMs06, prozesseVon, verteilungVon } from '../src/test/messstelleSeiteFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { vorherGeraet, vorherEinstellungen, wechselKanaele, wechselQuellen, wechselAntwort, WECHSEL_JETZT, WECHSEL_AM } from '../src/test/zaehlerwechselFixtures';
import { grundlastTag, grundlastViertelstunden } from '../src/test/werteKarteFixtures';
import { gr4Z5b } from '../src/test/geraetHerkunftFixtures';
const expect = baseExpect.configure({ timeout: 30_000 });
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function cloud(page: Page, jetzt = WECHSEL_JETZT) {
  let nachher = false;
  const posts: { pfad: string; body: any }[] = [];
  await page.clock.setFixedTime(new Date(jetzt));
  await page.route('**/api/v1/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (req.method() === 'POST') {
      posts.push({ pfad: p, body: req.postDataJSON() });
      if (p.endsWith('/quellen/wechsel') || p.endsWith('/austausch')) { nachher = true; return route.fulfill(json(wechselAntwort(), 201)); }
    }
    if (p === '/api/v1/standorte') return route.fulfill(json(ahrenbergHeute()));
    if (p.endsWith('/orte')) return route.fulfill(json(p.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    if (p.endsWith('/data-sources')) return route.fulfill(json({ datenquellen: [] }));
    if (p.endsWith('/geraete')) return route.fulfill(json({ geraete: [nachher ? gr4Z5b() : vorherGeraet()] }));
    if (p.endsWith('/einstellungen')) return route.fulfill(json(vorherEinstellungen()));
    if (p.endsWith('/messkanaele')) return route.fulfill(json(wechselKanaele()));
    if (p.endsWith('/events')) return route.fulfill(json(nachher ? [{ revision: 1, eventType: 'device_replaced', effectiveAt: WECHSEL_AM,
      fromValue: 'Z-5a', toValue: 'Z-5b', createdAt: WECHSEL_JETZT, createdBy: 'IK' }] : []));
    if (p.endsWith('/quellen')) return route.fulfill(json(wechselQuellen(nachher)));
    if (p === '/api/v1/berichte/betroffen') return route.fulfill(json({ anlass: 'zuordnung_rueckwirkend',
      gilt_ab: '2026-11-18', berichte_vorhanden: true, betroffen: [{ kennung: 'BR-2026-0099', nr: 1 }], zitieren: [] }));
    if (p === '/api/v1/messstellen') {
      const r = ahrenbergRegister({ stichtag: '2026-11-18' }); r.zeitpunkt = WECHSEL_JETZT;
      const z = r.register.find(z => z.kennzeichen === 'MS-06')!;
      z.quelle.fuehrend = { ...z.quelle.fuehrend!, geraet: { id: nachher ? 'g-z5b' : 'g-z5a', geraet: 'GR-4', einbau: nachher ? 'Z-5b' : 'Z-5a', bezeichnung: 'Unterzähler Spritzguss' }, gueltig_ab: nachher ? WECHSEL_AM : '2024-03-12T00:00:00+01:00' };
      z.beobachtung = { zustand: 'liefert_nicht_seit', text: 'liefert keine Daten seit 18.11.2026 10:40', seit: WECHSEL_AM, toleranz_s: 300, kadenz_s: 60, geraet: 'Z-5a' };
      z.letzter_wert = { wert: 1083415.2, text: null, einheit: 'kWh', zeitpunkt: WECHSEL_AM };
      if (nachher) { z.beobachtung = { zustand: 'wartet_auf_erste_daten', text: 'wartet auf erste Daten von Z-5b', seit: null, toleranz_s: 300, kadenz_s: 60, geraet: 'Z-5b' }; z.letzter_wert = null; }
      return route.fulfill(json(r));
    }
    if (p.endsWith('/werte')) {
      const tag = (url.searchParams.get('von') ?? '2026-11-17').slice(0, 10);
      const w = url.searchParams.get('raster') === 'viertelstunde' ? grundlastViertelstunden(tag, 'vorlaeufig') : grundlastTag(tag, 'vorlaeufig');
      return route.fulfill(json(w));
    }
    if (p === '/api/v1/unternehmen/prozesse') return route.fulfill(json({ prozesse: prozesseAhrenberg(), stichtag: null }));
    if (p === '/api/v1/unternehmen/kostenstellen') return route.fulfill(json({ kostenstellen: kostenstellenAhrenberg(), stichtag: null }));
    if (p.endsWith('/prozesse')) return route.fulfill(json(prozesseVon(ms06())));
    if (p.endsWith('/verteilung')) return route.fulfill(json(verteilungVon(ms06())));
    if (p.endsWith('/aenderungen')) {
      const protokoll = protokollMs06();
      if (nachher) protokoll.eintraege.unshift({ id: 'messstelle:wechsel', quelle: 'messstelle', art: 'zaehler_gewechselt',
        text: 'Zähler gewechselt: Z-5a → Z-5b', bezug: { art: 'messstelle', id: MS_IDS.ms06, kennzeichen: 'MS-06', name: ms06().name },
        gilt_ab: WECHSEL_AM, gilt_bis: null, eingetragen_am: WECHSEL_JETZT, zeitform: 'rueckwirkend', grund: null,
        urheber: { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' }, alt: null, neu: null });
      return route.fulfill(json(protokoll));
    }
    if (p === `/api/v1/messstellen/${MS_IDS.ms06}`) return route.fulfill(json(ms06()));
    return route.fulfill(json({ message: `Nicht gestellte Antwort: ${p}` }, 404));
  });
  return posts;
}

test('A2: die Folgen-Karte nennt Berichtstage und Revisionsbedarf', async ({ page }, info) => {
  const breite = info.project.name.includes('mobile') ? 375 : 1440;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  await cloud(page, '2026-11-20T09:00:00+01:00');
  await page.goto('/e2e/zaehlerwechsel.html?einstieg=messstelle');
  await page.getByRole('button', { name: 'Zähler wechseln', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Datum', exact: true }).click();
  await page.locator('[role="gridcell"][data-iso="2026-11-18"]').click();
  await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('10:40');
  await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
  await dialog.getByRole('button', { name: 'Folgen prüfen' }).click();
  await expect(dialog).toContainText('Berichte mit dem 18.–20.11.: Tagesberichte 18./19.11. (Berichtsentwurf).');
  await expect(dialog).toContainText('Freigegebene Berichte: BR-2026-0099 Nr. 1 bekommt den Vermerk „Revision nötig“.');
  await bild(page, 'a2-berichtsfolgen', breite);
});
async function bild(page: Page, name: string, breite: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) expect(await dialog.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  if (process.env.ZAEHLER_BILDER) {
    mkdirSync(process.env.ZAEHLER_BILDER, { recursive: true });
    if (!(await dialog.count())) await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ animations: 'disabled', path: join(process.env.ZAEHLER_BILDER, `${name}-${breite}.png`), fullPage: !(await dialog.count()) });
  }
}
for (const einstieg of ['messstelle', 'geraet'] as const) {
  test(`${einstieg}: Z1 → Z3, ein Vorgang, Geschichte und Marke`, async ({ page }, info) => {
    const breite = info.project.name.includes('mobile') ? 375 : 1440;
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message));
    page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    const posts = await cloud(page);
    await page.goto(`/e2e/zaehlerwechsel.html?einstieg=${einstieg}`);
    const knopf = page.getByRole('button', { name: 'Zähler wechseln', exact: true }).first();
    await knopf.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Schritt 1 von 2 · Zählerwechsel erfassen')).toBeVisible();
    await dialog.getByLabel('Kennzeichen des neuen Zählers (optional)').fill('Z-5b');
    await dialog.getByLabel('Seriennummer (optional)').fill('88231');
    await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('10:40');
    await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
    await dialog.getByLabel('Endstand bisheriger Zähler (kWh)').fill('1.083.415,2');
    await dialog.getByLabel('Anfangsstand neuer Zähler (kWh)').fill('0,0');
    await dialog.getByText('Schritt 1 von 2 · Zählerwechsel erfassen').scrollIntoViewIfNeeded();
    await bild(page, `z1-${einstieg}`, breite);
    await dialog.getByRole('button', { name: 'Folgen prüfen' }).click();
    await expect(dialog.getByRole('region', { name: 'Folgen des Zählerwechsels' })).toContainText('rückwirkend (25 min)');
    expect(posts).toHaveLength(0);
    await bild(page, `z2-${einstieg}`, breite);
    await dialog.getByRole('button', { name: 'Zählerwechsel eintragen' }).click();
    await expect(dialog.getByRole('status', { name: 'Gespeicherte Folgen' })).toContainText('Z-5a: Endstand 1.083.415,2 kWh.');
    expect(posts).toHaveLength(1);
    expect(posts[0].pfad).toBe(einstieg === 'messstelle' ? `/api/v1/messstellen/${MS_IDS.ms06}/quellen/wechsel` : '/api/v1/geraete/g-z5a/austausch');
    expect(posts[0].body).toMatchObject({ zeitpunkt: WECHSEL_AM, neues_geraet: { einbau_kennzeichen: 'Z-5b', seriennummer: '88231' }, endstand_vorgaenger: { wert: 1083415.2, einheit: 'kWh' } });
    await dialog.getByRole('button', { name: 'Schließen', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    if (einstieg === 'messstelle') {
      await expect(page.getByText('wartet auf erste Daten von Z-5b', { exact: true })).toBeVisible();
      await page.getByText('Historie (2)', { exact: true }).click();
      await expect(page.getByTestId('quelle-karte')).toContainText('Z-5a');
      await expect(page.getByTestId('quelle-karte')).toContainText('Z-5b');
      await expect(page.getByText('Zähler gewechselt: Z-5a → Z-5b', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByTestId('geraet-vorgaenger')).toContainText('Z-5a');
    }
    await page.getByText('Zählerwechsel im Verlauf', { exact: true }).click();
    await expect(page.getByText('Zählerwechsel am 18.11.2026 10:40: Z-5a → Z-5b', { exact: true })).toBeVisible();
    await bild(page, `z3-${einstieg}`, breite);
    expect(fehler).toEqual([]);
  });
}

test('Escape und Fokus bleiben am auslösenden Knopf; Abbruch schreibt nichts', async ({ page }) => {
  const posts = await cloud(page);
  await page.goto('/e2e/zaehlerwechsel.html?einstieg=geraet');
  const knopf = page.getByRole('button', { name: 'Zähler wechseln', exact: true });
  await knopf.click();
  await expect(page.getByLabel('Seriennummer (optional)')).toBeVisible();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Folgen prüfen' }).focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(knopf).toBeFocused();
  expect(posts).toHaveLength(0);
});

test('A3: angekündigten Wechsel im vorhandenen Dialog berichtigen', async ({ page }, info) => {
  const breite = info.project.name.includes('mobile') ? 375 : 1440;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  const fehler: string[] = [];
  page.on('pageerror', e => fehler.push(e.message));
  page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
  await cloud(page);
  await page.clock.setFixedTime(new Date('2026-11-10T09:00:00+01:00'));
  let bisher = '2026-11-18T10:00:00+01:00';
  const posts: unknown[] = [];
  await page.route('**/api/v1/sites/*/geraete', route => {
    const alt = { ...vorherGeraet(), ausgebaut_am: bisher,
      komponenten: vorherGeraet().komponenten.map(k => ({ ...k, gueltig_bis: bisher })) };
    const neu = { ...gr4Z5b(), eingebaut_am: bisher,
      komponenten: gr4Z5b().komponenten.map(k => ({ ...k, gueltig_ab: bisher })),
      vorgaenger: [{ ...vorherGeraet(), ausgebaut_am: bisher }] };
    return route.fulfill(json({ geraete: [alt, neu] }));
  });
  await page.route('**/api/v1/geraete/*/austausch/zeitpunkt', route => {
    const body = route.request().postDataJSON();
    posts.push(body); bisher = body.zeitpunkt;
    return route.fulfill(json({ vorgaenger: 'g-z5a', nachfolger: 'g-z5b', ...body, satz: 'Zeitpunkt berichtigt' }));
  });
  await page.goto('/e2e/zaehlerwechsel.html?einstieg=geraet&geplant=1');
  await page.getByRole('button', { name: 'Zeitpunkt berichtigen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Zählerwechsel angekündigt');
  await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('10:40');
  await dialog.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
  await dialog.getByLabel('Begründung (optional)').fill('Montage beginnt später');
  await bild(page, 'a3-berichtigen', breite);
  await dialog.getByRole('button', { name: 'Zeitpunkt berichtigen', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Geändert:');
  await bild(page, 'a3-gespeichert', breite);
  expect(posts).toEqual([{ bisher: '2026-11-18T10:00:00+01:00', zeitpunkt: '2026-11-18T10:40:00+01:00', grund: 'Montage beginnt später' }]);
  expect(fehler).toEqual([]);
});
