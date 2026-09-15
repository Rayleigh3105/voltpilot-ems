import type { Bericht, BerichtAbzug, BerichtAnstoss, BerichtDetail, BerichtEntwurf, BerichtStand, BerichtStandKurz, MessstelleWerte } from '../api';
import { ApiError } from '../api';
import * as B from '../uemsBericht';
import abzuege from './berichtAbzuege.json';
import { FIXTURE_IDS } from './standorteFixtures';
import { antwort, MS_06, schritt } from './werteKarteFixtures';

/**
 * Antworten der Berichts-Routen (UEMS AP-12 IP-7) für die Welt „Berichte“ (IP-13) — in der FORM von `api.ts`, entlang
 * der Zeitachse des Referenzunternehmens 1.4 (`berichte[]`, `korrekturen[]`):
 *  - 10.11.2026 08:55 Ines Kaltenbach legt BR-2026-0001 an (Entwurf, Datenstand = Anlegen), 09:02 gibt sie Nr. 1 frei;
 *  - 12.11.2026 10:05:33 K-2026-0007 freigegeben → Anstoß an Nr. 1, der Entwurf bildet sich neu (Kaskade);
 *  - 16.11.2026 14:20 Nr. 2 (Revision, Anlass K-2026-0007), Nr. 1 „ersetzt durch Nr. 2“;
 *  - 01.12.2026 MS-12 heißt „Montage Linie M1 (Halle 2)“ (B10, Name heute);
 *  - nach dem 31.10.2036 sind die Oktober-Zeilen weg: `…/werte` antwortet 404 `wert_nicht_mehr_gespeichert` (B16).
 * Die Abzüge sind die Vektor-Abzüge `BR-2026-0001/1` und `/2` (`berichtAbzuege.json`, byte-gleich), die Köpfe und
 * Vermerke spricht `uemsBericht.ts` — `berichtSeite.test.ts` prüft beides gegen `bericht-vectors.json`.
 * Gestellt sind nur die Kennungen (Anstoß) und der Anlege-Zeitpunkt (= Datenstand des ersten Entwurfs, D1).
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const ZONE = 'Europe/Berlin';
export const BR = 'BR-2026-0001';

/** Die Zeitpunkte der Referenzdatei — UTC, wie die Routen sie schreiben. */
export const ZEIT = {
  angelegt: '2026-11-10T07:55:00Z',
  nr1: '2026-11-10T08:02:00Z',
  korrektur: '2026-11-12T09:05:33Z',
  nr2: '2026-11-16T13:20:00Z',
  umbenannt: '2026-11-30T23:00:00Z',
  zeilenWeg: '2036-10-31T23:00:00Z',
} as const;

/** Die Prüfsummen der Vektoren (Regel `kanonisch`, B1). */
export const PRUEFSUMME = {
  1: 'sha256:b79d0fb859e2a84a70c37da5e7e06545b3b4c6c3767a98dec6b67fcba2541f7d',
  2: 'sha256:d2073f76be088dd37208be95df8e57796aac2fdfb295da702e79f77afb285b18',
} as const;

export const ABZUG_NR1 = abzuege['BR-2026-0001/1'] as unknown as BerichtAbzug;
export const ABZUG_NR2 = abzuege['BR-2026-0001/2'] as unknown as BerichtAbzug;

const ANSTOSS_ID = 'c0de0000-0000-4000-8000-00000000b001';
const INES = 'Ines Kaltenbach';
const ab = (jetzt: number, zeit: string): boolean => jetzt >= Date.parse(zeit);

