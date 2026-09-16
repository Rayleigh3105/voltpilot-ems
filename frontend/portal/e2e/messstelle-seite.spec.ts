import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EINFUEHRUNG_TAG,
  kostenstellenAhrenberg,
  MS_IDS,
  ms06,
  ms08Angelegt,
  ms08OrtGeplant,
  ms08Vorher,
  ms10,
  ms16,
  ms21,
  ohneProzesse,
  ohneVerteilung,
  protokollMs06,
  protokollMs08Angelegt,
  protokollMs08OrtGeplant,
  protokollMs08Vorher,
  protokollMs10,
  prozesseAhrenberg,
  SEITE_HEUTE,
  prozesseVon,
  verteilungVon,
} from '../src/test/messstelleSeiteFixtures';
import type { MeasurementHistory, MessstelleVerteilung, MessstelleWerte } from '../src/api';
import { verschiebe } from '../src/picker/datum';
import { ahrenbergDatenquellen, ahrenbergUemsGeraete, BOX_IDS, geraetId } from '../src/test/datenquellenFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { quellenDerMessstellenBuehne } from '../src/test/messstelleQuellenFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import {
  f13Stunden,
  f13Tag,
  f13Viertelstunden,
  f16Monat,
  f16Tage,
  f8Stunden,
  f8Tag,
  f8Viertelstunden,
  fassungAm,
  grundlastStunden,
  grundlastTag,
  grundlastViertelstunden,
  grundlastWoche,
  jahr2026,
  ms16Oktober,
  ms16OktoberTage,
  ohneQuelleStunden,
  ohneQuelleTag,
  ohneQuelleViertelstunden,
} from '../src/test/werteKarteFixtures';
import { f21Stunden, f21Tag, f21TagWert } from '../src/test/wertVersionenFixtures';
import { MS_11, monatKarte, monatOhneQuelle, monatTage } from '../src/test/vergleichFixtures';
import { MS_10 } from '../src/test/werteKarteFixtures';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ersten Zugriff kalt — großzügige Frist.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * UEMS AP-04 IP-8 · die Messstellen-Seite am echten Baustein (Bühne `messstelle-seite.html`):
 * R2 — MS-06 mit drei Zuordnungs-Karten und dem Protokoll nach der Eintragung; Z4 — „Ort ändern“
 * für MS-08 ab 01.03.2027 („geplant“), gespeichert, Historie der Karte aus der Antwort; dazu das
 * Kennzeichen „rückwirkend (19 Tage)“ im Dialog „Prozesse ändern“. Misst bei jedem Bild: Dokument
 * und Dialog 0 px Querlauf, kein Element über dem Rand. `mobile-chromium` fährt 375 px (Pflicht des
 * Reports), `desktop-chromium` 1440 px. Mit `MESSSTELLE_SEITE_BILDER=<Ordner>` legt der Lauf je
 * Schritt ein Bild und `messung-*.json` ab.
 */

const BILDER = process.env.MESSSTELLE_SEITE_BILDER;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const herkunftsVerlauf = (url: URL): MeasurementHistory => ({
  meta: {
    pointKey: decodeURIComponent(url.pathname.split('/').at(-2) ?? 'energy-import'), label: 'Wirkenergie Bezug',
    sourceLabel: 'Energy import', unit: 'kWh', aggregationKind: 'counter', semanticStatus: 'known',
    catalogVersion: '2026.08.26.3', representation: 'decoded', rawAvailable: false,
    from: url.searchParams.get('from') ?? '2026-11-03T16:30:00+01:00',
    to: url.searchParams.get('to') ?? '2026-11-03T16:45:00+01:00', bucketSeconds: 900,
    aggregationExplanation: 'Viertelstundenwerte.', siteId: FIXTURE_IDS.st1, entityId: 'entity',
    quelle: 'viertelstunde', quelleErklaerung: 'Viertelstundenwerte.', rohGrenze: '2026-10-20T00:00:00+02:00',
  },
  data: [{
    time: url.searchParams.get('from') ?? '2026-11-03T16:30:00+01:00', value: 22.4, minimum: 22.4,
    maximum: 22.4, text: null, sampleCount: 15, gap: false,
    herkunft: {
      quelle: 'viertelstunde', wertart: 'counter', abdeckungProzent: 93, erhalten: 14, erwartet: 15,
      nGood: 14, nUncertain: 0, nInvalid: 0, nStale: 0, nDeviceError: 0,
      zustand: 'endgueltig', endgueltigAb: '2026-11-10T17:45:00+01:00', version: 1,
      nachgeliefert: 14, zustellart: 'nachgeliefert', letzteEingangszeit: '2026-11-03T17:31:00+01:00',
      geraetEinbau: geraetId('GR-7'), geraetEinbauZwei: null, box: BOX_IDS['E-2'], boxZwei: null,
      fassung: 1, katalogVersion: '2026.08.26.3', rolle: 'fuehrend', standAnfang: 418800, standEnde: 419160,
    },
  }],
  markers: [{ time: '2026-11-03T14:00:00+01:00', until: '2026-11-03T17:30:00+01:00', kind: 'data_gap', label: 'Datenlücke', count: 1 }],
});

interface Gesendet {
  methode: string;
  pfad: string;
  body: unknown;
}

/**
 * Die Route „Werte je Messstelle“ der Bühne (UEMS AP-13 IP-3): MS-06 am 25.10.2026 ist F13, jeder andere Tag die
 * Grundlast derselben Stunde (endgültig ab dem achten Tag nach seinem Beginn); MS-10 am 03.11.2026 ist F21 in der
 * Version der Anfrage. Alles andere ist nicht gestellt (404).
 */
function werteAntwort(kz: string, p: URLSearchParams, heute: string, f8 = false): MessstelleWerte | null {
  const raster = p.get('raster');
  const von = p.get('von') ?? '';
  const bis = p.get('bis') ?? '';
  const nach = (antworten: Partial<Record<string, () => MessstelleWerte>>) => antworten[raster ?? '']?.() ?? null;
  if (kz === 'MS-06') {
    if (von === '2026-10-25' && bis === von) return nach({ tag: f13Tag, stunde: f13Stunden, viertelstunde: f13Viertelstunden });
    if (bis === von) {
      const fassung = fassungAm(von, heute);
      return nach({ tag: () => grundlastTag(von, fassung), stunde: () => grundlastStunden(von, fassung), viertelstunde: () => grundlastViertelstunden(von, fassung) });
    }
    // AP-13 IP-4: eine Woche (Stunden und Tage), der Oktober (F16) und das Jahr 2026.
    if (verschiebe(von, 6) === bis) return nach({ tag: () => grundlastWoche(von, heute).tage, stunde: () => grundlastWoche(von, heute).stunden });
    if (von === '2026-10-01' && bis === '2026-10-31') return nach({ monat: f16Monat, tag: f16Tage });
    if (von === '2026-01-01' && bis === '2026-12-31') return nach({ jahr: () => jahr2026(heute).karte, monat: () => jahr2026(heute).monate });
    return null;
  }
  // AP-13 IP-6: MS-21 ohne Datenquelle am 03.11.2026 (Z4), MS-16 im Oktober 2026 — die Bindung beginnt am 15.10. (O16).
  if (kz === 'MS-21' && von === '2026-11-03' && bis === von) {
    return nach({ tag: ohneQuelleTag, stunde: ohneQuelleStunden, viertelstunde: ohneQuelleViertelstunden });
  }
  if (kz === 'MS-16' && von === '2026-10-01' && bis === '2026-10-31') return nach({ monat: ms16Oktober, tag: ms16OktoberTage });
  // AP-13 IP-5 (O11/O12): die Monate des Vergleichs. MS-10 November 35 800 gegen Oktober 36 900; der
  // Vorjahresmonat November 2025 liegt vor dem Bestehen (Einführung 01.10.2026) — die Route antwortet ohne
  // Bindung. MS-11 liegt als zweite Reihe daneben (Oktober 22 400, November 21 500).
  const vergleich = vergleichsMonat(kz, raster, von, bis);
  if (vergleich) return vergleich;
  if (kz === 'MS-10' && von === '2026-11-03' && bis === von) {
    // O1: die Lücke des Box-Ausfalls (F8) — sonst derselbe Tag nach Ersatzwert und Korrektur (F21).
    if (f8) return nach({ tag: f8Tag, stunde: f8Stunden, viertelstunde: f8Viertelstunden });
    if (raster === 'stunde') return f21Stunden();
    if (raster !== 'tag') return null;
    const v = Number(p.get('version') ?? '3');
    return v === 1 || v === 2 || v === 3 ? { ...f21Tag(), version: p.get('version') ? v : null, werte: [f21TagWert(v)] } : null;
  }
  return null;
}


