import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

type Antwort = { status: number; contentType: string; body: string };
type Stand = { antworten: Record<string, Antwort> };
type Aufnahme = {
  stand: string;
  faelle: {
    u1: Stand;
    u2: { vorBestaetigung: Stand; nachBestaetigung?: Stand };
  };
};

const PHASE = process.env.BUEHNE_PHASE;
const QUELLE = process.env.BUEHNE_ANTWORTEN;
const BILDER = process.env.BUEHNE_BILDER;
if (PHASE !== 'vorher' && PHASE !== 'nachher') throw new Error('BUEHNE_PHASE muss vorher oder nachher sein');
if (!QUELLE || !BILDER) throw new Error('BUEHNE_ANTWORTEN und BUEHNE_BILDER sind Pflicht');
const aufnahme = JSON.parse(readFileSync(QUELLE, 'utf8')) as Aufnahme;
mkdirSync(BILDER, { recursive: true });

function passend(antworten: Record<string, Antwort>, methode: string, url: URL): Antwort | undefined {
  return antworten[`${methode} ${url.pathname}${url.search}`];
}

async function mitAntworten(page: Page, fall: 'u1' | 'u2') {
  let bestaetigt = false;
  const unbekannt = new Set<string>();
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const methode = request.method();
    const vor = fall === 'u1' ? aufnahme.faelle.u1 : aufnahme.faelle.u2.vorBestaetigung;
    const nach = fall === 'u2' ? aufnahme.faelle.u2.nachBestaetigung : undefined;
    const stand = bestaetigt && nach ? nach : vor;
    const antwort = passend(stand.antworten, methode, url) ?? passend(vor.antworten, methode, url);
    if (!antwort) {
      unbekannt.add(`${methode} ${url.pathname}${url.search}`);
      await route.fulfill({ status: 599, contentType: 'application/json', body: '{"message":"Antwort nicht aufgezeichnet"}' });
      return;
    }
    if (methode === 'POST' && url.pathname === '/api/v1/standorte/vorschlag/bestaetigen') bestaetigt = true;
    await route.fulfill({ status: antwort.status, contentType: antwort.contentType, body: antwort.body });
  });
  return unbekannt;
}

async function oeffnen(page: Page, fall: 'u1' | 'u2', breite: 375 | 1440) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto(`/e2e/buehne-vorher-nachher.html?fall=${fall}#/uebersicht`);
  // Zwei getrennte Portal-Builds starten ihre Endlos-Pulse zu leicht verschiedenen Zeitpunkten.
  // Die Bühne friert ausschließlich Bewegung ein, damit der Pixelvergleich Inhalt und Layout misst.
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await expect(page.locator('.vp-main')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  return fehler;
}

async function inhaltAufzeichnen(page: Page, pfad: string) {
  const inhalt = await page.evaluate(() => {
    const normalisiert = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
    const kacheln = [...document.querySelectorAll<HTMLElement>('.vp-card, .vp-c-card')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          klasse: element.className,
          text: normalisiert(element.innerText),
          x: box.x,
          y: box.y,
          breite: box.width,
          hoehe: box.height,
        };
      });
    return { sichtbarerText: normalisiert(document.body.innerText), kacheln };
  });
  writeFileSync(pfad, `${JSON.stringify(inhalt, null, 2)}\n`, 'utf8');
}

// Der Bytegleich-Wächter ist ein Paarbeweis: jede Phase nimmt U1 je Breite AUFNAHMEN-mal auf,
// run.sh sucht darin ein bytegleiches Paar. Feste Zahl, kein Abbruch beim ersten Treffer und
// keine Schleife bis grün - die Aufnahmezahl ist nicht vom Ergebnis abhängig.
const AUFNAHMEN = 7;