export const berichtAm = (jetzt: number): Bericht => {
  const kopf = {
    kennung: BR,
    vorlage: 'monatsbericht_standort',
    vorlage_fassung: 1,
    geltung_art: 'standort' as const,
    geltung_id: FIXTURE_IDS.st1,
    geltung_name: 'Werk Ahrenberg',
    zeitraum_art: 'monat' as const,
    zeitraum: '2026-10',
    zeitraum_text: B.zeitraum('monat', '2026-10', ZONE).bezeichnung,
    zeitzone: ZONE,
    angelegt_von: { name: INES, rolle: null },
    angelegt_am: ZEIT.angelegt,
    archiviert_am: null,
  };
  if (ab(jetzt, ZEIT.nr2)) {
    return { ...kopf, stand_zeichen: 'berichtsstand', stand_text: B.berichtsstand(2), neueste_nr: 2, entwurf_datenstand: ZEIT.korrektur };
  }
  if (ab(jetzt, ZEIT.korrektur)) {
    return {
      ...kopf,
      stand_zeichen: 'revision_noetig',
      stand_text: B.revisionNoetig(B.anlass('K-2026-0007')),
      neueste_nr: 1,
      entwurf_datenstand: ZEIT.korrektur,
    };
  }
  if (ab(jetzt, ZEIT.nr1)) {
    return { ...kopf, stand_zeichen: 'berichtsstand', stand_text: B.berichtsstand(1), neueste_nr: 1, entwurf_datenstand: ZEIT.angelegt };
  }
  return { ...kopf, stand_zeichen: 'entwurf', stand_text: B.entwurf(ZEIT.angelegt, ZONE), neueste_nr: null, entwurf_datenstand: ZEIT.angelegt };
};

const staendeAm = (jetzt: number): BerichtStandKurz[] => [
  ...(ab(jetzt, ZEIT.nr1)
    ? [
        {
          nr: 1,
          datenstand: ZEIT.angelegt,
          freigegeben_am: ZEIT.nr1,
          freigegeben_von: { name: INES, rolle: 'energiemanager' },
          pruefsumme: PRUEFSUMME[1],
          ersetzt_durch_nr: ab(jetzt, ZEIT.nr2) ? 2 : null,
          anlass_anstoss_id: null,
        },
      ]
    : []),
  ...(ab(jetzt, ZEIT.nr2)
    ? [
        {
          nr: 2,
          datenstand: ZEIT.korrektur,
          freigegeben_am: ZEIT.nr2,
          freigegeben_von: { name: INES, rolle: 'energiemanager' },
          pruefsumme: PRUEFSUMME[2],
          ersetzt_durch_nr: null,
          anlass_anstoss_id: ANSTOSS_ID,
        },
      ]
    : []),
];

const anstoesseAm = (jetzt: number): BerichtAnstoss[] =>
  ab(jetzt, ZEIT.korrektur)
    ? [
        {
          id: ANSTOSS_ID,
          nr: 1,
          art: 'korrektur_freigegeben',
          anlass_kennung: 'K-2026-0007',
          anlass_fassung: null,
          anlass_text: B.anlass('K-2026-0007'),
          erkannt_am: ZEIT.korrektur,
          zustand: ab(jetzt, ZEIT.nr2) ? 'erledigt' : 'offen',
          erledigt_durch_nr: ab(jetzt, ZEIT.nr2) ? 2 : null,
          verworfen_begruendung: null,
          verworfen_von: null,
          verworfen_am: null,
        },
      ]
    : [];

export const berichteAm = (jetzt: number): { berichte: Bericht[] } => ({ berichte: [berichtAm(jetzt)] });

export const detailAm = (jetzt: number): BerichtDetail => ({ bericht: berichtAm(jetzt), staende: staendeAm(jetzt), anstoesse: anstoesseAm(jetzt) });

export const entwurfAm = (jetzt: number): BerichtEntwurf => {
  const kaskade = ab(jetzt, ZEIT.korrektur);
  const datenstand = kaskade ? ZEIT.korrektur : ZEIT.angelegt;
  return {
    kennung: BR,
    datenstand,
    gebildet_von: kaskade ? 'kaskade' : 'anlegen',
    neu_gebildet: false,
    pruefsumme: kaskade ? PRUEFSUMME[2] : PRUEFSUMME[1],
    kopf: B.kopf(datenstand, ZONE, null),
    teilansicht: null,
    abzug: kaskade ? ABZUG_NR2 : ABZUG_NR1,
  };
};

const nichtGefunden = (nr: number, jetzt: number): ApiError => {
  const neueste = staendeAm(jetzt).at(-1) ?? null;
  const satz = B.standGibtEsNicht(nr, neueste, ZONE);
  return new ApiError(404, satz, { code: 'stand_gibt_es_nicht', message: satz });
};