/** Die Monatsantworten, die nur der Vergleich braucht (AP-13 IP-5, O11/O12) — `null` = nicht gestellt. */
function vergleichsMonat(kz: string, raster: string | null, von: string, bis: string): MessstelleWerte | null {
  const mengen: Record<string, Record<string, number>> = {
    'MS-10': { '2026-11': 35800, '2026-10': 36900 },
    'MS-11': { '2026-11': 21500, '2026-10': 22400 },
  };
  const messstelle = kz === 'MS-10' ? MS_10 : kz === 'MS-11' ? MS_11 : null;
  if (!messstelle) return null;
  const monat = von.slice(0, 7);
  if (von !== `${monat}-01` || bis.slice(0, 7) !== monat) return null;
  if (monat === '2025-11') return raster === 'monat' ? monatOhneQuelle(messstelle, monat) : null;
  const menge = mengen[kz]?.[monat];
  if (menge === undefined) return null;
  // Der Wochen-Gang trennt die Reihen sichtbar: MS-10 fährt am Wochenende gedrosselt, MS-11 fast gar nicht.
  const wochenende = kz === 'MS-11' ? 0.3 : monat === '2026-10' ? 0.5 : 0.65;
  return raster === 'monat'
    ? monatKarte(messstelle, monat, menge)
    : raster === 'tag'
      ? monatTage(messstelle, monat, menge, wochenende)
      : null;
}

/**
 * AP-13 IP-6 · zwei GESTELLTE Ablehnungen der Route, die die Fläche mit festen Zeiträumen selbst nie auslöst: MS-06 am
 * 24.10.2026 antwortet 400 `nicht_im_raster`; der Oktober 2026 in Version 1 antwortet 404 `wert_nicht_mehr_gespeichert`
 * (so, wie AP-12 IP-16 es nach den Fristen tun wird — O19; ohne Berichtsstand, den MS-06 hier nicht hat).
 */
function werteAblehnung(kz: string, p: URLSearchParams): { status: number; body: unknown } | null {
  if (kz !== 'MS-06') return null;
  if (p.get('von') === '2026-10-24') {
    return { status: 400, body: { code: 'anfrage_ungueltig', message: 'Der Zeitpunkt liegt nicht auf dem Raster.', feld: 'von', grund: 'nicht_im_raster' } };
  }
  if (p.get('raster') === 'monat' && p.get('von') === '2026-10-01' && p.get('version') === '1') {
    return {
      status: 404,
      body: { code: 'wert_nicht_mehr_gespeichert', message: 'Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre).' },
    };
  }
  return null;
}

/**
 * UEMS AP-13 IP-11 (D4): dieselbe Antwort, aber mit der Herkunfts-Hülle einer BERECHNETEN Zahl
 * (`bilanzwert-herkunft`, AP-10 IP-12). Die Route trägt sie seit AP-10; gelesen hat sie bis IP-11 niemand.
 */
const alsBerechnet = (a: MessstelleWerte): MessstelleWerte => ({
  ...a,
  werte: a.werte.map((w, i) =>
    i > 0
      ? w
      : {
          ...w,
          herkunft: {
            satz: {
              art: 'berechnet',
              messstelle: 'MS-09',
              periode: { art: 'monat', schluessel: '2026-10' },
              formel_typ: 'gewichtete_summe',
              formel_fassung: 2,
              periode_ende: '2026-10-31T23:59:59+01:00',
              berechnet_am: '2026-11-01T00:20:00+01:00',
              version: 2,
              ausloeser: 'correction MS-12 2026-10 Version 2',
              verteilung: null,
              eingaenge: [
                { messstelle: 'MS-12', anteil: 'gesamt', menge: '6040', zustand: 'vollständig', abdeckung_prozent: 100, version: 2, kennzeichen: ['korrigiert (Version 2)'] },
                { messstelle: 'MS-13', anteil: 'gesamt', menge: '2000', zustand: 'unvollständig', abdeckung_prozent: 80, version: 1, kennzeichen: [] },
              ],
              menge: '8040',
              zustand: 'unvollständig',
              abdeckung_prozent: 80,
              kennzeichen: [],
            },
            fehlt: [],
          },
        },
  ),
});

