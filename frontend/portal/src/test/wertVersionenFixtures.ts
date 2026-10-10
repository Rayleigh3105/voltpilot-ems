/**
 * Antworten für „Versionen am Wert“ (UEMS AP-08 IP-18) — aus dem
 * Referenzunternehmen Ahrenberg, in der FORM der OpenAPI `MessstelleWerte` und
 * `MessstelleWerteHistorie`. Genutzt von `uemsWertVersionen.test.ts` (dort gegen
 * `verbrauch-vectors.json` und `korrektur-vorschlag-vectors.json`
 * gegengeprüft) und von der E2E-Bühne `e2e/tageskarte`. Nie ins
 * Produktionsbündel importieren.
 *
 * F21 · MS-10 · Tag 03.11.2026 (Box-Tausch): Version 1 die Verdichtung
 * (1 344,0 kWh unvollständig), Version 2 EW-2026-0003 „Zuwachs gleichmäßig
 * verteilen“ (Ines Kaltenbach, 06.11. 11:20), Version 3 Widerruf von
 * EW-2026-0003 und EW-2026-0005 nach dem Profil der Vergleichsquelle
 * (20.11. 15:10) — zwei Entscheidungen in EINER Version. Texte wie in
 * `MessstelleWerteVersionenApiTest`.
 *
 * F10 · MS-10 · Tag 03.11.2026 (Nachlieferung nach Endgültigkeit): Version 1
 * ist der F8-Tag, Version 2 die Korrektur K-2026-0007 — vom System
 * vorgeschlagen, freigegeben OHNE Grund (die Freigabe verlangt keinen; wie
 * Jonas Wendlinger in `MessstelleWerteVersionenApiTest`).
 *
 * F21 und F10 sind zwei Geschichten desselben Tages; eine Bühne verdrahtet je
 * Test genau eine.
 */

import type { MessstelleWerte, MessstelleWerteHistorie, MessstelleWerteUrheber, MessstelleWerteWert } from '../api';
import { ersatzwert, korrigiert } from '../uemsErgebnis';
import { F8_LUECKE, MS_10, ZONE, antwort, stundenDes, tagSchritt, tagesgrenzen, voll } from './werteKarteFixtures';

export const INES: MessstelleWerteUrheber = { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' };
export const JONAS: MessstelleWerteUrheber = { name: 'Jonas Wendlinger', rolle: 'kundenadministrator', art: 'kunde' };
export const VOLTPILOT: MessstelleWerteUrheber = { name: 'VoltPilot', rolle: null, art: 'voltpilot' };

export const EW_A = 'EW-2026-0003';
export const EW_C = 'EW-2026-0005';
export const K_F10 = 'K-2026-0007';

export const BEGRUENDUNG = 'Box-Tausch nach Defekt; Energiekarte hat weitergezählt';
export const WIDERRUF = 'Profil aus Netzbetreiber-Lastgang verfügbar';
export const BESSER = 'Lastgang des Netzbetreibers liegt für den 03./04.11. vor';
/** Der Satz des System-Vorschlags — `korrektur-vorschlag-vectors.json`, Fall `f10-nachlieferung-k-2026-0007`. */
export const F10_VORSCHLAG =
  'Nachgeliefert nach Ablauf der Frist: 210 Messwerte für 03.11.2026 14:00 bis 17:45, zuletzt eingegangen am 12.11.2026 09:02; endgültig seit 10.11.2026 14:15.';

export const ENDE_NICHT_GEMESSEN = 'Ende nicht gemessen (kein Stand an der Periodengrenze)';

const TAG = '2026-11-03';

// ------------------------------------------------------------------ F21

/** Tag 03.11.2026 in Version n, wie `…/werte?version=n` ihn zeigt (drei Versionen hat er heute). */
export const f21TagWert = (version: 1 | 2 | 3): MessstelleWerteWert =>
  tagSchritt(TAG, {
    fassung: 'endgueltig',
    erhalten: 841,
    erwartet: 1440,
    abdeckung_prozent: 58,
    version,
    versionen: 3,
    ...(version === 1
      ? { menge: 1344.0, zustand: 'unvollständig', kennzeichen: [ENDE_NICHT_GEMESSEN] }
      : version === 2
        ? { menge: 2304.0, zustand: 'mit Ersatzwert', kennzeichen: [ersatzwert('gleichmaessig_verteilen', EW_A)] }
        : { menge: 2354.4, zustand: 'mit Ersatzwert', kennzeichen: [ersatzwert('profil_vergleichsquelle', EW_C)] }),
  });

export const f21Tag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', [f21TagWert(3)]);

/** Bis 14:00 je 96,0 kWh; ab 14:00 trägt jede Stunde eine Viertelstunde mit Ersatzwert — die Stunde hat keine eigenen Versionen. */
export const f21Stunden = (): MessstelleWerte =>
  antwort(MS_10, 'stunde', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', stundenDes(TAG, (_b, h) =>
    h < 14
      ? { ...voll(96.0, 60), fassung: 'endgueltig' }
      : { grund: 'version_nicht_gebildet', fassung: null, version: null, gebildet_aus: null },
  ));