export const standAm = (nr: number, jetzt: number): BerichtStand => {
  const s = staendeAm(jetzt).find((x) => x.nr === nr);
  if (!s) throw nichtGefunden(nr, jetzt);
  const abzug = (nr === 1 ? ABZUG_NR1 : ABZUG_NR2) as unknown as { kopf: { darstellung: Record<string, unknown>; regelwerk: Record<string, unknown> } };
  return {
    kennung: BR,
    nr,
    datenstand: s.datenstand,
    freigegeben_am: s.freigegeben_am,
    freigegeben_von: s.freigegeben_von,
    pruefsumme: s.pruefsumme,
    pruefsumme_geprueft: true,
    ersetzt_durch_nr: s.ersetzt_durch_nr,
    anlass_anstoss_id: s.anlass_anstoss_id,
    vorlage_fassung: 1,
    kopf: B.kopf(s.datenstand, ZONE, { nr, freigegeben_am: s.freigegeben_am, freigegeben_von: s.freigegeben_von.name }),
    teilansicht: null,
    darstellung: abzug.kopf.darstellung,
    regelwerk: abzug.kopf.regelwerk,
    abzug: nr === 1 ? ABZUG_NR1 : ABZUG_NR2,
  };
};

/** B10: der Name heute — ab dem 01.12.2026 heißt MS-12 „Montage Linie M1 (Halle 2)“. */
export const UMBENENNUNG = { kennzeichen: 'MS-12', vorher: 'Montage Linie M1', heute: 'Montage Linie M1 (Halle 2)' } as const;

export const nameHeuteAm = (jetzt: number, kennzeichen: string, bisher: string | null): string | null =>
  kennzeichen === UMBENENNUNG.kennzeichen && ab(jetzt, ZEIT.umbenannt) ? UMBENENNUNG.heute : bisher;

type AbzugWertRoh = { quelle: string; menge: number; menge_art?: string; zustand: MessstelleWerte['werte'][number]['zustand']; abdeckung_prozent: number; kennzeichen: string[]; endgueltig_ab: string; version: number };

/**
 * `GET /api/v1/messstellen/{kennzeichen}/werte?raster=monat` für den Oktober 2026, wie er HEUTE gelesen wird: vor der
 * Korrektur Version 1, danach die Zahl von Nr. 2 (MS-12 6 040 kWh, Version 2); nach den Fristen 404 (B16).
 */
export const heutigeWerteAm = (kennzeichen: string, jetzt: number): MessstelleWerte => {
  if (ab(jetzt, ZEIT.zeilenWeg)) {
    const satz = B.wertNichtMehrGespeichert({ art: 'monat', schluessel: '2026-10' }, null, ZONE);
    throw new ApiError(404, satz, { code: 'wert_nicht_mehr_gespeichert', message: satz });
  }
  const quelle = (ab(jetzt, ZEIT.korrektur) ? ABZUG_NR2 : ABZUG_NR1) as unknown as { werte: AbzugWertRoh[] };
  const w = quelle.werte.find((x) => x.quelle === kennzeichen && !x.menge_art);
  const von = '2026-10-01T00:00:00+02:00';
  const bis = '2026-11-01T00:00:00+01:00';
  const ms = { ...MS_06, id: `6a0e1d4c-0000-4000-8000-0000000000${kennzeichen.slice(3)}`, kennzeichen, name: nameHeuteAm(jetzt, kennzeichen, null) ?? kennzeichen };
  if (!w) return antwort(ms, 'monat', von, bis, [schritt({ von, bis })]);
  return antwort(ms, 'monat', von, bis, [
    schritt({
      von,
      bis,
      stunden: 745,
      menge: w.menge,
      zustand: w.zustand,
      kennzeichen: w.kennzeichen,
      abdeckung_prozent: w.abdeckung_prozent,
      fassung: 'endgueltig',
      endgueltig_ab: w.endgueltig_ab,
      version: w.version,
    }),
  ]);
};