/** `angelegt`: MS-08 am 01.10.2026, eben angelegt (heute = Stichtag der Einführung); `heute`: der Stichtag des Registers. */
async function cloud(
  page: Page,
  { angelegt = false, heute = null as string | null, f8 = false, berechnet = false } = {},
): Promise<Gesendet[]> {
  const gesendet: Gesendet[] = [];
  let gespeichert = false;
  let verteilungGespeichert: MessstelleVerteilung | null = null;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pfad = url.pathname;
    const methode = req.method();
    if (methode !== 'GET') gesendet.push({ methode, pfad, body: req.postDataJSON() });

    const ms08 = () => (angelegt ? ms08Angelegt() : gespeichert ? ms08OrtGeplant() : ms08Vorher());
    const messstelle = pfad.includes(MS_IDS.ms06)
      ? ms06()
      : pfad.includes(MS_IDS.ms10)
        ? ms10()
        : pfad.includes(MS_IDS.ms16)
          ? ms16()
          : pfad.includes(MS_IDS.ms21)
            ? ms21()
            : ms08();

    if (pfad === '/api/v1/unternehmen/prozesse') return route.fulfill(json({ stichtag: null, prozesse: prozesseAhrenberg() }));
    if (pfad === '/api/v1/unternehmen/kostenstellen') {
      return route.fulfill(json({ stichtag: null, kostenstellen: kostenstellenAhrenberg() }));
    }
    if (pfad === '/api/v1/standorte') return route.fulfill(json(ahrenbergHeute()));
    if (/\/measurement-selection\/[^/]+\/history$/.test(pfad) && methode === 'GET') {
      return route.fulfill(json(herkunftsVerlauf(url)));
    }
    // AP-13 IP-12 (L6): die Zuständigkeiten der Datenquellen und der Weg Gerät → Quelle (zwei Aufrufe je Anlage).
    const anlage = /^\/api\/v1\/sites\/([^/]+)\/(data-sources|geraete)$/.exec(pfad);
    if (anlage && methode === 'GET') {
      return route.fulfill(
        json(anlage[2] === 'data-sources' ? ahrenbergDatenquellen(anlage[1], new Date().toISOString()) : ahrenbergUemsGeraete(anlage[1])),
      );
    }
    if (pfad.endsWith('/orte')) return route.fulfill(json(pfad.includes(FIXTURE_IDS.st1) ? ortsbaumAhrenberg() : ortsbaumLindach()));
    if (pfad === '/api/v1/messstellen' && methode === 'GET') {
      const register = angelegt ? { ...ahrenbergRegister(), stichtag: EINFUEHRUNG_TAG } : heute ? ahrenbergRegister({ stichtag: heute }) : ahrenbergRegister();
      return route.fulfill(json(register));
    }
    if (pfad.endsWith('/quellen') && methode === 'GET') {
      const stichtag = url.searchParams.get('stichtag') ?? ahrenbergRegister({ stichtag: heute ?? SEITE_HEUTE }).zeitpunkt;
      return route.fulfill(json(quellenDerMessstellenBuehne(messstelle.id, stichtag)));
    }
    // Ohne Prozess und Kostenstelle: die Hauptzähler MS-10 und MS-16, und MS-21 (AP-13 IP-6) zeigt nichts Geliehenes.
    const hauptzaehler = ['MS-10', 'MS-16', 'MS-21'].includes(messstelle.kennzeichen);
    if (pfad.endsWith('/prozesse') && methode === 'GET') return route.fulfill(json(hauptzaehler ? ohneProzesse(messstelle) : prozesseVon(messstelle)));
    if (pfad.endsWith('/verteilung') && methode === 'GET') {
      return route.fulfill(json(verteilungGespeichert ?? (hauptzaehler ? ohneVerteilung(messstelle) : verteilungVon(messstelle))));
    }
    if (pfad.endsWith('/verteilung') && methode === 'PUT') {
      const body = req.postDataJSON() as { gueltig_ab: string; zeilen: { kostenstelle_id: string; anteil_prozent: string }[] };
      const alt = verteilungVon(messstelle).anteile.map((a) => {
        const d = new Date(`${body.gueltig_ab}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return { ...a, gueltig_bis: d.toISOString().slice(0, 10) };
      });
      const katalog = kostenstellenAhrenberg();
      verteilungGespeichert = {
        messstelle_id: messstelle.id,
        kennzeichen: messstelle.kennzeichen,
        am: null,
        zustand: null,
        anteile: [
          ...alt,
          ...body.zeilen.map((z, i) => {
            const k = katalog.find((x) => x.id === z.kostenstelle_id)!;
            return {
              id: `${messstelle.kennzeichen}-anteil-neu-${i + 1}`,
              kostenstelle: { id: k.id, kennzeichen: k.kennzeichen },
              name: k.name,
              anteil_prozent: z.anteil_prozent,
              gueltig_ab: body.gueltig_ab,
              gueltig_bis: k.gueltig_bis,
              endet_mit_kostenstelle: k.gueltig_bis !== null,
            };
          }),
        ],
      };
      return route.fulfill(json(verteilungGespeichert));
    }
    if (pfad.endsWith('/aenderungen')) {
      const protokoll = pfad.includes(MS_IDS.ms10) || pfad.includes(MS_IDS.ms16) || pfad.includes(MS_IDS.ms21)
        ? protokollMs10()
        : pfad.includes(MS_IDS.ms06)
        ? protokollMs06()
        : angelegt
          ? protokollMs08Angelegt()
          : gespeichert
          ? protokollMs08OrtGeplant()
          : protokollMs08Vorher();
      return route.fulfill(json(protokoll));
    }
    if (pfad.endsWith('/ort') && methode === 'PUT') {
      gespeichert = true;
      return route.fulfill(json(ms08OrtGeplant()));
    }
    const werte = /^\/api\/v1\/messstellen\/([^/]+)\/werte$/.exec(pfad);
    if (werte && methode === 'GET') {
      const ablehnung = werteAblehnung(decodeURIComponent(werte[1]), url.searchParams);
      if (ablehnung) return route.fulfill(json(ablehnung.body, ablehnung.status));
      const antwort = werteAntwort(decodeURIComponent(werte[1]), url.searchParams, heute ?? SEITE_HEUTE, f8);
      if (!antwort) return route.fulfill(json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
      return route.fulfill(json(berechnet && url.searchParams.get('raster') === 'monat' ? alsBerechnet(antwort) : antwort));
    }
    if (/^\/api\/v1\/messstellen\/[^/]+$/.test(pfad) && methode === 'GET') return route.fulfill(json(messstelle));
    return route.fulfill(json({ code: 'nicht_gefunden', message: 'nicht gestellt' }, 404));
  });
  return gesendet;
}

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-mss *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = document.querySelector('.vp-modal .dbody') as HTMLElement | null;
    return {
      dokument: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
      draussen,
      inhaltHoehe: koerper ? koerper.scrollHeight : null,
      sichtHoehe: koerper ? koerper.clientHeight : null,
    };
  }, breite);
}

async function ruhig(page: Page) {
  const modal = page.locator('.vp-modal');
  if (await modal.count()) await expect(modal.last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function messeUndFotografiere(page: Page, breite: number, name: string, { dialog = false } = {}) {
  await ruhig(page);
  const m = await messe(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  const datei = `${name}-${breite}`;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${datei}.json`), JSON.stringify(m, null, 2));
  if (!dialog) {
    await page.screenshot({ path: join(BILDER, `${datei}.png`), fullPage: true });
    return;
  }
  // Der ganze Dialog: das Fenster so hoch wie sein Inhalt, damit nichts im Scrollbereich fehlt.
  const vorher = page.viewportSize()!;
  if (m.inhaltHoehe && m.sichtHoehe && m.inhaltHoehe > m.sichtHoehe) {
    await page.setViewportSize({ width: breite, height: vorher.height + (m.inhaltHoehe - m.sichtHoehe) + 40 });
    await ruhig(page);
  }
  await page.screenshot({ path: join(BILDER, `${datei}.png`) });
  await page.setViewportSize(vorher);
}

/** Die Liste DIESES Felds — eine eben geschlossene blendet noch aus und steht solange im DOM. */
async function listeVon(page: Page, feld: Locator): Promise<Locator> {
  await feld.click();
  const id = await feld.getAttribute('id');
  return id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
}

async function waehleTag(page: Page, dialog: Locator, iso: string) {
  const feld = dialog.getByRole('combobox', { name: 'Gilt ab *' });
  const [t, m, j] = ((await feld.textContent()) ?? '').match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 40 && !(await tag.isVisible()); i++) await page.getByRole('button', { name: richtung }).click();
  await tag.click();
}

const breiteFuer = (projekt: string) => (projekt.startsWith('mobile') ? 375 : 1440);

test('R2 · MS-06: drei Zuordnungs-Karten und das Protokoll nach der Eintragung, ohne Querlauf', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  await expect(page.getByRole('heading', { level: 1, name: 'Spritzguss SG01–SG06' })).toBeVisible();
  await expect(page.getByTestId('quelle-karte')).toContainText('Unterzähler Spritzguss SG01–SG06');
  const ort = page.getByTestId('karte-ort');
  await expect(ort.getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024')).toBeVisible();
  await expect(page.getByTestId('karte-elektrisch').getByText('Unterzähler von MS-01')).toBeVisible();
  await expect(page.getByTestId('karte-organisation').getByText('4100 Spritzguss · 100 %')).toBeVisible();
  await expect(page.getByText('Sortiert danach, wann die Änderung eingetragen wurde.')).toBeVisible();
  await expect(page.locator('.vp-befehl').first()).toContainText('Quelle gebunden: Z-5a');
  await messeUndFotografiere(page, breite, 'r2-ms06');
});

test('F10 · Verteilen: 70/30 ergibt live 100 %, 90 % sperrt das Eintragen mit dem Fehlersatz', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  await page.getByRole('button', { name: 'Kostenstellen ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kostenstellen ändern' });
  await dialog.getByLabel('Anteil (%)').first().fill('70');
  await dialog.getByRole('button', { name: 'Kostenstelle hinzufügen' }).click();
  const liste = await listeVon(page, dialog.getByRole('combobox', { name: 'Kostenstelle 2' }));
  await liste.getByRole('option', { name: /^4200 Montage/ }).click();

  await expect(dialog.getByTestId('zuordnung-summe')).toHaveText('Summe: 100 % ✔');
  await expect(dialog.getByRole('button', { name: 'Verteilung ab 20.10.2026 eintragen' })).toBeEnabled();
  await messeUndFotografiere(page, breite, 'f10-verteilung-70-30', { dialog: true });

  await dialog.getByLabel('Anteil (%)').nth(1).fill('20');
  await expect(dialog.getByTestId('zuordnung-summe')).toHaveText(
    'Summe: 90 % · 10 % fehlen — eine Verteilung ist vollständig oder existiert nicht.',
  );
  await expect(dialog.getByRole('button', { name: 'Verteilung ab 20.10.2026 eintragen' })).toBeDisabled();
  await messeUndFotografiere(page, breite, 'f10-verteilung-90-gesperrt', { dialog: true });
  expect(gesendet).toEqual([]);
});

