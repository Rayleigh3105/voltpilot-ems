import type { Protokoll, ProtokollBezug, ProtokollEintrag, ProtokollUrheber } from '../api';
import { ORT_IDS } from './ortsbaumFixtures';
import { werkAhrenberg } from './standorteFixtures';

/**
 * Die Änderungsprotokolle der Ortsstruktur (UEMS AP-02 IP-14, Mockup H2) — Referenzunternehmen
 * Ahrenberg mit den Zeitpunkten des Reports: Halle 2 am 01.10.2026 angelegt (3.100 m²); am
 * 15.01.2027 die Fläche 3.400 m² ab 01.01.2027 (A3, rückwirkend 14 Tage); am 20.02.2027 zieht die
 * Anlage „Werk Ahrenberg – Halle 2“ nach Nord ab 01.03.2027 (geplant) und Jonas ändert die Notiz;
 * am 10.03.2027 wird Halle 2 nach Werk Ahrenberg Nord verschoben, gültig ab 01.02.2027 (A2,
 * rückwirkend 37 Tage); am 20.05.2027 die Fläche 3.600 m² ab 01.06.2027 (angekündigt).
 *
 * Die Sätze sind die des Servers (`AenderungSatz`), die Reihenfolge die seiner Sortierung.
 */

const INES: ProtokollUrheber = { name: 'Ines Kaltenbach', rolle: null, art: null };
const JONAS: ProtokollUrheber = { name: 'Jonas Wendlinger', rolle: null, art: null };

export const ANLAGE_HALLE_2 = 'a0000000-0000-4000-8000-0000000000a2';

const HALLE_2: ProtokollBezug = { art: 'gebaeude', id: ORT_IDS.g2, kennzeichen: 'G-2', name: 'Halle 2' };
const HALLE_1: ProtokollBezug = { art: 'gebaeude', id: ORT_IDS.g1, kennzeichen: 'G-1', name: 'Halle 1' };
const MONTAGE: ProtokollBezug = { art: 'bereich', id: ORT_IDS.b3, kennzeichen: 'B-3', name: 'Halle 2 Montage' };
const SPRITZGUSS: ProtokollBezug = { art: 'bereich', id: ORT_IDS.b4, kennzeichen: 'B-4', name: 'Halle 2 Spritzguss' };
const WERK: ProtokollBezug = { art: 'standort', id: werkAhrenberg().id, kennzeichen: 'ST-1', name: 'Werk Ahrenberg' };
const ANLAGE: ProtokollBezug = { art: 'anlage', id: ANLAGE_HALLE_2, kennzeichen: null, name: 'Werk Ahrenberg – Halle 2' };

function eintrag(
  e: Partial<ProtokollEintrag> &
    Pick<ProtokollEintrag, 'id' | 'art' | 'text' | 'gilt_ab' | 'eingetragen_am' | 'zeitform'>,
): ProtokollEintrag {
  return { quelle: 'ort', bezug: HALLE_2, gilt_bis: null, grund: null, urheber: INES, alt: null, neu: null, ...e };
}

export const h2Flaeche3600 = () =>
  eintrag({
    id: 'ort:14',
    art: 'flaeche_geaendert',
    text: 'Bezugsfläche geändert: 3.400 m² → 3.600 m²',
    gilt_ab: '2027-06-01T00:00:00+02:00',
    eingetragen_am: '2027-05-20T10:02:00+02:00',
    zeitform: 'angekuendigt',
    urheber: JONAS,
    alt: { flaeche_m2: 3400 },
    neu: { flaeche_m2: 3600, korrektur: false },
  });

export const h2Verschoben = () =>
  eintrag({
    id: 'ort:12',
    art: 'verschoben',
    text: 'Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)',
    gilt_ab: '2027-02-01T00:00:00+01:00',
    eingetragen_am: '2027-03-10T09:30:00+01:00',
    zeitform: 'rueckwirkend',
    grund: 'Umzug der Spritzgussfertigung nachgetragen',
    alt: { eltern_name: 'Werk Ahrenberg', gueltig_ab: '2026-10-01', gueltig_bis: null },
    neu: { eltern_name: 'Werk Ahrenberg Nord', eltern_kurzzeichen: 'ST-3', begruendung: 'Umzug der Spritzgussfertigung nachgetragen' },
  });

export const h2Notiz = () =>
  eintrag({
    id: 'ort:10',
    art: 'bearbeitet',
    text: 'Gebäude bearbeitet: Notiz geändert',
    gilt_ab: '2027-02-20T00:00:00+01:00',
    eingetragen_am: '2027-02-20T14:05:00+01:00',
    zeitform: 'sofort',
    urheber: JONAS,
    alt: { notiz: 'Spritzguss und Montage' },
    neu: { notiz: 'Spritzguss zieht nach Nord' },
  });

