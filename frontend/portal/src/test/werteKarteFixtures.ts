/**
 * Antworten der Route „Werte je Messstelle“ (AP-08 IP-9) für die Tages- und
 * Monatskarte (IP-11) — aus dem Referenzunternehmen Ahrenberg, in der FORM der
 * OpenAPI `MessstelleWerte`. Genutzt von `uemsWerteKarte.test.ts` (dort gegen
 * `verbrauch-vectors.json` gegengeprüft) und von der E2E-Bühne `e2e/tageskarte`.
 *
 * Beschriftung und Tagesdauer setzt hier — wie in der Route — der
 * Ergebnis-Vertrag (`raster`, `tagesdauer`); die Zahlen sind die der Fälle
 * F8, F13, F14 und F16. Nie ins Produktionsbündel importieren.
 *
 * Die Fassung (vorläufig/endgültig) je Periode wie die Route sie liefert — je
 * Periode für sich, nie aus einer anderen abgeleitet. Ein Tag steht sieben Tage
 * nach seinem Ende fest, ein Monat sieben Tage nach seinem letzten Tag (E5).
 * Gelesen am 10.11.2026: der 02.11. ist endgültig, der 03.11. noch vorläufig.
 * Gelesen am 05.11.2026: der Oktober ist vorläufig (bis 08.11.), seine Tage bis
 * zum 28.10. sind schon endgültig, 29.–31.10. noch nicht.
 */

import type { MessstelleWerte, MessstelleWerteRaster, MessstelleWerteWert } from '../api';
import { iso, mitternacht, stundenDesTages, tagPlus } from '../bezugsPeriode';
import { raster, tagesdauer } from '../uemsErgebnis';
import { verschiebe } from '../picker/datum';

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
  herkunft: null,
  versionen: 1,
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