for (const breite of [375, 1440] as const) {
  test(`U1 ${PHASE} ${breite}`, async ({ context }) => {
    test.setTimeout(180_000);
    // Jede Aufnahme bekommt eine frische Seite. Sieben Bilder aus einer einzigen Seite wären
    // künstlich korreliert und würden die gemessene Streuung verstecken statt sie abzubilden.
    for (let nummer = 1; nummer <= AUFNAHMEN; nummer++) {
      const page = await context.newPage();
      const unbekannt = await mitAntworten(page, 'u1');
      const fehler = await oeffnen(page, 'u1', breite);
      await expect(page.getByText('Werk Ahrenberg – Halle 1').first()).toBeVisible();
      await page.screenshot({ path: join(BILDER, `u1-${PHASE}-${breite}.aufnahme-${nummer}.png`) });
      // Der Inhaltsvergleich urteilt über die erste Aufnahme; sichtbarer Text und Kachelmaße
      // sind laut Labortabelle über alle Aufnahmen hinweg gleich.
      if (nummer === 1) await inhaltAufzeichnen(page, join(BILDER, `u1-${PHASE}-${breite}.inhalt.json`));
      expect([...unbekannt]).toEqual([]);
      expect(fehler).toEqual([]);
      await page.close();
    }
  });

  test(`U2 ${PHASE} ${breite}`, async ({ page }) => {
    const unbekannt = await mitAntworten(page, 'u2');
    const fehler = await oeffnen(page, 'u2', breite);
    if (PHASE === 'vorher') {
      await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
      await page.screenshot({ path: join(BILDER, `u2-vorher-${breite}.png`) });
    } else {
      await expect(page.getByText('Noch nicht zugeordnet').first()).toBeVisible();
      await expect(page.getByText('3 Anlagen', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(BILDER, `u2-nachher-karte-${breite}.png`) });

      await page.getByRole('button', { name: 'Standorte einrichten' }).click();
      const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
      await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
      const strassen = dialog.getByLabel('Straße und Hausnummer *');
      const karten = dialog.locator('.vp-sv-gruppe');
      // Erst zählen, wenn es etwas zu zählen gibt. Die Überschrift steht vor dem fertig
      // aufgebauten Dialogkörper; eine Zahl 0 ließe die Schleife nullmal laufen, und der
      // Fehler fiele erst zwölf Zeilen später beim Bestätigen auf („Bitte ergänzen Sie
      // Straße und Ort für jeden Standort.“).
      await expect(strassen.first()).toBeVisible();
      // Die Adresse hängt am NAMEN der Gruppe, nicht an ihrer Position: die Reihenfolge der
      // Vorschläge ist keine Zusage, und die Aufzeichnung der API-Antworten ordnet genauso zu.
      for (let i = 0; i < await karten.count(); i++) {
        const karte = karten.nth(i);
        const lindach = (await karte.getByLabel('Name des Standorts *').inputValue()).includes('Lindach');
        await karte.getByLabel('Straße und Hausnummer *').fill(lindach ? 'Werkstrasse 8' : 'Industriestrasse 4');
        await karte.getByLabel('PLZ').fill(lindach ? '84123' : '84347');
        await karte.getByLabel('Ort *').fill(lindach ? 'Lindach' : 'Ahrenberg');
      }
      // Der Weg 2 + 1 aus PR 985: der „Gehört zu“-Wähler legt Halle 2 zu Halle 1.
      // Die geleerte Gruppe fällt weg, Halle 1 behält ihre Adresse - aus drei Anlagen
      // werden ZWEI Standorte, und genau das zeigen die Bilder.
      await dialog.getByRole('combobox', { name: 'Gehört zu: Werk Ahrenberg – Halle 2' }).click();
      await page.getByRole('option', { name: 'Werk Ahrenberg – Halle 1' }).click();
      await expect(strassen).toHaveCount(2);
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `u2-nachher-vorschau-${breite}.png`) });

      await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
      await page.screenshot({ path: join(BILDER, `u2-nachher-bestaetigt-${breite}.png`) });
    }
    expect([...unbekannt]).toEqual([]);
    expect(fehler).toEqual([]);
  });
}