test('F12 · das Ziel 9000 zeigt sein gemeinsames Ende mit der Kostenstelle', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  await page.getByRole('button', { name: 'Kostenstellen ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kostenstellen ändern' });
  const liste = await listeVon(page, dialog.getByRole('combobox', { name: 'Kostenstelle 1' }));
  await liste.getByRole('option', { name: /^9000 Infrastruktur/ }).click();
  await expect(dialog.getByText('endet mit Kostenstelle 9000 am 31.12.2026')).toBeVisible();
  await expect(dialog.getByTestId('zuordnung-summe')).toHaveText('Summe: 100 % ✔');
  await messeUndFotografiere(page, breite, 'f12-ziel-endet', { dialog: true });
});

test('F13 · neue Verteilung ab 15.01.2027: rückwirkend fünf Tage, danach zwei Fassungen', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page, { heute: '2027-01-20' });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  await page.getByRole('button', { name: 'Kostenstellen ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kostenstellen ändern' });
  await dialog.getByLabel('Anteil (%)').first().fill('60');
  await dialog.getByRole('button', { name: 'Kostenstelle hinzufügen' }).click();
  const liste = await listeVon(page, dialog.getByRole('combobox', { name: 'Kostenstelle 2' }));
  await liste.getByRole('option', { name: /^4200 Montage/ }).click();
  await waehleTag(page, dialog, '2027-01-15');

  await expect(dialog.getByTestId('zuordnung-summe')).toHaveText('Summe: 100 % ✔');
  await expect(dialog.getByTestId('zuordnung-folgen')).toContainText('rückwirkend (5 Tage)');
  await expect(dialog.getByTestId('zuordnung-folgen')).toContainText('Für die Tage vom 15.01.2027 bis 19.01.2027 gilt das nachträglich.');
  await messeUndFotografiere(page, breite, 'f13-verteilung-neu', { dialog: true });

  await dialog.getByRole('button', { name: 'Verteilung ab 15.01.2027 eintragen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const organisation = page.getByTestId('karte-organisation');
  await expect(organisation.getByText('Fassungen (2)')).toBeVisible();
  await organisation.getByText('Fassungen (2)').click();
  await expect(organisation).toContainText('Fassung 2');
  await expect(organisation).toContainText('Fassung 1');
  await expect(organisation).toContainText('01.10.2026 bis 14.01.2027');
  await messeUndFotografiere(page, breite, 'f13-fassungen');
  expect(gesendet.map((g) => `${g.methode} ${g.pfad}`)).toEqual([`PUT /api/v1/messstellen/${MS_IDS.ms06}/verteilung`]);
});

test('Z4 · MS-08: Ort ändern ab 01.03.2027 → geplant → gespeichert, Historie aus der Antwort', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms08}`);

  await expect(page.getByRole('heading', { level: 1, name: 'Kühlung Kaltwassersatz' })).toBeVisible();
  await expect(page.getByTestId('karte-ort').getByText('Halle 1 Süd')).toBeVisible();
  await messeUndFotografiere(page, breite, 'z4-ms08-vorher');

  await page.getByRole('button', { name: 'Ort ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ort ändern' });
  await expect(dialog).toBeVisible();
  const ortListe = await listeVon(page, dialog.getByRole('combobox', { name: 'Neuer Ort *' }));
  await ortListe.getByRole('option', { name: /^Halle 2 Montage/ }).click();
  await waehleTag(page, dialog, '2027-03-01');
  const folgen = dialog.getByTestId('zuordnung-folgen');
  await expect(folgen).toContainText('geplant');
  await expect(folgen).toContainText('Ab 01.03.2027 gehört MS-08 zu Halle 2 Montage (B-3); bis 28.02.2027 bleibt es bei Halle 1 Süd (B-2).');
  await expect(dialog.getByText('Halle 1 · Werk Ahrenberg · seit 12.03.2024 — endet 28.02.2027')).toBeVisible();
  await messeUndFotografiere(page, breite, 'z4-ort-aendern-geplant', { dialog: true });

  await dialog.getByRole('button', { name: 'Ort ab 01.03.2027 eintragen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ort = page.getByTestId('karte-ort');
  await expect(ort.getByText('Ort ab 01.03.2027 eingetragen · geplant.')).toBeVisible();
  await expect(ort.getByText('ab 01.03.2027: Halle 2 Montage')).toBeVisible();
  await ort.getByText('Historie (2)').click();
  await expect(ort.locator('.vp-mss-h').first()).toContainText('Halle 2 Montage');
  await expect(page.locator('.vp-befehl').first()).toContainText('Ort zugeordnet: B-3');
  await expect(page.locator('.vp-befehl').first()).toContainText('angekündigt');
  await messeUndFotografiere(page, breite, 'z4-ms08-nachher');

  expect(gesendet.map((g) => `${g.methode} ${g.pfad}`)).toEqual([`PUT /api/v1/messstellen/${MS_IDS.ms08}/ort`]);
  expect(gesendet[0].body).toEqual({ kennzeichen: 'B-3', gueltig_ab: '2027-03-01' });
});

test('rückwirkend · MS-08 am 01.10.2026: Ort ab 12.03.2024 trägt „rückwirkend (933 Tage)“, bevor gespeichert ist', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const gesendet = await cloud(page, { angelegt: true });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms08}`);

  await expect(page.getByTestId('karte-ort').getByText('Kein Ort zugeordnet')).toBeVisible();
  await page.getByRole('button', { name: 'Ort ändern ab …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ort ändern' });
  await expect(dialog).toBeVisible();
  const ortListe = await listeVon(page, dialog.getByRole('combobox', { name: 'Neuer Ort *' }));
  await ortListe.getByRole('option', { name: /^Halle 1 Süd/ }).click();
  await waehleTag(page, dialog, '2024-03-12');
  const folgen = dialog.getByTestId('zuordnung-folgen');
  await expect(folgen).toContainText('rückwirkend (933 Tage)');
  await expect(folgen).toContainText('Für die Tage vom 12.03.2024 bis 30.09.2026 gilt das nachträglich.');
  await messeUndFotografiere(page, breite, 'rueckwirkend-ort', { dialog: true });
  expect(gesendet).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------------
// UEMS AP-13 IP-3 · die Werte an der Messstelle: O14 (Zone und 25-Stunden-Tag) und O13 (der Einstieg aus dem Register)
// ------------------------------------------------------------------------------------------------------------------