export const antwort = (
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

export const tagesgrenzen = (tag: string) => ({
  von: iso(mitternacht(tag, ZONE), ZONE),
  bis: iso(mitternacht(tagPlus(tag, 1), ZONE), ZONE),
});

/** Ein vollständig gemessener Schritt aus Zählerständen. */
export const voll = (menge: number, erwartet: number): Partial<MessstelleWerteWert> => ({
  menge,
  zustand: 'vollständig',
  erhalten: erwartet,
  erwartet,
  abdeckung_prozent: 100,
});

/** Die Stunden eines Tages mit den Beschriftungen des Vertrags; `je` gibt jeder Stunde ihren Wert. */
export const stundenDes = (tag: string, je: (beschriftung: string, i: number) => Partial<MessstelleWerteWert>) => {
  const felder = raster(tag, ZONE, 'stunde');
  const ende = tagesgrenzen(tag).bis;
  return felder.map((f, i) =>
    schritt({
      von: f.von,
      bis: felder[i + 1]?.von ?? ende,
      beschriftung: f.beschriftung,
      gebildet_aus: 'zeitraum',
      // Die Stunde hat keine eigenen Versionen (IP-18).
      versionen: null,
      ...je(f.beschriftung, i),
    }),
  );
};

export const tagSchritt = (tag: string, t: Partial<MessstelleWerteWert>) =>
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

/** Die Lücke des Box-Ausfalls Halle 2 am 03.11.2026 (AP-00 §7.6) — das Ereignis, das die Route an den Tag hängt. */
export const LUECKE_03_11 = {
  id: 'e8a1c2d3-0000-4000-8000-000000000008',
  art: 'data_gap',
  von: '2026-11-03T14:00:00+01:00',
  bis: '2026-11-03T17:31:00+01:00',
};

/** Tag 03.11.2026: 2 304,0 kWh vollständig aus den Ständen, Verlauf 1 230 von 1 440 = 85 %. */
export const f8Tag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', [
    tagSchritt('2026-11-03', {
      fassung: 'vorlaeufig',
      menge: 2304.0,
      zustand: 'vollständig',
      erhalten: 1230,
      erwartet: 1440,
      abdeckung_prozent: 85,
      kennzeichen: [F8_LUECKE],
      ereignisse: [LUECKE_03_11],
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
  antwort(MS_10, 'stunde', '2026-11-02T00:00:00+01:00', '2026-11-03T00:00:00+01:00', stundenDes('2026-11-02', () => ({ ...voll(96.0, 60), fassung: 'endgueltig' })));

// ------------------------------------------------------------------ F13 / F14 · MS-06 · Grundlast 28,8 kW

/** 25.10.2026: 720,0 kWh in 25 Stunden — endgültig, ein Tag im vorläufigen Oktober. */
export const f13Tag = (): MessstelleWerte =>
  antwort(MS_06, 'tag', '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', [
    tagSchritt('2026-10-25', { ...voll(720.0, 1500), fassung: 'endgueltig' }),
  ]);

export const f13Stunden = (): MessstelleWerte =>
  antwort(MS_06, 'stunde', '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', stundenDes('2026-10-25', () => ({ ...voll(28.8, 60), fassung: 'endgueltig' })));

/** 28.03.2027: 662,4 kWh in 23 Stunden. */
export const f14Tag = (): MessstelleWerte =>
  antwort(MS_06, 'tag', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00', [tagSchritt('2027-03-28', voll(662.4, 1380))]);

export const f14Stunden = (): MessstelleWerte =>
  antwort(MS_06, 'stunde', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00', stundenDes('2027-03-28', () => voll(28.8, 60)));

// ------------------------------------------------------------------ F16 · MS-06 · Oktober 2026

/** Oktober 2026: 55 100,0 kWh aus den Ständen, 44 700 von 44 700 Werten (F16) — vorläufig bis 08.11.2026. */
export const f16Monat = (): MessstelleWerte =>
  antwort(MS_06, 'monat', '2026-10-01T00:00:00+02:00', '2026-11-01T00:00:00+01:00', [
    schritt({
      von: '2026-10-01T00:00:00+02:00',
      bis: '2026-11-01T00:00:00+01:00',
      stunden: 745,
      gebildet_aus: 'monat',
      ...voll(55100.0, 44700),
      fassung: 'vorlaeufig',
    }),
  ]);

/**
 * Die Tage des Oktobers 2026: im Mittel +1,2327 kWh je Minute (F16), der 25.10. mit 25 Stunden; bis zum 28.10.
 * endgültig, 29.–31.10. noch vorläufig.
 */
export const f16Tage = (): MessstelleWerte => {
  const tage = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  return antwort(
    MS_06,
    'tag',
    '2026-10-01T00:00:00+02:00',
    '2026-11-01T00:00:00+01:00',
    tage.map((tag) => {
      const minuten = stundenDesTages(tag, ZONE) * 60;
      return tagSchritt(tag, {
        ...voll(Math.round((minuten * 55100 * 1000) / 44700) / 1000, minuten),
        fassung: tag <= '2026-10-28' ? 'endgueltig' : 'vorlaeufig',
      });
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
    [tagSchritt('2026-11-03', { zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null, versionen: null })],
    false,
  );

export const ohneQuelleStunden = (): MessstelleWerte =>
  antwort(
    MS_21,
    'stunde',
    '2026-11-03T00:00:00+01:00',
    '2026-11-04T00:00:00+01:00',
    stundenDes('2026-11-03', () => ({ zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null, versionen: null })),
    false,
  );

// ------------------------------------------------------------------ noch nicht gebildet · MS-10 · 05.11.2026

/**
 * Gelesen am 06.11.2026 um 00:05: die Viertelstunden des 05.11. sind bis 23:45 gebildet (je Stunde 96,0 kWh wie
 * am 02.11.), die letzte noch nicht — darum sind die Stunde 23:00–24:00 und der Tag noch nicht gebildet. Die Route
 * sagt dann `grund` `noch_nicht_gebildet`: ohne Zustand, ohne Zahl, ohne Version; der nächste Lauf bildet sie.
 */
export const nochNichtGebildetTag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-05T00:00:00+01:00', '2026-11-06T00:00:00+01:00', [
    tagSchritt('2026-11-05', { grund: 'noch_nicht_gebildet', version: null, gebildet_aus: null, versionen: null }),
  ]);

export const nochNichtGebildetStunden = (): MessstelleWerte =>
  antwort(MS_10, 'stunde', '2026-11-05T00:00:00+01:00', '2026-11-06T00:00:00+01:00', stundenDes('2026-11-05', (_b, h) =>
    h < 23 ? voll(96.0, 60) : { grund: 'noch_nicht_gebildet', version: null, gebildet_aus: null },
  ));

// ------------------------------------------------------------------ Lücken zählen · MS-10 · F9 und F20

/**
 * F9 · 03.11.2026, Nachlieferung innerhalb von 7 Tagen: die Box liefert die gepufferten Werte 14:00–17:30 nach,
 * der Tag hat 1 440 von 1 440 Werten. Die Lücke bleibt als Ereignis stehen — der Lücken-Melder schließt sie mit
 * `nachgeliefert_am` und löscht sie nie —, und die Route hängt sie weiter an den Schritt.
 */
export const f9Tag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', [
    tagSchritt('2026-11-03', { ...voll(2304.0, 1440), fassung: 'vorlaeufig', ereignisse: [LUECKE_03_11] }),
  ]);

export const ENDE_NICHT_GEMESSEN = 'Ende nicht gemessen (kein Stand an der Periodengrenze)';

/** F20 · die Lücke 20.10.2026 23:00 – 21.10.2026 01:00: EIN Ereignis, das beide Tage berührt. */
export const LUECKE_F20 = {
  id: 'e8a1c2d3-0000-4000-8000-000000000020',
  art: 'data_gap',
  von: '2026-10-20T23:00:00+02:00',
  bis: '2026-10-21T01:00:00+02:00',
};

/** F20 · jeder der beiden Tage: 2 208,0 kWh unvollständig, Verlauf 95 % — endgültig (gelesen am 05.11.2026). */
export const f20Tag = (tag: '2026-10-20' | '2026-10-21'): MessstelleWerte => {
  const { von, bis } = tagesgrenzen(tag);
  const erster = tag === '2026-10-20';
  return antwort(MS_10, 'tag', von, bis, [
    tagSchritt(tag, {
      menge: 2208.0,
      zustand: 'unvollständig',
      erhalten: erster ? 1381 : 1380,
      erwartet: 1440,
      abdeckung_prozent: 95,
      kennzeichen: [erster ? ENDE_NICHT_GEMESSEN : ANFANG_NICHT_GEMESSEN],
      fassung: 'endgueltig',
      ereignisse: [LUECKE_F20],
    }),
  ]);
};

// ------------------------------------------------------------------ AP-13 IP-3 · ein gewöhnlicher Tag an MS-06

/**
 * Ein gewöhnlicher 24-Stunden-Tag an MS-06 mit der Grundlast von F13/F14 (28,8 kWh je Stunde → 691,2 kWh aus
 * 1 440 Werten) — für Bühnen der Messstellen-Seite, die einen beliebigen Tag brauchen (AP-13 IP-3). Keine neue
 * Zahl, nur die Stunde der Fälle. Die Fassung sagt der Aufrufer (ein Tag steht sieben Tage nach seinem Ende fest).
 */
export const grundlastTag = (tag: string, fassung: 'vorlaeufig' | 'endgueltig'): MessstelleWerte => {
  const g = tagesgrenzen(tag);
  return antwort(MS_06, 'tag', g.von, g.bis, [tagSchritt(tag, { ...voll(691.2, 1440), fassung })]);
};

export const grundlastStunden = (tag: string, fassung: 'vorlaeufig' | 'endgueltig'): MessstelleWerte => {
  const g = tagesgrenzen(tag);
  return antwort(MS_06, 'stunde', g.von, g.bis, stundenDes(tag, () => ({ ...voll(28.8, 60), fassung })));
};

// ------------------------------------------------------------------ Verlauf (AP-13 IP-4): Viertelstunden, Woche, Jahr

/** Die Viertelstunden eines Tages mit den Beschriftungen des Vertrags; `je` gibt jeder Viertelstunde ihren Wert. */
export const viertelstundenDes = (tag: string, je: (beschriftung: string, i: number) => Partial<MessstelleWerteWert>) => {
  const felder = raster(tag, ZONE, 'viertelstunde');
  const ende = tagesgrenzen(tag).bis;
  return felder.map((f, i) =>
    schritt({
      von: f.von,
      bis: felder[i + 1]?.von ?? ende,
      beschriftung: f.beschriftung,
      gebildet_aus: 'viertelstunde',
      ...je(f.beschriftung, i),
    }),
  );
};

/**
 * F8 · die Viertelstunden des 03.11.2026 an MS-10: bis 14:00 je 24,0 kWh (+1,6 kWh je Minute); 14:00–14:15 nur der
 * Stand um 14:00 (unvollständig, keine Menge); 14:15–17:30 ohne Werte; 17:30–17:45 = 22,4 kWh (14 von 15); danach
 * wieder 24,0 kWh. Die Route hängt die Lücke an jede Viertelstunde, die sie berührt (14:00–17:45).
 */
export const f8Viertelstunden = (): MessstelleWerte =>
  antwort(
    MS_10,
    'viertelstunde',
    '2026-11-03T00:00:00+01:00',
    '2026-11-04T00:00:00+01:00',
    viertelstundenDes('2026-11-03', (_b, i) => {
      const ereignisse = i >= 56 && i <= 70 ? [LUECKE_03_11] : [];
      if (i < 56 || i > 70) return { ...voll(24.0, 15), ereignisse };
      if (i === 56) return { zustand: 'unvollständig', erhalten: 1, erwartet: 15, abdeckung_prozent: 6, kennzeichen: [NUR_EIN_STAND], ereignisse };
      if (i < 70) return { zustand: 'keine Werte', erhalten: 0, erwartet: 15, abdeckung_prozent: 0, ereignisse };
      return { menge: 22.4, zustand: 'unvollständig', erhalten: 14, erwartet: 15, abdeckung_prozent: 93, kennzeichen: [ANFANG_NICHT_GEMESSEN], ereignisse };
    }),
  );

/** Die Viertelstunden des gewöhnlichen 02.11.2026 an MS-10: je 24,0 kWh, endgültig. */
export const normalViertelstunden = (): MessstelleWerte =>
  antwort(MS_10, 'viertelstunde', '2026-11-02T00:00:00+01:00', '2026-11-03T00:00:00+01:00', viertelstundenDes('2026-11-02', () => ({ ...voll(24.0, 15), fassung: 'endgueltig' })));

/** F13 · die 100 Viertelstunden des 25.10.2026 an MS-06, je 7,2 kWh — die doppelte Stunde mit MESZ und MEZ. */
export const f13Viertelstunden = (): MessstelleWerte =>
  antwort(MS_06, 'viertelstunde', '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00', viertelstundenDes('2026-10-25', () => ({ ...voll(7.2, 15), fassung: 'endgueltig' })));

/** Die Viertelstunden eines Grundlast-Tages an MS-06 (7,2 kWh = 28,8 kW × ¼ h, F13/F14). */
export const grundlastViertelstunden = (tag: string, fassung: 'vorlaeufig' | 'endgueltig'): MessstelleWerte => {
  const g = tagesgrenzen(tag);
  return antwort(MS_06, 'viertelstunde', g.von, g.bis, viertelstundenDes(tag, () => ({ ...voll(7.2, 15), fassung })));
};

/** Die Fassung eines Tages, gelesen am `heute`: endgültig ab dem achten Tag nach seinem Beginn (wie die Bühne der Seite). */
export const fassungAm = (tag: string, heute: string): 'vorlaeufig' | 'endgueltig' => (verschiebe(tag, 8) <= heute ? 'endgueltig' : 'vorlaeufig');

/**
 * Eine Woche an MS-06 mit der Grundlast von F13/F14: ihre Stunden (in der Woche des 25.10.2026 sind es 169) und ihre
 * Tage (28,8 kWh je Stunde des Tages) — nichts summiert, jede Periode für sich.
 */
export const grundlastWoche = (montag: string, heute: string): { stunden: MessstelleWerte; tage: MessstelleWerte } => {
  const tage = Array.from({ length: 7 }, (_, i) => verschiebe(montag, i));
  const von = tagesgrenzen(montag).von;
  const bis = tagesgrenzen(tage[6]).bis;
  return {
    stunden: antwort(MS_06, 'stunde', von, bis, tage.flatMap((t) => stundenDes(t, () => ({ ...voll(28.8, 60), fassung: fassungAm(t, heute) })))),
    tage: antwort(
      MS_06,
      'tag',
      von,
      bis,
      tage.map((t) => {
        const stunden = stundenDesTages(t, ZONE);
        return tagSchritt(t, { ...voll(Math.round(288 * stunden) / 10, stunden * 60), fassung: fassungAm(t, heute) });
      }),
    ),
  };
};

/**
 * Das Jahr 2026 an MS-06, gelesen am `heute`: bis September ohne Quelle (die Messstellen gibt es seit der Einführung am
 * 01.10.2026 — die Route sagt „keine Werte“ mit Grund `keine_quelle`), Oktober 55 100,0 kWh (F16, endgültig ab
 * 08.11.2026), November und Dezember noch nicht gebildet. Das Jahr selbst ist noch nicht gebildet.
 */
export const jahr2026 = (heute: string): { karte: MessstelleWerte; monate: MessstelleWerte } => {
  const beginn = (m: number) => iso(mitternacht(m === 13 ? '2027-01-01' : `2026-${String(m).padStart(2, '0')}-01`, ZONE), ZONE);
  const seitEinfuehrung = (a: MessstelleWerte): MessstelleWerte => ({
    ...a,
    quellen: a.quellen.map((q) => ({ ...q, gueltig_ab: '2026-10-01T00:00:00+02:00' })),
  });
  const ohne = { version: null, gebildet_aus: null, versionen: null } as const;
  const monate = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
    const grenzen = { von: beginn(m), bis: beginn(m + 1) };
    if (m < 10) return schritt({ ...grenzen, ...ohne, zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null });
    if (m === 10) {
      return schritt({ ...grenzen, ...voll(55100.0, 44700), stunden: 745, gebildet_aus: 'monat', fassung: heute >= '2026-11-08' ? 'endgueltig' : 'vorlaeufig' });
    }
    return schritt({ ...grenzen, ...ohne, grund: 'noch_nicht_gebildet' });
  });
  return {
    karte: seitEinfuehrung(
      antwort(MS_06, 'jahr', beginn(1), beginn(13), [schritt({ von: beginn(1), bis: beginn(13), stunden: 8760, ...ohne, grund: 'noch_nicht_gebildet' })]),
    ),
    monate: seitEinfuehrung(antwort(MS_06, 'monat', beginn(1), beginn(13), monate)),
  };
};

/** F14 · die 92 Viertelstunden des 28.03.2027 an MS-06, je 7,2 kWh — die Stunde 02:00 gibt es nicht. */
export const f14Viertelstunden = (): MessstelleWerte =>
  antwort(MS_06, 'viertelstunde', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00', viertelstundenDes('2027-03-28', () => voll(7.2, 15)));

/** MS-21 ohne Quelle: jede Viertelstunde „keine Werte“ mit Grund `keine_quelle` — ohne Zahl, ohne Abdeckung. */
export const ohneQuelleViertelstunden = (): MessstelleWerte =>
  antwort(
    MS_21,
    'viertelstunde',
    '2026-11-03T00:00:00+01:00',
    '2026-11-04T00:00:00+01:00',
    viertelstundenDes('2026-11-03', () => ({ zustand: 'keine Werte', grund: 'keine_quelle', quelle: null, fassung: null, version: null, gebildet_aus: null, versionen: null })),
    false,
  );

/** Gelesen am 06.11.2026 um 00:05: bis 23:45 gebildet (je 24,0 kWh wie am 02.11.), die letzte Viertelstunde noch nicht. */
export const nochNichtGebildetViertelstunden = (): MessstelleWerte =>
  antwort(MS_10, 'viertelstunde', '2026-11-05T00:00:00+01:00', '2026-11-06T00:00:00+01:00', viertelstundenDes('2026-11-05', (_b, i) =>
    i < 95 ? voll(24.0, 15) : { grund: 'noch_nicht_gebildet', version: null, gebildet_aus: null, versionen: null },
  ));
