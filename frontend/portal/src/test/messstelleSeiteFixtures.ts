import type {
  Kostenstelle,
  Messstelle,
  MessstelleProzesse,
  MessstelleVerteilung,
  Prozess,
  Protokoll,
  ProtokollBezug,
  ProtokollEintrag,
  ProtokollUrheber,
} from '../api';
import { KOMPONENTE_IDS } from './messstelleDialogFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8, Mockups R2 · Z4) — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json` (Fassung 1.4): heute = Momentaufnahme
 * 20.10.2026 10:15 (Europe/Berlin).
 *
 * - **MS-06 Spritzguss SG01–SG06**: Ort B-1 und Stellung „Unterzähler von MS-01“ in AN-1 seit
 *   12.03.2024 (Bestandsanlage, eingetragen am 01.10.2026 — `zuordnungen`: „rückwirkend (933
 *   Tage)“), Prozess P-1 und Kostenstelle 4100 zu 100 % seit 01.10.2026.
 * - **MS-08 Kühlung Kaltwassersatz**: der Umzug des Kaltwassersatzes am 01.03.2027 (`zeitachse`):
 *   Ort B-2 → B-3, Anlage AN-1 → AN-2 („Unterzähler von MS-10“). `ms08Vorher` ist der Stand, bevor
 *   er eingetragen wird; `ms08OrtGeplant` die Antwort nach „Ort ab 01.03.2027 eintragen“ (B-2 endet
 *   am 28.02.2027, wie in `zuordnungen`); `ms08UmzugGeplant` trägt auch die Stellung.
 *
 * Die Protokoll-Sätze sind die des Servers (`AenderungSatz`); die Uhrzeit der Einführung am
 * 01.10.2026 (09:12 · 09:14) ist die des Beispiels „Änderungsprotokoll MS-06“ (AP-04 §5.14). Nur
 * für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const SEITE_HEUTE = '2026-10-20';
export const SEITE_JETZT = '2026-10-20T10:15:00+02:00';

/** Die IDs des Registers (`messstellenRegisterFixtures`: `3e000000-…-0000000000NN`). */
export const MS_IDS = {
  ms06: '3e000000-0000-4000-8000-000000000006',
  ms08: '3e000000-0000-4000-8000-000000000008',
  ms10: '3e000000-0000-4000-8000-000000000010',
  ms16: '3e000000-0000-4000-8000-000000000016',
  ms21: '3e000000-0000-4000-8000-000000000021',
} as const;

const prozessId = (n: number) => `9a000000-0000-4000-8000-00000000000${n}`;
const kostenstelleId = (kz: string) => `c5000000-0000-4000-8000-00000000${kz}`;

export const PROZESS_IDS = { p1: prozessId(1), p4: prozessId(4) } as const;
export const KOSTENSTELLE_IDS = { k4100: kostenstelleId('4100'), k4200: kostenstelleId('4200'), k9000: kostenstelleId('9000') } as const;

const EINFUEHRUNG = '2026-10-01T00:00:00+02:00';

/** Die sechs Prozesse (P-1 … P-6), angelegt mit dem Unternehmens-Energiemanagement am 01.10.2026. */
export function prozesseAhrenberg(): Prozess[] {
  const p = (n: number, name: string): Prozess => ({
    id: prozessId(n),
    kennzeichen: `P-${n}`,
    name,
    eltern: null,
    gueltig_ab: '2026-10-01',
    gueltig_bis: null,
    angelegt_am: EINFUEHRUNG,
  });
  return [p(1, 'Spritzguss'), p(2, 'Montage'), p(3, 'Druckluft'), p(4, 'Kühlung'), p(5, 'Logistik'), p(6, 'Verwaltung')];
}

/** Die sieben Kostenstellen — 9000 endet am 31.12.2026, 9010/9020 beginnen am 01.01.2027. */
export function kostenstellenAhrenberg(): Kostenstelle[] {
  const k = (kz: string, name: string, ab: string, bis: string | null = null): Kostenstelle => ({
    id: kostenstelleId(kz),
    kennzeichen: kz,
    name,
    gueltig_ab: ab,
    gueltig_bis: bis,
    angelegt_am: EINFUEHRUNG,
  });
  return [
    k('4100', 'Spritzguss', '2026-10-01'),
    k('4200', 'Montage', '2026-10-01'),
    k('4300', 'Logistik', '2026-10-01'),
    k('9000', 'Infrastruktur (Druckluft, Kühlung, PV)', '2026-10-01', '2026-12-31'),
    k('9100', 'Verwaltung', '2026-10-01'),
    k('9010', 'Druckluft', '2027-01-01'),
    k('9020', 'Kühlung', '2027-01-01'),
  ];
}