/** Ein Bild nur des Abschnitts „Werte“ — für die Ansicht, neben dem Bild der ganzen Seite. */
async function werteBild(werte: Locator, breite: number, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await werte.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

const werteZeile = (werte: Locator, name: string) =>
  werte.getByTestId('werte-zeile').filter({ has: werte.page().locator('.vp-wk-zeile-name', { hasText: new RegExp(`^${name}$`) }) });

const adresse = (hash: string) => new RegExp(`${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

test('O14 · MS-06 am 26.10.2026: „Werte“ unter dem Kopf — Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg), der 25-Stunden-Tag mit MESZ und MEZ', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-10-26' });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByRole('heading', { level: 2, name: 'Werte' })).toBeVisible();
  // Claudia öffnet MS-06 am 26.10.2026 — die Sektion zeigt den Vortag, den Sonntag der Zeitumstellung.
  const karte = werte.getByTestId('werte-karte');
  await expect(karte).toContainText(/720\skWh/);
  await expect(karte).toContainText('25 Stunden (Zeitumstellung)');
  await expect(karte.getByTestId('werte-fassung')).toHaveText('endgültig');
  await expect(werte.getByTestId('werte-zone')).toHaveText('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)');
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(25);
  await expect(werteZeile(werte, '02:00–03:00 MESZ')).toHaveCount(1);
  await expect(werteZeile(werte, '02:00–03:00 MEZ')).toHaveCount(1);
  await expect(werteZeile(werte, '02:00–03:00 MEZ')).toContainText(/28,8\skWh/);
  // AP-13 IP-4: der Verlauf in Viertelstunden — 100 am 25-Stunden-Tag (E5; befunde-ip1: nicht 25), die doppelte Stunde
  // erkennt man an der Beschriftung, nicht an einer Farbe.
  const verlauf = werte.getByTestId('verlauf');
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(100);
  await expect(verlauf.locator('[data-zustand="vollstaendig"]')).toHaveCount(100);
  await expect(verlauf.getByTestId('verlauf-legende')).toHaveText('vollständig');
  await expect(verlauf).toContainText(/So 25\.10\.2026: 720\skWh · vollständig · endgültig/);

  // Unter dem Kopf, vor den Zuordnungs-Karten — EIN Ort für Stammdaten und Zahlen (E9).
  const unten = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().bottom);
  const oben = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top);
  expect(await oben(werte)).toBeGreaterThanOrEqual(await unten(page.locator('.vp-mss-kopf')));
  expect(await oben(page.getByTestId('karte-ort'))).toBeGreaterThan(await oben(werte));
  if (breite === 1440) {
    // Am Rechner steht die Liste neben der Karte, nicht 1 100 px darunter.
    const k = (await karte.boundingBox())!;
    const l = (await werte.locator('.vp-wk-liste').boundingBox())!;
    expect(l.x).toBeGreaterThan(k.x + k.width);
  }
  await messeUndFotografiere(page, breite, 'o14-ms06-werte');
  await werteBild(werte, breite, 'o14-werte');
  if (BILDER && breite === 1440) {
    // Vorschau der NICHT gebauten Variante B (eine Spalte wie im Dialog) — nur als Bild, nicht im Code.
    const stil = await page.addStyleTag({ content: '.vp-mss-werte .vp-wk { grid-template-columns: minmax(0, 40rem) !important; }' });
    await werteBild(werte, breite, 'variante-b-eine-spalte');
    await stil.evaluate((el) => el.remove());
  }
});

test('O13 · Einstieg: vom Register in die Werte — am Rechner „Letzter Wert“ und Zeilenmenü „Werte“, am Telefon die ganze Karte', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto('/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen');
  // Heute ist laut Register der 20.10.2026 — der Einstieg öffnet den letzten ganzen Tag.
  const ziel = adresse(`#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-19`);
  const werte = page.getByTestId('werte');

  if (breite === 1440) {
    const zeile = page.locator('.vp-ms-tabelle tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^MS-06$/ }) });
    const letzterWert = zeile.getByRole('button', { name: /^Werte MS-06:/ });
    await expect(letzterWert).toBeVisible();
    await messeUndFotografiere(page, breite, 'o13-register');
    await letzterWert.click();
    await expect(page).toHaveURL(ziel);
    await expect(werte.getByTestId('werte-karte')).toContainText(/691\skWh/);
    await page.goBack();
    await zeile.getByRole('button', { name: 'Aktionen' }).click();
    await expect(page.getByRole('menuitem', { name: 'Werte' })).toBeVisible();
    await messeUndFotografiere(page, breite, 'o13-zeilenmenue');
    await page.getByRole('menuitem', { name: 'Werte' }).click();
  } else {
    const karte = page.locator('.vp-ms-karte').filter({ has: page.locator('.vp-ms-kz', { hasText: /^MS-06$/ }) });
    await expect(karte).toHaveClass(/is-werte/);
    await messeUndFotografiere(page, breite, 'o13-register');
    // Getippt wird unten in die Karte, nicht auf den Namen: die ganze Karte ist der Einstieg.
    const box = (await karte.boundingBox())!;
    await karte.click({ position: { x: box.width / 2, y: box.height - 16 } });
  }
  await expect(page).toHaveURL(ziel);
  await expect(werte.getByTestId('werte-karte')).toContainText(/691\skWh/);
  await expect(werte.getByTestId('werte-zone')).toHaveText('Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)');
  await expect(werte).toBeInViewport();
  await messeUndFotografiere(page, breite, 'o13-seite-werte');

  // Eine neue Wahl ersetzt die Adresse ohne Verlaufseintrag: „zurück“ führt ins Register, nicht auf den Vortag.
  await werte.getByRole('button', { name: 'Vorheriger Zeitraum' }).click();
  await expect(werte.getByTestId('werte-karte')).toContainText('18.10.2026');
  await expect(page).toHaveURL(adresse(`#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-18`));
  await page.goBack();
  await expect(page).toHaveURL(/#\/portfolio\/messstellen$/);
  await expect(page.getByTestId('messstellen')).toBeVisible();
});

test('Version der Adresse · MS-10 am 03.11.2026 (F21): „Sie sehen Version 3 — heute die neueste“; Version 1 sagt, welche heute gilt', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  const anfragen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/werte?')) anfragen.push(new URL(r.url()).search);
  });
  await cloud(page, { heute: '2026-11-20' });
  const seite = `/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}`;
  await page.goto(`${seite}?periode=2026-11-03&version=3`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByTestId('werte-version')).toHaveText('Sie sehen Version 3 — heute die neueste');
  await expect(werte.getByTestId('werte-karte')).toContainText('3 Versionen');
  expect(anfragen).toContain('?raster=tag&von=2026-11-03&bis=2026-11-03&version=3');
  expect(anfragen).toContain('?raster=stunde&von=2026-11-03&bis=2026-11-03');
  await messeUndFotografiere(page, breite, 'version-neueste');
  await werteBild(werte, breite, 'version-neueste');

  await page.goto(`${seite}?periode=2026-11-03&version=1`);
  await page.reload();
  const hinweis = werte.getByTestId('werte-version');
  await expect(hinweis).toContainText('Sie sehen Version 1 — heute gilt Version 3');
  await messeUndFotografiere(page, breite, 'version-frueher');
  await werteBild(werte, breite, 'version-frueher');
  await hinweis.getByRole('button', { name: 'Neueste zeigen' }).click();
  await expect(hinweis).toHaveCount(0);
  await expect(werte.getByTestId('werte-karte')).toContainText('3 Versionen');
  await expect(page).toHaveURL(adresse(`${MS_IDS.ms10}?periode=2026-11-03`));
});

// ------------------------------------------------------------------------------------------------------------------
// UEMS AP-13 IP-4 (= AP-08 IP-10) · der Verlauf: O1 (die Lücke als Fläche mit Satz) und E5 (die vier Zeiträume)
// ------------------------------------------------------------------------------------------------------------------

