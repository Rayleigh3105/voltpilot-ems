import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Unternehmen › Energiemanagement“ (UEMS AP-19 IP-9) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/energiemanagement.html` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, die Routen von
 * IP-6/IP-7/IP-8 gespielt aus dem Referenzunternehmen 1.10 (`src/test/energiemanagementFixtures.ts`, R1–R3).
 *
 * Fälle: Anlegen → Fassung → Freigabe mit „entschieden von“ → Verzeichnis (R1, mit Person anlegen als Leitung) ·
 * Verweis-Fassung (R7-Muster): nur die Prüfsumme geht hinaus · Stand 12.02.2029 (R1–R3): Verzeichnis, Überprüfung,
 * Vergleich, Filter „in meinem Namen“, CSV, Zuschnitt-Hilfe.
 *
 * NETZWERK-PROBE: jede Anfrage außer GET wird mitgeschrieben, und die Bühne legt jeden Schreib-Körper an der Grenze zur
 * Route in `window.__emGesendet` ab. Geprüft wird: der Datei-Inhalt steht in KEINER Anfrage und in KEINEM Körper; der
 * Verweis trägt genau die Felder des Vertrags; seine Prüfsumme ist die SHA-256 des Inhalts, hier in Node nachgerechnet.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt
 * der Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
const AM_15_12_2026 = new Date('2026-12-15T10:00:00+01:00');
const AM_12_11_2028 = new Date('2028-11-12T10:00:00+01:00');
const AM_12_02_2029 = new Date('2029-02-12T14:00:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const LEER = 'Hier ist noch nichts festgehalten.';
const OHNE_LEITUNG =
  'Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.';
const PRUEFSUMME_SATZ = 'Die Prüfsumme wird in Ihrem Browser gebildet; die Datei verlässt Ihren Rechner nicht.';
const POLITIK =
  'Die Kunststoffwerk Ahrenberg GmbH will ihren Energieeinsatz in beiden Werken kennen und ihre energiebezogene Leistung Jahr für Jahr verbessern.';
const VERWEIS_FELDER = ['ablage', 'adresse', 'bezeichnung', 'datum', 'fassungsangabe', 'kennung', 'sha256'];

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energiemanagement.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !(e instanceof HTMLInputElement && e.type === 'file'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const reiter = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]
      .filter((t) => sichtbar(t))
      .map((t) => (t.textContent ?? '').trim());
    return { route: document.body.dataset.route ?? null, dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)], reiter };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Ein hohes Fenster statt `fullPage` — sonst stünde die feste Leiste mitten im Bild (AP-18 IP-13).
  if (ganz && vp) {
    const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path });
}

/** Ein Dialog als Bild: das Fenster so hoch wie der Dialog, damit er ganz zu sehen ist. */
async function dialogBild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  // Das Fenster so hoch, dass der Dialog nicht mehr in sich scrollt; dann ruhig (ohne Übergang) als Element fotografieren.
  const zuviel = await page.evaluate(() =>
    Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.vp-modal *')].map((e) => e.scrollHeight - e.clientHeight).filter((d) => d > 1)),
  );
  await page.setViewportSize({ width: vp.width, height: vp.height + zuviel + 40 });
  await page.waitForTimeout(300);
  await modal(page).screenshot({ path: join(BILDER, `${name}.png`), animations: 'disabled' });
  await page.setViewportSize(vp);
}

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

const modal = (page: Page) => page.locator('.vp-modal').last();
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __emGesendet: { route: string; koerper: unknown }[] }).__emGesendet);
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement bei ${breite} px`, () => {
    test('R1: Anlegen → Fassung → Freigabe mit „entschieden von“ (Leitung neu angelegt) → Verzeichnis; nur die Prüfsumme geht hinaus', async ({ page }) => {
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') anfragen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
      });
      await oeffne(page, 'lage=start', breite, AM_15_12_2026);
      const bereich = page.getByTestId('energiemanagement-bereich');
      await expect(bereich.getByRole('heading', { level: 1 })).toHaveText('Energiemanagement');
      // Das Verzeichnis ist der erste Reiter (§5.1); eine leere Gruppe sagt es und nennt ihren Zuschnitt (VZ3).
      await expect(page.getByTestId('energiemanagement-reiter-verzeichnis')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('verzeichnis-gruppe-grundlagen')).toContainText(LEER);
      await expect(page.getByTestId('verzeichnis-gruppe-grundlagen')).toContainText('Energiepolitik — Wortlaut in VoltPilot, Original bei Ihnen');
      await expect(page.getByTestId('energiemanagement-saetze')).toContainText(GRENZE);
      await expect(page.getByTestId('energiemanagement-saetze')).toContainText(VERANTWORTUNG);
      const m0 = await messe(page);
      expect(m0.reiter).toEqual(expect.arrayContaining(['Verzeichnis', 'Dokumente']));
      expect(m0.reiter.indexOf('Verzeichnis')).toBeLessThan(m0.reiter.indexOf('Dokumente'));
      if (breite >= 720) expect(m0.reiter).toContain('Energiemanagement');
      ohneQuerlauf(m0, 'Verzeichnis leer');
      await ablegen(page, `a-verzeichnis-leer-${breite}`);

      await page.getByTestId('energiemanagement-reiter-dokumente').click();
      await expect(page.getByTestId('dokumente-leer')).toHaveText(LEER);
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/dokumente');
      await page.getByTestId('dokument-anlegen').click();
      const anlegen = page.getByTestId('dokument-anlegen-dialog');
      await waehle(page, modal(page).getByRole('combobox', { name: 'Art', exact: true }), /^Energiepolitik/);
      await expect(anlegen.getByTestId('dokument-art-satz')).toContainText('Die Leitung entscheidet.');
      await expect(anlegen.getByLabel('Titel')).toHaveValue('Energiepolitik');
      const original = anlegen.locator('fieldset').filter({ hasText: 'Original bei Ihnen' });
      await original.getByLabel('Ablage bei Ihnen').fill('QM-Laufwerk, Ordner Energiemanagement/Politik');
      await original.getByLabel('Bezeichnung').fill('Energiepolitik Fassung 1, unterschrieben');
      await original.getByLabel('Kennung bei Ihnen').fill('EP-2026');
      const inhalt = `UNTERSCHRIEBENE-ENERGIEPOLITIK-${breite}-DIESER-INHALT-VERLAESST-DEN-RECHNER-NIE`;
      await original.locator('input[type="file"]').setInputFiles({ name: 'energiepolitik-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
      await expect(original.getByTestId(/-pruefsumme$/)).toContainText('aus „energiepolitik-2026.pdf“.');
      await expect(original.getByTestId(/-pruefsumme$/)).toContainText(PRUEFSUMME_SATZ);
      await expect(anlegen.getByText(VERANTWORTUNG)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Anlegen');
      await dialogBild(page, `b-anlegen-${breite}`);
      await page.getByTestId('dokument-anlegen-senden').click();

      const seite = page.getByTestId('dokument-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Energiepolitik D-0001');
      await expect(page.getByTestId('dokument-kopf')).toHaveText('Entwurf — noch keine Fassung freigegeben.');
      await page.getByTestId('dokument-fassung').click();
      const fassung = page.getByTestId('fassung-dialog');
      await expect(fassung.getByTestId('fassung-form-wortlaut')).toBeChecked();
      await fassung.getByLabel('Wortlaut', { exact: true }).fill(POLITIK);
      ohneQuerlauf(await messe(page), 'Fassung');
      await dialogBild(page, `c-fassung-${breite}`);
      await page.getByTestId('fassung-senden').click();
      await expect(page.getByTestId('dokument-fassung-inhalt')).toContainText('Fassung 1 · Entwurf');
      await expect(page.getByTestId('dokument-fassung-inhalt')).toContainText(POLITIK);

      // Freigabe: bei der Energiepolitik entscheidet die Leitung — ohne Leitung sagt der Dialog, warum er sperrt (PA3).
      await page.getByTestId('dokument-freigeben').click();
      const freigabe = page.getByTestId('freigabe-dialog');
      await expect(freigabe.getByTestId('freigabe-ohne-leitung')).toHaveText(OHNE_LEITUNG);
      await expect(page.getByTestId('freigabe-senden')).toBeDisabled();
      ohneQuerlauf(await messe(page), 'Freigabe ohne Leitung');
      await dialogBild(page, `d-freigabe-ohne-leitung-${breite}`);
      await freigabe.getByTestId('freigabe-person-anlegen').click();
      const personDialog = page.getByTestId('person-dialog');
      await personDialog.getByLabel('Name').fill('Robert Falk');
      await personDialog.getByLabel('Funktion').fill('Geschäftsführer');
      await personDialog.getByLabel('Kürzel (wahlfrei)').fill('RF');
      await expect(personDialog.getByTestId('person-leitung')).toBeChecked();
      await personDialog.getByLabel('Begründung').fill('Geschäftsführer der Kunststoffwerk Ahrenberg GmbH.');
      ohneQuerlauf(await messe(page), 'Person anlegen');
      await dialogBild(page, `e-person-leitung-${breite}`);
      await page.getByTestId('person-senden').click();
      await expect(personDialog).toBeHidden();
      await expect(modal(page).getByRole('combobox', { name: 'entschieden von' })).toContainText('Robert Falk');
      await freigabe.getByLabel('Begründung').fill('Erste Fassung zum Start des Energiemanagements.');
      ohneQuerlauf(await messe(page), 'Freigabe');
      await dialogBild(page, `f-freigabe-${breite}`);
      await page.getByTestId('freigabe-senden').click();

      await expect(page.getByTestId('dokument-kopf')).toHaveText(
        'Energiepolitik D-0001 · Fassung 1 · freigegeben am 15.12.2026 · entschieden von Robert Falk (Geschäftsführer) · eingetragen von Ines Kaltenbach.',
      );
      await expect(page.getByTestId('dokument-ort')).toHaveText('Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Politik.');
      await expect(page.getByTestId('dokument-fassung-1')).toContainText('Robert Falk (Geschäftsführer)');
      await expect(page.getByTestId('dokument-fassung-1')).toContainText(/sha256|[0-9a-f]{4}…[0-9a-f]{4}/);
      await expect(page.getByTestId('dokument-ueberpruefung')).toHaveText('Überprüfung fällig am 15.12.2027.');
      await expect(seite.getByText(VERANTWORTUNG)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Dokument-Seite');
      await ablegen(page, `g-dokument-${breite}`, true);

      await page.getByTestId('dokument-zurueck').click();
      await expect(page.getByTestId('dokument-zeile-D-0001')).toContainText('gültig · Fassung 1');
      await page.getByTestId('energiemanagement-reiter-verzeichnis').click();
      const grundlagen = page.getByTestId('verzeichnis-gruppe-grundlagen');
      const zeile = grundlagen.getByTestId('verzeichnis-zeile-D-0001');
      await expect(zeile).toContainText('D-0001 · Energiepolitik');
      await expect(zeile).toContainText('Robert Falk');
      await expect(zeile).toContainText('Ines Kaltenbach');
      await expect(zeile).toContainText('15.12.2026');
      await expect(zeile).toContainText('Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner Energiemanagement/Politik');
      await expect(page.getByTestId('verzeichnis-gruppe-verantwortung')).toContainText('Leitung des Unternehmens: Robert Falk');
      ohneQuerlauf(await messe(page), 'Verzeichnis');
      await ablegen(page, `h-verzeichnis-${breite}`, true);
      // Eine Dokument-Zeile öffnet ihr Dokument.
      await zeile.getByRole('button').click();
      await expect(page.getByTestId('dokument-kopf')).toContainText('Energiepolitik D-0001 · Fassung 1');

      // Netzwerk-Probe: der Inhalt stand in keiner Anfrage und in keinem Körper; gesendet wurde nur seine Prüfsumme.
      const koerper = await gesendet(page);
      expect(anfragen.filter((a) => a.includes(inhalt))).toEqual([]);
      expect(JSON.stringify(koerper)).not.toContain(inhalt);
      const angelegt = koerper.find((k) => k.route === 'POST /api/v1/energiemanagement/dokumente')!.koerper as { beleg: Record<string, unknown> };
      expect(angelegt.beleg).toEqual({
        bezeichnung: 'Energiepolitik Fassung 1, unterschrieben', ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik', kennung: 'EP-2026', adresse: null,
        sha256: sha256(inhalt),
      });
      expect(koerper.map((k) => k.route.replace(/[0-9a-f-]{36}/g, '{id}'))).toEqual([
        'POST /api/v1/energiemanagement/dokumente',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen',
        'POST /api/v1/energiemanagement/personen',
        'POST /api/v1/energiemanagement/aufgaben',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen/1/freigeben',
      ]);
      const freigegeben = koerper[4].koerper as Record<string, unknown>;
      expect(freigegeben).toEqual({ entschieden_von: expect.any(String), entschieden_am: '2026-12-15', begruendung: 'Erste Fassung zum Start des Energiemanagements.' });
      expect((koerper[3].koerper as { aufgabe: string }).aufgabe).toBe('unternehmensleitung');
    });

    test('Verweis-Fassung (R7-Muster): Ablage, Kennung, Fassungsangabe und die Prüfsumme — die Datei verlässt den Rechner nicht', async ({ page }) => {
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') anfragen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
      });
      await oeffne(page, 'lage=start&seite=dokumente', breite, AM_12_11_2028);
      await page.getByTestId('dokument-anlegen').click();
      await waehle(page, modal(page).getByRole('combobox', { name: 'Art', exact: true }), /^Betrieb und Instandhaltung/);
      await page.getByTestId('dokument-anlegen-dialog').getByLabel('Titel').fill('Kriterien für Betrieb und Instandhaltung — Spritzguss');
      await page.getByTestId('dokument-anlegen-senden').click();
      await expect(page.getByTestId('dokument-seite').getByRole('heading', { level: 1 })).toHaveText('Betrieb und Instandhaltung D-0001');
      await page.getByTestId('dokument-fassung').click();
      const fassung = page.getByTestId('fassung-dialog');
      await fassung.getByTestId('fassung-form-verweis').check();
      const verweis = fassung.locator('fieldset').filter({ hasText: 'Wo das Original liegt' });
      await verweis.getByLabel('Ablage bei Ihnen').fill('Instandhaltungssystem, Arbeitspläne');
      await verweis.getByLabel('Bezeichnung').fill('Arbeitsplan Spritzguss');
      await verweis.getByLabel('Kennung bei Ihnen').fill('IH-SG-01');
      await verweis.getByLabel('Ihre Fassungsangabe').fill('Rev. 4');
      const inhalt = `ARBEITSPLAN-IH-SG-01-REV-4-${breite}-INHALT-BLEIBT-AUF-DEM-GERAET`;
      await verweis.locator('input[type="file"]').setInputFiles({ name: 'IH-SG-01_Rev4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
      await expect(verweis.getByTestId(/-pruefsumme$/)).toContainText('aus „IH-SG-01_Rev4.pdf“.');
      await expect(fassung.getByText('VoltPilot speichert keine Dateien. Halten Sie fest, wo das Original liegt; die Prüfsumme zeigt später, ob es noch dasselbe ist.')).toBeVisible();
      ohneQuerlauf(await messe(page), 'Verweis-Dialog');
      await dialogBild(page, `i-verweis-${breite}`);
      await page.getByTestId('fassung-senden').click();
      await page.getByTestId('dokument-freigeben').click();
      await waehle(page, modal(page).getByRole('combobox', { name: 'entschieden von' }), /^Ines Kaltenbach/);
      await page.getByTestId('freigabe-dialog').getByLabel('Begründung').fill('Arbeitsplan nach der Überarbeitung übernommen.');
      await page.getByTestId('freigabe-senden').click();
      await expect(page.getByTestId('dokument-ort')).toHaveText('Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4).');
      await expect(page.getByTestId('dokument-kopf')).toContainText('entschieden von Ines Kaltenbach (Energiemanagement) · eingetragen von Ines Kaltenbach.');
      ohneQuerlauf(await messe(page), 'Verweis-Seite');
      await ablegen(page, `j-verweis-seite-${breite}`, true);

      const koerper = await gesendet(page);
      expect(anfragen.filter((a) => a.includes(inhalt))).toEqual([]);
      expect(JSON.stringify(koerper)).not.toContain(inhalt);
      const entwurf = koerper.find((k) => k.route.endsWith('/fassungen'))!.koerper as { form: string; verweis: Record<string, unknown>; wortlaut?: unknown };
      expect(entwurf.form).toBe('verweis');
      expect(entwurf.wortlaut).toBeUndefined();
      expect(Object.keys(entwurf.verweis).sort()).toEqual(VERWEIS_FELDER);
      expect(entwurf.verweis).toMatchObject({ ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4', sha256: sha256(inhalt) });
    });

    test('Stand 12.02.2029 (R1–R3): Verzeichnis mit leeren Gruppen, Filter „in meinem Namen“, CSV, Überprüfung, Vergleich, Zuschnitt-Hilfe', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg', breite, AM_12_02_2029);
      await expect(page.getByTestId('verzeichnis-zeile-D-0001').first()).toBeVisible();
      await expect(page.getByTestId('verzeichnis-gruppe-risiken_chancen')).toContainText(LEER);
      await expect(page.getByTestId('verzeichnis-gruppe-managementbewertung')).toContainText(LEER);
      await expect(page.getByTestId('verzeichnis-gruppe-kompetenz_kommunikation')).toContainText('bekannt gemacht an alle Mitarbeitenden beider Werke');
      await expect(page.getByTestId('verzeichnis-gruppe-grundlagen').getByTestId('verzeichnis-zeile-D-0003')).toContainText('Geführt in Ihrem System: Rechtskataster-Dienst, Mandant Ahrenberg');
      ohneQuerlauf(await messe(page), 'Verzeichnis 12.02.2029');
      await ablegen(page, `k-verzeichnis-ahrenberg-${breite}`, true);

      await waehle(page, page.getByRole('combobox', { name: 'Festgehalten im Namen von' }), /in meinem Namen/);
      await expect(page.getByTestId('verzeichnis-stichtag')).toContainText(/In meinem Namen festgehalten: \d+ Einträge\./);
      await expect(page.getByTestId('verzeichnis-gruppe-grundlagen')).toContainText('D-0003');
      await expect(page.getByTestId('verzeichnis-gruppe-grundlagen')).not.toContainText('D-0001 · Energiepolitik');
      const download = page.waitForEvent('download');
      await page.getByTestId('verzeichnis-csv').click();
      const datei = await (await download).path();
      const csv = readFileSync(datei!, 'utf8');
      expect(csv).toContain(VERANTWORTUNG);
      expect(csv).toContain('Gruppe;Art;Kennzeichen;Titel;Fassung oder Nr.;entschieden von;eingetragen von;Tag;Prüfsumme;Ort');
      expect(csv).toContain('D-0003');

      await oeffne(page, 'lage=ahrenberg&dok=1', breite, AM_12_02_2029);
      await expect(page.getByTestId('dokument-kopf')).toHaveText(
        'Energiepolitik D-0001 · Fassung 1 · freigegeben am 15.12.2026 · entschieden von Robert Falk (Geschäftsführer) · eingetragen von Ines Kaltenbach.',
      );
      await expect(page.getByTestId('dokument-ueberpruefung')).toHaveText('Überprüfung fällig seit 64 Tagen.');
      await expect(page.getByTestId('dokument-seite')).toContainText(
        'Bekannt gemacht am 18.12.2026 an alle Mitarbeitenden beider Werke über Aushang — eingetragen von Ines Kaltenbach.',
      );
      await expect(page.getByTestId('dokument-seite')).toContainText(
        'Geprüft, bleibt — entschieden von Robert Falk am 10.12.2027: ‚Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert.‘',
      );
      await expect(page.getByTestId('dokument-original')).toContainText('Original bei Ihnen: Energiepolitik Fassung 1, unterschrieben · QM-Laufwerk, Ordner Energiemanagement/Politik · EP-2026 · Prüfsumme 3f1f…3b9b');
      ohneQuerlauf(await messe(page), 'D-0001');
      await ablegen(page, `l-energiepolitik-${breite}`, true);

      await oeffne(page, 'lage=ahrenberg&dok=2', breite, AM_12_02_2029);
      await expect(page.getByTestId('dokument-anwendungsbereich')).toContainText('Werk Ahrenberg, Werk Lindach');
      await expect(page.getByTestId('vergleich-satz')).toHaveText(
        'Der Betrachtungsumfang der energetischen Bewertung (Fassung 1, ab 04.11.2026) umfasst dieselben Standorte und Energieträger.',
      );
      ohneQuerlauf(await messe(page), 'D-0002');
      await ablegen(page, `m-anwendungsbereich-${breite}`, true);

      await oeffne(page, 'lage=ahrenberg', breite, AM_12_02_2029);
      await page.getByTestId('energiemanagement-zuschnitt-link').click();
      const hilfe = page.getByTestId('zuschnitt-hilfe');
      await expect(hilfe.getByRole('heading', { level: 1 })).toHaveText('Was VoltPilot führt — was bei Ihnen liegt.');
      await expect(page.getByTestId('zuschnitt-teile').locator('tbody tr')).toHaveCount(16);
      await expect(page.getByTestId('zuschnitt-nachbarn').locator('tbody tr')).toHaveCount(4);
      await expect(hilfe.getByText(GRENZE)).toBeVisible();
      await expect(hilfe.getByText(VERANTWORTUNG)).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/zuschnitt');
      ohneQuerlauf(await messe(page), 'Zuschnitt-Hilfe');
      await ablegen(page, `n-zuschnitt-${breite}`, true);
      await page.getByTestId('zuschnitt-zurueck').click();
      await expect(page.getByTestId('energiemanagement-bereich')).toBeVisible();
    });
  });
}
