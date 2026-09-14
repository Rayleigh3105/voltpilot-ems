/**
 * Antworten der Route „Werte je Messstelle“ (AP-08 IP-9) für die Tages- und
 * Monatskarte (IP-11) — aus dem Referenzunternehmen Ahrenberg, in der FORM der
 * OpenAPI `MessstelleWerte`. Genutzt von `uemsWerteKarte.test.ts` (dort gegen
 * `verbrauch-vectors.json` gegengeprüft) und von der E2E-Bühne `e2e/tageskarte`.
 *
 * Beschriftung und Tagesdauer setzt hier — wie in der Route — der
 * Ergebnis-Vertrag (`raster`, `tagesdauer`); die Zahlen sind die der Fälle
 * F8, F13, F14 und F16. Nie ins Produktionsbündel importieren.
 */

import type { MessstelleWerte, MessstelleWerteRaster, MessstelleWerteWert } from '../api';
import { iso, mitternacht, stundenDesTages, tagPlus } from '../bezugsPeriode';
import { raster, tagesdauer } from '../uemsErgebnis';

export const ZONE = 'Europe/Berlin';

type Teil = Partial<MessstelleWerteWert> & Pick<MessstelleWerteWert, 'von' | 'bis'>;

const QUELLE = 'b1f0c5a2-0000-4000-8000-000000000001';

/** Ein Schritt mit allen Feldern der Route; was nicht gesetzt ist, ist `null` — nie 0. */
export const schritt = (t: Teil): MessstelleWerteWert => ({
  beschriftung: null,
  stunden: null,
  tagesdauer: null,
  menge: null,
  mittel: null,
  min: null,
  max: null,
  zustand: null,
  kennzeichen: [],
  erhalten: null,
  erwartet: null,
  abdeckung_prozent: null,
  fassung: 'vorlaeufig',
  endgueltig_ab: null,
  version: 1,
  gebildet_aus: null,
  quelle: QUELLE,
  grund: null,
  ereignisse: [],
  ...t,
});

type Messstelle = MessstelleWerte['messstelle'];

export const MS_06: Messstelle = {
  id: '6a0e1d4c-0000-4000-8000-000000000006',
  kennzeichen: 'MS-06',
  name: 'Spritzguss SG01–SG06',
  art: 'gemessen',
  groesse: 'Wirkenergie',
  richtung: 'bezug',
  einheit: 'kWh',
  wertart: 'Zählerstand',
};

export const MS_10: Messstelle = { ...MS_06, id: '6a0e1d4c-0000-4000-8000-000000000010', kennzeichen: 'MS-10', name: 'Netzbezug Halle 2' };

export const MS_21: Messstelle = {
  ...MS_06,
  id: '6a0e1d4c-0000-4000-8000-000000000021',
  kennzeichen: 'MS-21',
  name: 'Gas Heizung Verwaltung',
  groesse: 'Volumen',
  einheit: 'm³',
};

const antwort = (
  messstelle: Messstelle,
  art: MessstelleWerteRaster,
  von: string,
  bis: string,
  werte: MessstelleWerteWert[],
  mitQuelle = true,
): MessstelleWerte => ({
  messstelle,
  raster: art,
  von,
  bis,
  zeitzone: ZONE,
  zeitzone_herkunft: 'standort',
  version: null,
  quellen: mitQuelle
    ? [
        {
          id: QUELLE,
          komponente: '0c4b9e1f-0000-4000-8000-000000000005',
          kanal: 'energy_import_kwh',
          herleitung: 'zaehlerstand',
          anteil: null,
          gueltig_ab: '2026-09-01T00:00:00+02:00',
          gueltig_bis: null,
        },
      ]
    : [],
  werte,
});

const tagesgrenzen = (tag: string) => ({
  von: iso(mitternacht(tag, ZONE), ZONE),
  bis: iso(mitternacht(tagPlus(tag, 1), ZONE), ZONE),
});

/** Ein vollständig gemessener Schritt aus Zählerständen. */
const voll = (menge: number, erwartet: number): Partial<MessstelleWerteWert> => ({
  menge,
  zustand: 'vollständig',
  erhalten: erwartet,
  erwartet,
  abdeckung_prozent: 100,
});

/** Die Stunden eines Tages mit den Beschriftungen des Vertrags; `je` gibt jeder Stunde ihren Wert. */
const stundenDes = (tag: string, je: (beschriftung: string, i: number) => Partial<MessstelleWerteWert>) => {
  const felder = raster(tag, ZONE, 'stunde');
  const ende = tagesgrenzen(tag).bis;
  return felder.map((f, i) =>
    schritt({
      von: f.von,
      bis: felder[i + 1]?.von ?? ende,
      beschriftung: f.beschriftung,
      gebildet_aus: 'zeitraum',
      ...je(f.beschriftung, i),
    }),
  );
};

const tagSchritt = (tag: string, t: Partial<MessstelleWerteWert>) =>
  schritt({
    ...tagesgrenzen(tag),
    stunden: stundenDesTages(tag, ZONE),
    tagesdauer: tagesdauer(tag, ZONE),
    gebildet_aus: 'tag',
    ...t,
  });

// ------------------------------------------------------------------ F8 · MS-10 · 03.11.2026

/** Der Zuwachs über die Lücke — Wortlaut aus `verbrauch-vectors.json` (F8, Tag). */
export const F8_LUECKE = 'Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar';
export const ANFANG_NICHT_GEMESSEN = 'Anfang nicht gemessen (kein Stand an der Periodengrenze)';
export const NUR_EIN_STAND = 'nur ein Stand in der Periode — keine Menge bildbar';