test('O1 · MS-10 am 04.11.2026: der Verlauf des 03.11. — die Lücke als Fläche ohne Balken, der Marker mit dem Satz des Vokabulars, Tipp auf 14:15 und 17:30', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-04', f8: true });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms10}`);

  // WAS gemessen wurde, WELCHER Zeitraum und WARUM die Zahl eingeschränkt ist — die Karte des Tages …
  const werte = page.getByTestId('werte');
  const karte = werte.getByTestId('werte-karte');
  await expect(karte).toContainText(/2\.304\skWh/);
  await expect(karte.getByTestId('werte-verlauf')).toHaveText(/^Verlauf 85\s% · 1 Lücke$/);
  await expect(werte.getByTestId('werte-zone')).toHaveText(/^Zeiten in Europe\/Berlin \(Zeitzone des Standorts/);

  // … und darunter der Verlauf: 96 Viertelstunden, 13 ohne Werte als EINE Fläche, darin kein Balken — keine Null.
  const verlauf = werte.getByTestId('verlauf');
  await expect(verlauf).toContainText(/Di 03\.11\.2026: 2\.304\skWh · vollständig · vorläufig/);
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(96);
  await expect(verlauf.locator('[data-zustand="keine_werte"]')).toHaveCount(13);
  await expect(verlauf.getByTestId('verlauf-luecke')).toHaveCount(1);
  const flaeche = (await verlauf.getByTestId('verlauf-luecke').boundingBox())!;
  const balkenInDerFlaeche = await verlauf.locator('.vp-mv-balken').evaluateAll(
    (els, f) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > f.x + 0.5 && r.left < f.x + f.width - 0.5;
      }).length,
    flaeche,
  );
  expect(balkenInDerFlaeche).toBe(0);
  await expect(verlauf.getByTestId('verlauf-legende')).toHaveText(/vollständig\s*unvollständig\s*keine Werte/);
  await expect(verlauf.getByTestId('verlauf-marke')).toHaveCount(1);
  await expect(verlauf.getByTestId('verlauf-ereignis')).toHaveCount(1);
  await expect(verlauf.getByTestId('verlauf-ereignis')).toContainText('Lücke von 03.11.2026 14:00 bis 17:31 — nie als 0 gerechnet');
  // Die Marke steht am Beginn des Ereignisses (14:00), die Fläche beginnt eine Viertelstunde später.
  const kreis = (await verlauf.locator('[data-testid="verlauf-marke"] circle').boundingBox())!;
  const um1400 = (await verlauf.locator('[data-von="2026-11-03T14:00:00+01:00"]').boundingBox())!;
  expect(Math.abs(kreis.x + kreis.width / 2 - um1400.x)).toBeLessThan(1.5);
  expect(flaeche.x).toBeGreaterThan(um1400.x + um1400.width - 1);
  await messeUndFotografiere(page, breite, 'o1-ms10-verlauf');
  await werteBild(werte, breite, 'o1-verlauf');

  // Ein Tipp öffnet die Karte der Viertelstunde — ihre Zeilen kommen aus der Route.
  await verlauf.locator('[data-von="2026-11-03T14:15:00+01:00"]').click();
  const schritt = verlauf.getByTestId('verlauf-schritt-karte');
  await expect(schritt).toContainText('14:15–14:30');
  await expect(schritt).toContainText('keine Werte');
  await expect(schritt).toContainText('0 von 15 Werten');
  await verlauf.locator('[data-von="2026-11-03T17:30:00+01:00"]').click();
  await expect(schritt).toContainText('17:30–17:45');
  await expect(schritt).toContainText(/22,4\skWh/);
  await expect(schritt).toContainText('unvollständig (Menge aus Zählerständen)');
  await expect(schritt).toContainText(/Verlauf 93\s% · 14 von 15 Werten/);
  await expect(schritt).toContainText('Anfang nicht gemessen (kein Stand an der Periodengrenze)');
  const herkunft = verlauf.getByTestId('herkunfts-karte');
  await expect(herkunft).toContainText('Herkunft');
  await expect(herkunft).toContainText('14 × gut');
  await expect(herkunft).toContainText('14 von 15');
  await expect(herkunft).toContainText('Box Halle 2');
  await expect(verlauf).toContainText('Rohwerte (60 s) bis 20.10.2026 verfügbar — ab hier Viertelstundenwerte.');
  await expect(verlauf.getByRole('button', { name: 'Rohwert' })).toBeDisabled();
  // Tippflächen: ‹ › je mindestens 44 px, das Bild selbst ist über seine volle Höhe Ziel.
  const vorher = verlauf.getByRole('button', { name: 'Vorherige Viertelstunde' });
  for (const knopf of [vorher, verlauf.getByRole('button', { name: 'Nächste Viertelstunde' })]) {
    const box = (await knopf.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  expect((await verlauf.locator('.vp-mv-bild').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Den Tooltip gibt es nur mit der Maus (K7) — am Telefon-Bild steht er nicht, am Rechner schon.
  if (breite === 375) await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o1-ms10-schritt');
  await werteBild(werte, breite, 'o1-schritt');
  await vorher.click();
  await expect(schritt).toContainText('17:15–17:30');
});

test('E5 · MS-06: Tag · Woche · Monat · Jahr im Raster der Route — die Woche ohne eigene Zahl, das Jahr mit „keine Werte“ bis September', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-05' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-25`);
  const werte = page.getByTestId('werte');
  const verlauf = werte.getByTestId('verlauf');
  const wahl = werte.locator('.vp-wk-zeitwahl');
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(100);

  await wahl.getByRole('tab', { name: 'Woche' }).click();
  await expect(page).toHaveURL(adresse(`${MS_IDS.ms06}?periode=2026-W43`));
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(169);
  await expect(werte.getByTestId('werte-karte')).toHaveCount(0);
  await expect(verlauf).toContainText('Für eine Woche wird keine eigene Zahl gebildet — die Tage stehen einzeln in der Liste.');
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(7);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'e5-woche');
  await werteBild(werte, breite, 'e5-woche');

  await wahl.getByRole('tab', { name: 'Monat' }).click();
  await expect(page).toHaveURL(adresse(`${MS_IDS.ms06}?periode=2026-10`));
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(31);
  await expect(verlauf).toContainText(/Oktober 2026: 55\.100\skWh · vollständig · vorläufig/);
  await page.mouse.move(0, 0);
  await werteBild(werte, breite, 'e5-monat');

  await wahl.getByRole('tab', { name: 'Jahr' }).click();
  await expect(page).toHaveURL(adresse(`${MS_IDS.ms06}?periode=2026`));
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(12);
  await expect(verlauf.getByTestId('verlauf-luecke')).toHaveCount(1);
  await expect(verlauf.getByTestId('verlauf-ereignis')).toContainText('keine Werte von Januar 2026 bis September 2026');
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(12);
  await expect(werte.getByRole('button', { name: 'Nächster Zeitraum' })).toBeDisabled();
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'e5-jahr');
  await werteBild(werte, breite, 'e5-jahr');

  // Neu geladen trägt die Adresse das Jahr — die Sektion öffnet es wieder.
  await page.reload();
  await expect(verlauf.getByTestId('verlauf-schritt')).toHaveCount(12);
});

// ------------------------------------------------------------------------------------------------------------------
// UEMS AP-13 IP-6 · warum eine Zahl fehlt: der Leerzustand ohne Datenquelle (Z4), der Grund-Satz (O16), die Auskunft
// statt einer Fehlermeldung (Z2, V9/O19) und die Nebengrößen (V8). Die Bilder der Ansicht sind die LEERZUSTÄNDE.
// ------------------------------------------------------------------------------------------------------------------