export const f21Historie = (): MessstelleWerteHistorie => ({
  messstelle: MS_10,
  raster: 'tag',
  ...tagesgrenzen(TAG),
  zeitzone: ZONE,
  zeitzone_herkunft: 'standort',
  grund: null,
  versionen: [
    {
      version: 1,
      wert_alt: null,
      wert_neu: f21TagWert(1),
      gebildet_am: '2026-11-04T00:15:00+01:00',
      nachgezogen_am: null,
      anlass: null,
      entscheidungen: [],
    },
    {
      version: 2,
      wert_alt: f21TagWert(1),
      wert_neu: f21TagWert(2),
      gebildet_am: '2026-11-06T11:25:00+01:00',
      nachgezogen_am: null,
      anlass: { kennung: EW_A, fassung: 1 },
      entscheidungen: [
        {
          vorgang: 'ersatzwert',
          kennung: EW_A,
          fassung: 1,
          status: 'wirksam',
          methode: 'gleichmaessig_verteilen',
          art: null,
          wer: INES,
          wann: '2026-11-06T11:20:00+01:00',
          warum: BEGRUENDUNG,
          beleg: null,
          fehlt: [],
          angelegt: null,
        },
      ],
    },
    {
      version: 3,
      wert_alt: f21TagWert(2),
      wert_neu: f21TagWert(3),
      gebildet_am: '2026-11-20T15:15:00+01:00',
      nachgezogen_am: null,
      anlass: { kennung: EW_C, fassung: 1 },
      entscheidungen: [
        {
          vorgang: 'ersatzwert',
          kennung: EW_A,
          fassung: 2,
          status: 'zurueckgenommen',
          methode: 'gleichmaessig_verteilen',
          art: null,
          wer: INES,
          wann: '2026-11-20T15:10:00+01:00',
          warum: WIDERRUF,
          beleg: null,
          fehlt: [],
          angelegt: { wer: INES, wann: '2026-11-06T11:20:00+01:00', warum: BEGRUENDUNG, beleg: null },
        },
        {
          vorgang: 'ersatzwert',
          kennung: EW_C,
          fassung: 1,
          status: 'wirksam',
          methode: 'profil_vergleichsquelle',
          art: null,
          wer: INES,
          wann: '2026-11-20T15:12:00+01:00',
          warum: BESSER,
          beleg: null,
          fehlt: [],
          angelegt: null,
        },
      ],
    },
  ],
});

// ------------------------------------------------------------------ F10

/** Tag 03.11.2026: Version 1 = der F8-Tag (Verlauf 85 %), Version 2 nach der Freigabe (Verlauf 100 %, Menge gleich). */
export const f10TagWert = (version: 1 | 2): MessstelleWerteWert =>
  tagSchritt(TAG, {
    fassung: 'endgueltig',
    menge: 2304.0,
    zustand: 'vollständig',
    version,
    versionen: 2,
    ...(version === 1
      ? { erhalten: 1230, erwartet: 1440, abdeckung_prozent: 85, kennzeichen: [F8_LUECKE] }
      : { erhalten: 1440, erwartet: 1440, abdeckung_prozent: 100, kennzeichen: [korrigiert(2)] }),
  });

export const f10Tag = (): MessstelleWerte =>
  antwort(MS_10, 'tag', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', [f10TagWert(2)]);

/** Die Stunden 14:00–18:00 tragen Viertelstunden der Korrektur — keine eigenen Versionen. */
export const f10Stunden = (): MessstelleWerte =>
  antwort(MS_10, 'stunde', '2026-11-03T00:00:00+01:00', '2026-11-04T00:00:00+01:00', stundenDes(TAG, (_b, h) =>
    h < 14 || h >= 18
      ? { ...voll(96.0, 60), fassung: 'endgueltig' }
      : { grund: 'version_nicht_gebildet', fassung: null, version: null, gebildet_aus: null },
  ));

export const f10Historie = (): MessstelleWerteHistorie => ({
  messstelle: MS_10,
  raster: 'tag',
  ...tagesgrenzen(TAG),
  zeitzone: ZONE,
  zeitzone_herkunft: 'standort',
  grund: null,
  versionen: [
    {
      version: 1,
      wert_alt: null,
      wert_neu: f10TagWert(1),
      gebildet_am: '2026-11-04T00:15:00+01:00',
      nachgezogen_am: null,
      anlass: null,
      entscheidungen: [],
    },
    {
      version: 2,
      wert_alt: f10TagWert(1),
      wert_neu: f10TagWert(2),
      gebildet_am: '2026-11-12T10:20:00+01:00',
      nachgezogen_am: null,
      anlass: { kennung: K_F10, fassung: 2 },
      entscheidungen: [
        {
          vorgang: 'korrektur',
          kennung: K_F10,
          fassung: 2,
          status: 'freigegeben',
          methode: null,
          art: 'nachlieferung_nach_endgueltigkeit',
          wer: JONAS,
          wann: '2026-11-12T10:15:00+01:00',
          warum: null,
          beleg: null,
          fehlt: ['warum'],
          angelegt: { wer: VOLTPILOT, wann: '2026-11-12T09:02:00+01:00', warum: F10_VORSCHLAG, beleg: null },
        },
      ],
    },
  ],
});