/** Tag 03.11.2026: 2 304,0 kWh vollständig aus den Ständen, Verlauf 1 230 von 1 440 = 85 %. */
export const f8Tag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', [
    tagSchritt('2026-11-03', {
      menge: 2304.0,
      zustand: 'vollständig',
      erhalten: 1230,
      erwartet: 1440,
      abdeckung_prozent: 85,
      kennzeichen: [F8_LUECKE],
      ereignisse: [{ id: 'e8a1c2d3-0000-4000-8000-000000000008', art: 'data_gap', von: '2026-11-03T14:00:00+01:00', bis: '2026-11-03T17:31:00+01:00' }],
    }),
  ]);

/**
 * Die Stunden des 03.11.2026: bis 14:00 je 96,0 kWh (+1,6 kWh je Minute); 14:00–15:00 nur der Stand um
 * 14:00; 15:00–17:00 ohne Werte; 17:00–18:00 = 46,4 kWh (29 von 60, F8); danach wieder 96,0 kWh.
 */
export const f8Stunden = (): MessstelleWerte =>
  antwort(MS_10, 'stunde', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', stundenDes('2026-11-03', (_b, h) => {
    if (h < 14 || h >= 18) return voll(96.0, 60);
    if (h === 14) return { zustand: 'unvollständig', erhalten: 1, erwartet: 60, abdeckung_prozent: 1, kennzeichen: [NUR_EIN_STAND] };
    if (h < 17) return { zustand: 'keine Werte', erhalten: 0, erwartet: 60, abdeckung_prozent: 0 };
    return { menge: 46.4, zustand: 'unvollständig', erhalten: 29, erwartet: 60, abdeckung_prozent: 48, kennzeichen: [ANFANG_NICHT_GEMESSEN] };
  }));

/** Der gewöhnliche Tag davor: 02.11.2026, durchgehend +1,6 kWh je Minute. */
export const normalTag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-02T00:00:00+01:00', '2026-11-03T00:00:00+01:00', [
    tagSchritt('2026-11-02', { ...voll(2304.0, 1440), fassung: 'endgueltig' }),
  ]);

export const normalStunden = (): MessstelleWerte =>
  antwort(MS_10, 'stunde', '2026-11-02T00:00:00+01:00', '2026-11-03T00:00:00+01:00', stundenDes('2026-11-02', () => voll(96.0, 60)));

// ------------------------------------------------------------------ F13 / F14 · MS-06 · Grundlast 28,8 kW

/** 25.10.2026: 720,0 kWh in 25 Stunden. */
export const f13Tag = (): MessstelleWerte =>
  antwort(MS_06, 'tag', '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', [tagSchritt('2026-10-25', voll(720.0, 1500))]);

export const f13Stunden = (): MessstelleWerte =>
  antwort(MS_06, 'stunde', '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', stundenDes('2026-10-25', () => voll(28.8, 60)));

/** 28.03.2027: 662,4 kWh in 23 Stunden. */
export const f14Tag = (): MessstelleWerte =>
  antwort(MS_06, 'tag', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00', [tagSchritt('2027-03-28', voll(662.4, 1380))]);

export const f14Stunden = (): MessstelleWerte =>
  antwort(MS_06, 'stunde', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00', stundenDes('2027-03-28', () => voll(28.8, 60)));

// ------------------------------------------------------------------ F16 · MS-06 · Oktober 2026

/** Oktober 2026: 55 100,0 kWh aus den Ständen, 44 700 von 44 700 Werten (F16). */
export const f16Monat = (): MessstelleWerte =>
  antwort(MS_06, 'monat', '2026-10-01T00:00:00+02:00', '2026-11-01T00:00:00+01:00', [
    schritt({
      von: '2026-10-01T00:00:00+02:00',
      bis: '2026-11-01T00:00:00+01:00',
      stunden: 745,
      gebildet_aus: 'monat',
      ...voll(55100.0, 44700),
    }),
  ]);

/** Die Tage des Oktobers 2026: im Mittel +1,2327 kWh je Minute (F16), der 25.10. mit 25 Stunden. */
export const f16Tage = (): MessstelleWerte => {
  const tage = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  return antwort(
    MS_06,
    'tag',
    '2026-10-01T00:00:00+02:00',
    '2026-11-01T00:00:00+01:00',
    tage.map((tag) => {
      const minuten = stundenDesTages(tag, ZONE) * 60;
      return tagSchritt(tag, voll(Math.round((minuten * 55100 * 1000) / 44700) / 1000, minuten));
    }),
  );
};

// ------------------------------------------------------------------ MS-21 · ohne Datenquelle

/** Eine Messstelle ohne Quelle: jeder Schritt „keine Werte“ mit Grund `keine_quelle` — ohne Zahl, ohne Abdeckung. */
export const ohneQuelleTag = (): MessstelleWerte =>
  antwort(
    MS_21,
    'tag',
    '2026-11-03T00:00:00+01:00',
    '2026-11-04T00:00:00+01:00',
    [tagSchritt('2026-11-03', { zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null })],
    false,
  );

export const ohneQuelleStunden = (): MessstelleWerte =>
  antwort(
    MS_21,
    'stunde',
    '2026-11-03T00:00:00+01:00',
    '2026-11-04T00:00:00+01:00',
    stundenDes('2026-11-03', () => ({ zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null })),
    false,
  );