/** Ein Bild nur eines Elements — für die Ansicht, wo der Abschnitt zu hoch wäre. */
async function elementBild(ziel: Locator, breite: number, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await ziel.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

test('Z4 · MS-21 am 04.11.2026 ohne Datenquelle: der Leerzustand statt 24 Strichen — „Quelle zuordnen“ öffnet den Dialog bei „Quelle“', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-04' });
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms21}`);

  const werte = page.getByTestId('werte');
  const leer = werte.getByTestId('werte-leer');
  await expect(leer.getByRole('heading', { name: 'Keine Datenquelle' })).toBeVisible();
  await expect(leer).toContainText(
    'Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.',
  );
  await expect(werte.getByTestId('werte-karte')).toHaveCount(0);
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(0);
  await expect(werte.getByTestId('verlauf')).toHaveCount(0);
  // „Ablesung eintragen“ hat weder Route noch Fläche — kein Knopf ins Leere.
  await expect(leer.getByRole('button', { name: /Ablesung/ })).toHaveCount(0);
  const zuordnen = leer.getByRole('button', { name: 'Quelle zuordnen' });
  expect((await zuordnen.boundingBox())!.height).toBeGreaterThanOrEqual(breite === 375 ? 44 : 32);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'z4-ms21-seite');
  await werteBild(werte, breite, 'z4-ms21-ohne-quelle');

  await zuordnen.click();
  const dialog = page.getByRole('dialog', { name: 'Messstelle bearbeiten' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.vp-step-active .vp-step-label')).toHaveText('Quelle');
});

test('O16 · MS-16 im Oktober 2026 (W5): „—“ mit dem Satz der Route, darunter die 17 Tage ab 15.10. — die Fläche summiert nichts', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-05' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms16}?periode=2026-10`);

  const werte = page.getByTestId('werte');
  const karte = werte.getByTestId('werte-karte');
  await expect(karte.getByTestId('werte-grund')).toHaveText(
    'Die Quelle deckt den Zeitraum nur zum Teil: Netzzähler Lindach (GR-10) gilt seit 15.10.2026 — die gespeicherte Zahl gehört nicht ganz dieser Messstelle.',
  );
  await expect(karte.locator('.vp-wk-zahl')).toHaveText('—');
  await expect(karte).not.toContainText(/9\.100/);
  await expect(werte.getByTestId('werte-zeile')).toHaveCount(31);
  await expect(werte.getByTestId('werte-zeile').filter({ hasText: 'vollständig' })).toHaveCount(17);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o16-ms16-seite');
  await elementBild(karte, breite, 'o16-ms16-karte');
});

/**
 * UEMS AP-13 IP-11 — die Sprünge der Kette an der Messstellen-Welt: D4 (die Karte einer BERECHNETEN Zahl
 * spricht ihre Herkunft und zeigt die Eingänge als Sprünge) und D1 (die Quelle im Register führt zur
 * Komponente auf der Geräte-Seite ihrer Anlage).
 */
test('D4 · die Herkunft einer berechneten Zahl: Formel, Zeitpunkt, Version — und jeder Eingang ein Sprung mit seiner Version', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-05', berechnet: true });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms16}?periode=2026-10`);

  const herkunft = page.getByTestId('werte').getByTestId('werte-herkunft');
  await expect(herkunft).toBeVisible();
  await herkunft.locator('summary').click();
  await expect(herkunft).toContainText('berechnet (Summe) · Formel: Fassung 2');
  await expect(herkunft).toContainText('berechnet am 01.11.2026 00:20');
  const spruenge = herkunft.locator('a');
  await expect(spruenge).toHaveCount(2);
  // D2: Periode der Karte, Version DES EINGANGS — nie die der Zeile.
  await expect(spruenge.nth(0)).toHaveAttribute('href', '#/portfolio/messstellen/MS-12?periode=2026-10&version=2');
  await expect(spruenge.nth(1)).toHaveAttribute('href', '#/portfolio/messstellen/MS-13?periode=2026-10&version=1');
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'ip11-d4-herkunft');
  await elementBild(herkunft, breite, 'ip11-d4-herkunft-block');
});

test('D1 · die Quelle im Register führt zur Komponente auf der Geräte-Seite ihrer Anlage', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  test.skip(breite !== 1440, 'Die Quelle-Spalte steht in der Tabelle des Rechners; am Telefon trägt die Karte sie nicht.');
  await page.setViewportSize({ width: breite, height: 900 });
  await cloud(page);
  await page.goto('/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen');
  const zeile = page.locator('.vp-ms-tabelle tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^MS-06$/ }) });
  const quelle = zeile.locator('a.vp-ms-quelle-sprung');
  await expect(quelle).toHaveText('Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a');
  await expect(quelle).toHaveAttribute('href', /^#\/anlage\/[0-9a-f-]+\/modell\?komponente=[0-9a-f-]+$/);
  await messeUndFotografiere(page, breite, 'ip11-d1-quelle');
});

test('Z2 · gestellt: die Route lehnt den 24.10.2026 ab (400 `nicht_im_raster`) — der Satz des Grundes ohne „Erneut versuchen“; die Zeit-Leiste bleibt der Weg', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-05' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10-24`);

  const werte = page.getByTestId('werte');
  const auskunft = werte.getByTestId('werte-auskunft');
  await expect(auskunft).toHaveText('Der Zeitraum konnte nicht gelesen werden (Beginn liegt nicht auf einer Tagesgrenze). Wählen Sie einen anderen Zeitraum.');
  await expect(werte.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
  await expect(werte.getByText(/konnte nicht geladen werden/)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'z2-ablehnung-seite');
  await werteBild(werte, breite, 'z2-ablehnung');

  // Der nächste Tag ist der 25-Stunden-Tag — die Zeit-Leiste führt heraus.
  await werte.getByRole('button', { name: 'Nächster Zeitraum' }).click();
  await expect(werte.getByTestId('werte-karte')).toContainText(/720\skWh/);
  await expect(auskunft).toHaveCount(0);
});

test('V9/O19 · gestellt: der Oktober 2026 in Version 1 ist nach den Fristen (404 `wert_nicht_mehr_gespeichert`) — der Satz der Route, KEIN Sprung, bis AP-12 IP-16 antwortet', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-05' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms06}?periode=2026-10&version=1`);

  const werte = page.getByTestId('werte');
  const auskunft = werte.getByTestId('werte-auskunft');
  await expect(auskunft).toHaveText('Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre).');
  await expect(auskunft).toHaveAttribute('data-art', 'nicht_mehr_gespeichert');
  await expect(auskunft.getByRole('link')).toHaveCount(0);
  await expect(auskunft.getByRole('button')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o19-frist-seite');
  await werteBild(werte, breite, 'o19-frist');
});

test('V8 · MS-06 am 20.10.2026: die Nebengröße unter den Werten — Wirkleistung mit dem letzten Wert aus der Box, ohne Sprung', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page);
  await page.goto(`/e2e/messstelle-seite.html?id=${MS_IDS.ms06}`);

  const neben = page.getByTestId('werte').getByTestId('werte-nebengroessen');
  await expect(neben.getByRole('heading', { name: 'Weitere Größen' })).toBeVisible();
  await expect(neben.getByRole('listitem')).toHaveText([/^Wirkleistung 148,6\skW · .*10:15 Uhr$/]);
  await expect(neben).toContainText('Letzter Wert aus der Box — Werte und Verlauf gibt es hier nur für Wirkenergie Bezug.');
  await expect(neben.getByRole('link')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'v8-nebengroessen-seite');
  await elementBild(neben, breite, 'v8-nebengroessen');
});