function messstelle(over: Partial<Messstelle> & Pick<Messstelle, 'id' | 'kennzeichen' | 'name'>): Messstelle {
  return {
    art: 'gemessen',
    medium: 'Strom',
    lebenszyklus: 'aktiv',
    fehlt: [],
    notiz: null,
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    nebengroessen: [],
    orte: [],
    elektrische_stellung: [],
    fuehrende_quelle: [],
    anschlussleistung_kw: null,
    ...over,
  };
}

export function ms06(): Messstelle {
  return messstelle({
    id: MS_IDS.ms06,
    kennzeichen: 'MS-06',
    name: 'Spritzguss SG01–SG06',
    nebengroessen: [
      { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert', lebenszyklus: 'aktiv' },
    ],
    orte: [{ ort_art: 'bereich', kennzeichen: 'B-1', gueltig_ab: '2024-03-12', gueltig_bis: null }],
    elektrische_stellung: [
      { anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehler_von: 'MS-01', gueltig_ab: '2024-03-12', gueltig_bis: null },
    ],
    fuehrende_quelle: [
      { komponente: KOMPONENTE_IDS.k5, kanal: 'Wirkenergie Bezug', gueltig_ab: '2024-03-12T00:00:00+01:00', gueltig_bis: null },
    ],
  });
}

export function ms08Vorher(): Messstelle {
  return messstelle({
    id: MS_IDS.ms08,
    kennzeichen: 'MS-08',
    name: 'Kühlung Kaltwassersatz',
    orte: [{ ort_art: 'bereich', kennzeichen: 'B-2', gueltig_ab: '2024-03-12', gueltig_bis: null }],
    elektrische_stellung: [
      { anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehler_von: 'MS-01', gueltig_ab: '2024-03-12', gueltig_bis: null },
    ],
  });
}

/** Der Tag der Einführung (`zeitachse` 01.10.2026) — der Eintragstag der Bestands-Zuordnungen. */
export const EINFUEHRUNG_TAG = '2026-10-01';

/**
 * MS-08 am 01.10.2026, eben angelegt — noch ohne Ort und Stellung (Entwurf). Den Ort B-2 ab
 * 12.03.2024 trägt die Einführung an diesem Tag ein: `zuordnungen` „rückwirkend (933 Tage)“.
 */
export function ms08Angelegt(): Messstelle {
  return { ...ms08Vorher(), lebenszyklus: 'entwurf', fehlt: ['ort'], orte: [], elektrische_stellung: [] };
}

/** Nach „Ort ab 01.03.2027 eintragen“: B-2 bis 28.02.2027, B-3 ab 01.03.2027 (`zuordnungen`). */
export function ms08OrtGeplant(): Messstelle {
  return {
    ...ms08Vorher(),
    orte: [
      { ort_art: 'bereich', kennzeichen: 'B-2', gueltig_ab: '2024-03-12', gueltig_bis: '2027-02-28' },
      { ort_art: 'bereich', kennzeichen: 'B-3', gueltig_ab: '2027-03-01', gueltig_bis: null },
    ],
  };
}

/** Der ganze Umzug am 01.03.2027: Ort UND Stellung (AN-2, „Unterzähler von MS-10“). */
export function ms08UmzugGeplant(): Messstelle {
  return {
    ...ms08OrtGeplant(),
    elektrische_stellung: [
      { anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehler_von: 'MS-01', gueltig_ab: '2024-03-12', gueltig_bis: '2027-02-28' },
      { anlage: FIXTURE_IDS.an2, stellung: 'Unterzähler', unterzaehler_von: 'MS-10', gueltig_ab: '2027-03-01', gueltig_bis: null },
    ],
  };
}

export function prozesseVon(m: Messstelle): MessstelleProzesse {
  const p = m.kennzeichen === 'MS-06' ? { n: 1, name: 'Spritzguss' } : { n: 4, name: 'Kühlung' };
  return {
    messstelle_id: m.id,
    kennzeichen: m.kennzeichen,
    am: null,
    prozesse: [
      {
        id: `${m.kennzeichen}-prozess-1`,
        prozess: { id: prozessId(p.n), kennzeichen: `P-${p.n}` },
        name: p.name,
        gueltig_ab: '2026-10-01',
        gueltig_bis: null,
        endet_mit_prozess: false,
      },
    ],
  };
}

/** MS-06 und MS-08: 4100 zu 100 % seit 01.10.2026 (`kostenstellen_anteile`). */
export function verteilungVon(m: Messstelle): MessstelleVerteilung {
  return {
    messstelle_id: m.id,
    kennzeichen: m.kennzeichen,
    am: null,
    zustand: null,
    anteile: [
      {
        id: `${m.kennzeichen}-anteil-1`,
        kostenstelle: { id: KOSTENSTELLE_IDS.k4100, kennzeichen: '4100' },
        name: 'Spritzguss',
        anteil_prozent: '100',
        gueltig_ab: '2026-10-01',
        gueltig_bis: null,
        endet_mit_kostenstelle: false,
      },
    ],
  };
}

// -------------------------------------------------------------------- Protokoll

const INES: ProtokollUrheber = { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' };

function eintrag(
  m: Messstelle,
  e: Pick<ProtokollEintrag, 'id' | 'art' | 'text' | 'gilt_ab' | 'eingetragen_am' | 'zeitform'> & Partial<ProtokollEintrag>,
): ProtokollEintrag {
  const bezug: ProtokollBezug = { art: 'messstelle', id: m.id, kennzeichen: m.kennzeichen, name: m.name };
  return { quelle: 'messstelle', bezug, gilt_bis: null, grund: null, urheber: INES, alt: null, neu: null, ...e };
}

/** Die Einführung am 01.10.2026 — Anlegen, Ort und Stellung rückwirkend ab 12.03.2024, Prozess, Kostenstelle, Quelle. */
function einfuehrung(m: Messstelle, nr: number, ort: string): ProtokollEintrag[] {
  const um = (min: string) => `2026-10-01T09:${min}:00+02:00`;
  const id = (n: number) => `messstelle:${nr * 10 + n}`;
  const bezug = m.kennzeichen === 'MS-06' ? 'P-1' : 'P-4';
  return [
    eintrag(m, {
      id: id(6),
      art: 'quelle_gebunden',
      text: `Quelle gebunden: ${m.kennzeichen === 'MS-06' ? 'Z-5a' : 'GR-6'} · Wirkenergie · Bezug (führend)`,
      gilt_ab: '2024-03-12T00:00:00+01:00',
      eingetragen_am: um('14'),
      zeitform: 'rueckwirkend',
      grund: 'Bestandsübernahme',
    }),
    eintrag(m, {
      id: id(5),
      art: 'verteilung_geaendert',
      text: 'Verteilung auf Kostenstellen geändert: 100 % 4100',
      gilt_ab: EINFUEHRUNG,
      eingetragen_am: um('12'),
      zeitform: 'sofort',
    }),
    eintrag(m, {
      id: id(4),
      art: 'prozesse_zugeordnet',
      text: `Prozesse zugeordnet: ${bezug}`,
      gilt_ab: EINFUEHRUNG,
      eingetragen_am: um('12'),
      zeitform: 'sofort',
    }),
    eintrag(m, {
      id: id(3),
      art: 'stellung_zugeordnet',
      text: 'Elektrische Stellung zugeordnet: Unterzähler von MS-01',
      gilt_ab: '2024-03-12T00:00:00+01:00',
      eingetragen_am: um('12'),
      zeitform: 'rueckwirkend',
    }),
    eintrag(m, {
      id: id(2),
      art: 'ort_zugeordnet',
      text: `Ort zugeordnet: ${ort}`,
      gilt_ab: '2024-03-12T00:00:00+01:00',
      eingetragen_am: um('12'),
      zeitform: 'rueckwirkend',
    }),
    eintrag(m, {
      id: id(1),
      art: 'angelegt',
      text: `Messstelle angelegt: ${m.name}`,
      gilt_ab: EINFUEHRUNG,
      eingetragen_am: um('12'),
      zeitform: 'sofort',
    }),
  ];
}

function seite(eintraege: ProtokollEintrag[]): Protokoll {
  return { eintraege, achse: 'eintrag', von: null, bis: null, weiter: null };
}

export function protokollMs06(): Protokoll {
  return seite(einfuehrung(ms06(), 6, 'B-1'));
}

export function protokollMs08Vorher(): Protokoll {
  return seite(einfuehrung(ms08Vorher(), 8, 'B-2'));
}

/** Nach „Ort ab 01.03.2027 eintragen“ — heute um 10:15 eingetragen, angekündigt; die jüngste Zeile oben. */
export function protokollMs08OrtGeplant(): Protokoll {
  const m = ms08OrtGeplant();
  return seite([
    eintrag(m, {
      id: 'messstelle:90',
      art: 'ort_zugeordnet',
      text: 'Ort zugeordnet: B-3',
      gilt_ab: '2027-03-01T00:00:00+01:00',
      eingetragen_am: SEITE_JETZT,
      zeitform: 'angekuendigt',
    }),
    ...einfuehrung(ms08Vorher(), 8, 'B-2'),
  ]);
}

/** MS-08 eben angelegt: nur der Anlege-Eintrag der Einführung. */
export function protokollMs08Angelegt(): Protokoll {
  const m = ms08Angelegt();
  return seite([
    eintrag(m, {
      id: 'messstelle:81',
      art: 'angelegt',
      text: `Messstelle angelegt: ${m.name}`,
      gilt_ab: EINFUEHRUNG,
      eingetragen_am: '2026-10-01T09:12:00+02:00',
      zeitform: 'sofort',
    }),
  ]);
}

// -------------------------------------------------------------------- MS-10 (UEMS AP-13 IP-3)

/**
 * MS-10 Netzbezug Halle 2: Gebäude G-2 und Hauptzähler in AN-2 seit 01.10.2026 — wie seine Zeile im Register
 * (`messstellenRegisterFixtures`). Für die Werte-Bühne mit Versionen (F21, `wertVersionenFixtures`); die Quelle
 * nennt der Kopf aus dem Register.
 */
export function ms10(): Messstelle {
  return messstelle({
    id: MS_IDS.ms10,
    kennzeichen: 'MS-10',
    name: 'Netzbezug Halle 2',
    orte: [{ ort_art: 'gebaeude', kennzeichen: 'G-2', gueltig_ab: '2026-10-01', gueltig_bis: null }],
    elektrische_stellung: [
      { anlage: FIXTURE_IDS.an2, stellung: 'Hauptzähler', unterzaehler_von: null, gueltig_ab: '2026-10-01', gueltig_bis: null },
    ],
  });
}

/**
 * UEMS AP-13 IP-6 · MS-16 Netzbezug Lindach: am Standort Werk Lindach, Hauptzähler von AN-3, gebunden an K-11 Netzzähler
 * Lindach seit 15.10.2026 — die Bindung beginnt im Oktober (O16, W5).
 */
export function ms16(): Messstelle {
  return messstelle({
    id: MS_IDS.ms16,
    kennzeichen: 'MS-16',
    name: 'Netzbezug Lindach',
    orte: [{ ort_art: 'standort', kennzeichen: 'ST-2', gueltig_ab: '2026-10-15', gueltig_bis: null }],
    elektrische_stellung: [
      { anlage: FIXTURE_IDS.an3, stellung: 'Hauptzähler', unterzaehler_von: null, gueltig_ab: '2026-10-15', gueltig_bis: null },
    ],
  });
}

/**
 * UEMS AP-13 IP-6 · MS-21 Gas Heizung Verwaltung: eingerichtet, Ort G-3, ohne Datenquelle und ohne elektrische Stellung
 * (Referenz: „keine Datenquelle — manuelle Ablesung (AP-09)“) — der Leerzustand Z4.
 */
export function ms21(): Messstelle {
  return messstelle({
    id: MS_IDS.ms21,
    kennzeichen: 'MS-21',
    name: 'Gas Heizung Verwaltung',
    medium: 'Gas',
    lebenszyklus: 'eingerichtet',
    hauptgroesse: { groesse: 'Volumen', richtung: 'Bezug', einheit: 'm³', wertart: 'Zählerstand' },
    orte: [{ ort_art: 'gebaeude', kennzeichen: 'G-3', gueltig_ab: '2026-10-01', gueltig_bis: null }],
  });
}

/** Ohne Prozess und ohne Kostenstelle: der Hauptzähler MS-10 ist keiner zugeordnet (`prozesse`, `kostenstellen_anteile`). */
export function ohneProzesse(m: Messstelle): MessstelleProzesse {
  return { messstelle_id: m.id, kennzeichen: m.kennzeichen, am: null, prozesse: [] };
}

export function ohneVerteilung(m: Messstelle): MessstelleVerteilung {
  return { messstelle_id: m.id, kennzeichen: m.kennzeichen, am: null, zustand: null, anteile: [] };
}

/** Das Protokoll von MS-10 in der Bühne: leer — die Werte-Bühne braucht es nicht. */
export function protokollMs10(): Protokoll {
  return seite([]);
}