export const h2Flaeche3400 = () =>
  eintrag({
    id: 'ort:9',
    art: 'flaeche_geaendert',
    text: 'Bezugsfläche geändert: 3.100 m² → 3.400 m²',
    gilt_ab: '2027-01-01T00:00:00+01:00',
    gilt_bis: '2027-05-31',
    eingetragen_am: '2027-01-15T11:20:00+01:00',
    zeitform: 'rueckwirkend',
    alt: { flaeche_m2: 3100 },
    neu: { flaeche_m2: 3400, korrektur: false },
  });

export const h2Angelegt = () =>
  eintrag({
    id: 'ort:4',
    art: 'angelegt',
    text: 'Gebäude angelegt: Halle 2',
    gilt_ab: '2026-10-01T00:00:00+02:00',
    eingetragen_am: '2026-10-01T09:12:00+02:00',
    zeitform: 'sofort',
    neu: { name: 'Halle 2', kurzzeichen: 'G-2' },
  });

function seite(eintraege: ProtokollEintrag[], achse: Protokoll['achse']): Protokoll {
  return { eintraege, achse, von: null, bis: null, weiter: null };
}

/** H2: das Protokoll von Halle 2 — wie der Server es liefert, nach dem Eintrag (Vorgabe) oder nach „gilt ab“. */
export function halle2Protokoll(achse: 'eintrag' | 'wirkung' = 'eintrag'): Protokoll {
  return achse === 'eintrag'
    ? seite([h2Flaeche3600(), h2Verschoben(), h2Notiz(), h2Flaeche3400(), h2Angelegt()], 'eintrag')
    : seite([h2Flaeche3600(), h2Notiz(), h2Verschoben(), h2Flaeche3400(), h2Angelegt()], 'wirkung');
}

/** Werk Ahrenberg samt Kindern und Anlage — ohne die Fläche 3.600 m² (da hing Halle 2 schon an Nord). */
export function werkAhrenbergProtokoll(): Protokoll {
  return seite(
    [
      h2Verschoben(),
      h2Notiz(),
      eintrag({
        id: 'ort:11',
        art: 'verschoben',
        text: 'Anlage zieht um: Werk Ahrenberg – Halle 2 → Werk Ahrenberg Nord',
        bezug: WERK,
        gilt_ab: '2027-03-01T00:00:00+01:00',
        eingetragen_am: '2027-02-20T10:11:00+01:00',
        zeitform: 'angekuendigt',
        neu: {
          anlage_id: ANLAGE_HALLE_2,
          anlage_name: 'Werk Ahrenberg – Halle 2',
          richtung: 'hinaus',
          nach_standort_name: 'Werk Ahrenberg Nord',
        },
      }),
      h2Flaeche3400(),
      eintrag({
        id: 'ort:6',
        art: 'angelegt',
        text: 'Bereich angelegt: Halle 2 Montage',
        bezug: MONTAGE,
        gilt_ab: '2026-10-01T00:00:00+02:00',
        eingetragen_am: '2026-10-01T09:14:00+02:00',
        zeitform: 'sofort',
      }),
      h2Angelegt(),
      eintrag({
        id: 'ort:3',
        art: 'angelegt',
        text: 'Gebäude angelegt: Halle 1',
        bezug: HALLE_1,
        gilt_ab: '2026-10-01T00:00:00+02:00',
        eingetragen_am: '2026-10-01T09:10:00+02:00',
        zeitform: 'sofort',
      }),
      eintrag({
        id: 'ort:2',
        art: 'verschoben',
        text: 'Standort zugeordnet: Werk Ahrenberg (ST-1)',
        bezug: ANLAGE,
        gilt_ab: '2026-10-01T00:00:00+02:00',
        eingetragen_am: '2026-10-01T09:08:00+02:00',
        zeitform: 'sofort',
      }),
      eintrag({
        id: 'ort:1',
        art: 'angelegt',
        text: 'Standort angelegt: Werk Ahrenberg',
        bezug: WERK,
        gilt_ab: '2026-10-01T00:00:00+02:00',
        eingetragen_am: '2026-10-01T09:05:00+02:00',
        zeitform: 'sofort',
      }),
    ],
    'eintrag',
  );
}

/** Ein Bereich, an dem seit dem Anlegen nichts geändert wurde (Leerzustand §5.9). */
export function bereichNurAngelegt(): Protokoll {
  return seite(
    [
      eintrag({
        id: 'ort:7',
        art: 'angelegt',
        text: 'Bereich angelegt: Halle 2 Spritzguss',
        bezug: SPRITZGUSS,
        gilt_ab: '2026-10-01T00:00:00+02:00',
        eingetragen_am: '2026-10-01T09:15:00+02:00',
        zeitform: 'sofort',
      }),
    ],
    'eintrag',
  );
}