/*
 * ---------------------------------------------------------------------------
 * UEMS AP-13 IP-5 · der Vergleich (E6 = A, VG1–VG5): O11 (Δ-Zeile gegen die eigene Vorperiode, Grund statt 0) und
 * O12 (weitere passende Messstellen nebeneinander, kein Δ dazwischen). Gelesen am 10.12.2026 an MS-10.
 * ---------------------------------------------------------------------------
 */

const MS10_HASH = `/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}?periode=2026-11`;

test('O11 · MS-10 November 2026: „Vorperiode“ legt den Oktober als zweite Reihe ins Bild, die Δ-Zeile steht unter der Karte, `v=` steht in der Adresse', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-12-10' });
  await page.goto(MS10_HASH);

  const werte = page.getByTestId('werte');
  const vergleich = werte.getByTestId('vergleich');
  await expect(werte.getByTestId('werte-karte')).toContainText(/35\.800\skWh/);
  // „aus“ ist die Vorgabe: eine Reihe, keine Δ-Zeile.
  await expect(vergleich.getByRole('tab', { name: 'aus' })).toHaveAttribute('aria-selected', 'true');
  await expect(werte.getByTestId('vergleich-delta')).toHaveCount(0);
  await messeUndFotografiere(page, breite, 'o11-aus-seite');

  await vergleich.getByRole('tab', { name: 'Vorperiode' }).click();
  await expect(page).toHaveURL(adresse('?periode=2026-11&v=vorperiode'));
  const delta = werte.getByTestId('vergleich-delta');
  await expect(delta).toHaveText(/^−1\.100\skWh \(−3,0\s%\) gegenüber Oktober 2026$/);

  // Zwei Reihen im Bild; die zweite trägt ihren Namen in der Legende.
  const balken = werte.getByTestId('verlauf-balken');
  await expect(balken.filter({ has: page.locator(':scope[data-reihe="1"]') }).first()).toBeAttached();
  await expect(werte.getByTestId('verlauf-reihe')).toHaveText(['MS-10 · Netzbezug Halle 2', 'Oktober 2026']);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o11-vorperiode-seite');
  await werteBild(werte, breite, 'o11-vorperiode');
});

test('O11 · „Vorjahr“ ohne Basis: November 2025 liegt vor dem Beginn — der Grund statt einer 0, und keine leere Kurve', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-12-10' });
  await page.goto(MS10_HASH);

  const werte = page.getByTestId('werte');
  await werte.getByTestId('vergleich').getByRole('tab', { name: 'Vorjahr' }).click();
  const delta = werte.getByTestId('vergleich-delta');
  await expect(delta).toHaveText('November 2025: keine Werte — vor Beginn');
  await expect(delta).toHaveAttribute('data-grund', 'vor_bestehen');
  // Nur die eigene Reihe steht im Bild — eine datenlose Vergleichsperiode wird gesagt, nicht gezeichnet (VG5).
  await expect(werte.getByTestId('verlauf-balken').filter({ has: page.locator(':scope[data-reihe="1"]') })).toHaveCount(0);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o11-vorjahr-seite');
  await werteBild(werte, breite, 'o11-vorjahr');
});

test('O11 · der laufende Monat sagt es: Dezember 2026 gegen den vollen November', async ({ page }, info) => {
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-11-20' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}?periode=2026-11&v=vorperiode`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByTestId('vergleich-laufend')).toHaveText('November 2026 läuft — der Vergleich gilt für den bisherigen Zeitraum.');
  await page.mouse.move(0, 0);
  await werteBild(werte, breite, 'o11-laufend');
});

test('O12 · „Weitere Messstelle“: MS-11 daneben, die anderen mit ihrem Grund — zwei Reihen, zwei Karten, KEIN Δ dazwischen', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-12-10' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}?periode=2026-10`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByTestId('werte-karte')).toContainText(/36\.900\skWh/);

  const liste = await listeVon(page, werte.getByRole('combobox', { name: 'Weitere Messstelle' }));
  await expect(liste.getByRole('option', { name: /MS-11/ })).toBeVisible();
  await expect(liste.getByRole('option', { name: /MS-04/ })).toContainText('nicht passend: Laden / Entladen');
  await expect(liste.getByRole('option', { name: /MS-21/ })).toContainText('nicht passend: Volumen in m³');
  await expect(liste.getByRole('option', { name: /MS-03/ })).toContainText('nicht passend: Erzeugung');
  // Die eigene Messstelle steht nicht in der Liste — sie liegt schon im Bild.
  await expect(liste.getByRole('option', { name: /MS-10/ })).toHaveCount(0);
  await messeUndFotografiere(page, breite, 'o12-picker-seite');

  await liste.getByRole('option', { name: /MS-11/ }).click();
  await expect(werte.getByTestId('verlauf-reihe')).toHaveText(['MS-10 · Netzbezug Halle 2', 'MS-11 · Spritzguss SG07–SG10']);
  const karte = werte.getByTestId('vergleich-reihe-karte');
  await expect(karte).toHaveCount(1);
  await expect(karte).toContainText(/22\.400\skWh/);
  // VG4: keine Differenz zwischen zwei Messstellen — und die Fläche sagt, warum.
  await expect(werte.getByTestId('vergleich-kein-delta')).toContainText('Zwischen zwei Messstellen wird kein Unterschied gebildet');
  await expect(werte).not.toContainText('14.500');
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'o12-zwei-reihen-seite');
  await werteBild(werte, breite, 'o12-zwei-reihen');

  // Wieder heraus: eine Reihe, und das Bild trägt nur noch die eigene.
  await werte.getByRole('button', { name: 'MS-11 · Spritzguss SG07–SG10 aus dem Bild nehmen' }).click();
  await expect(werte.getByTestId('vergleich-reihe-karte')).toHaveCount(0);
  await expect(werte.getByTestId('verlauf-balken').filter({ has: page.locator(':scope[data-reihe="1"]') })).toHaveCount(0);
});

test('VG1 · Umschalter UND weitere Reihe: das Bild zeigt die Messstellen, die Δ-Zeile jeder Reihe gilt gegen IHRE Vorperiode', async ({ page }, info) => {
  test.slow();
  const breite = breiteFuer(info.project.name);
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await cloud(page, { heute: '2026-12-10' });
  await page.goto(`/e2e/messstelle-seite.html?wirt=1#/portfolio/messstellen/${MS_IDS.ms10}?periode=2026-11&v=vorperiode`);

  const werte = page.getByTestId('werte');
  await expect(werte.getByTestId('vergleich-delta')).toHaveText(/^−1\.100\skWh/);

  const liste = await listeVon(page, werte.getByRole('combobox', { name: 'Weitere Messstelle' }));
  await liste.getByRole('option', { name: /MS-11/ }).click();

  // Zwei Reihen — die Vergleichsperiode wird NICHT zusätzlich gezeichnet, und die Fläche sagt es.
  await expect(werte.getByTestId('verlauf-reihe')).toHaveText(['MS-10 · Netzbezug Halle 2', 'MS-11 · Spritzguss SG07–SG10']);
  await expect(werte.getByTestId('vergleich-nur-eine-reihe')).toContainText('nur bei einer Messstelle gezeichnet');
  // Beide Δ-Zeilen stehen weiter: MS-10 gegen ihren Oktober, MS-11 gegen ihren.
  await expect(werte.getByTestId('vergleich-reihe-delta')).toHaveText(/^−900\skWh \(−4,0\s%\) gegenüber Oktober 2026$/);
  await page.mouse.move(0, 0);
  await messeUndFotografiere(page, breite, 'vg1-beides-seite');
  await werteBild(werte, breite, 'vg1-beides');
});
