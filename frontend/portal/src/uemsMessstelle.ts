/**
 * Die REINEN Regeln der logischen Messstelle (UEMS AP-04 IP-1, Prosa in
 * `docs/contracts/v2/messstelle.md`): Kennzeichen, Größen-Katalog,
 * Lebenszyklus, Quellenbindung mit Zeitstrahl und elektrische Stellung.
 *
 * Der Zwilling im Server ist `services/api .../uems/MessstelleRegeln`; beide
 * fahren dieselben Vektoren (`docs/contracts/v2/messstelle-vectors.json`).
 * **Wer eine Regel ändert, ändert beide Seiten und die Vektor-Datei.**
 *
 * Der Server urteilt mit dem Zwilling (Messstellen-Schnittstelle IP-3,
 * Quellenbindung IP-13); eine Fläche (IP-5/IP-6) ruft dieses Modul noch nicht an.
 *
 * - **Kennzeichen (E7):** automatisch `MS-0001` … fortlaufend je Kundenbereich,
 *   änderbar auf 2–16 Zeichen aus `A–Z 0–9 - . /`. Nichts wird umgewandelt —
 *   `ms-01` ist ein Formfehler. Belegt ist, was eine Messstelle trägt, ein
 *   archiviertes UND das frühere Kennzeichen einer umbenannten (Regel 9).
 * - **Lebenszyklus (E8, E9):** eine Quelle ist keine Voraussetzung; eine
 *   berechnete Messstelle bleibt ohne Formel (bis AP-10) ein Entwurf und braucht
 *   keinen Ort.
 * - **Quellenbindung (Regeln 1, 2, 5–7):** je Größe und Zeitpunkt höchstens EINE
 *   führende Quelle. Die einzige Änderung an Bestehendem: eine neue offene
 *   führende Quelle beendet die laufende genau zu ihrem Beginn. Lücken sind
 *   erlaubt und im Zeitstrahl ein eigener Abschnitt ohne Quelle.
 * - **Stellung (Regel 8, E12):** „Unterzähler von" zeigt auf eine Messstelle
 *   derselben Anlage, nie auf sich selbst, nie im Kreis; je Anlage und Richtung
 *   höchstens ein Hauptzähler, alle an DEMSELBEN Zähler.
 */

import { VORGABE_ZEITZONE, lokalerTag, mitternacht } from './uemsOrtsbaum';

/** Womit ein automatisches Kennzeichen beginnt. */
export const KENNZEICHEN_PRAEFIX = 'MS-';

/** Mit wie vielen Ziffern die laufende Nummer mindestens geschrieben wird. */
export const KENNZEICHEN_STELLEN = 4;

/** Welche Zeichen ein Kennzeichen tragen darf (E7). */
export const KENNZEICHEN_MUSTER = '^[A-Z0-9./-]{2,16}$';

export const KENNZEICHEN_MIN_ZEICHEN = 2;
export const KENNZEICHEN_MAX_ZEICHEN = 16;

const KENNZEICHEN = new RegExp(KENNZEICHEN_MUSTER);

/** Das geschlossene Vokabular der Medien, in dieser Reihenfolge (AP-00 E11). */
export const MEDIEN = ['Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft'] as const;

/** Was der Anlege-Dialog im ersten Umfang anbietet. */
export const MEDIEN_WAEHLBAR = ['Strom'] as const;

export const LEBENSZYKLUS = ['entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert'] as const;
export type Lebenszyklus = (typeof LEBENSZYKLUS)[number];

/** Was zur Einrichtung fehlen kann — in der Reihenfolge, in der es genannt wird. */
export const FEHLT = ['kennzeichen', 'name', 'hauptgroesse', 'ort', 'formel', 'eingaenge'] as const;
export type Fehlt = (typeof FEHLT)[number];

export const BINDUNG_STATUS = ['geplant', 'gilt', 'beendet'] as const;
export type BindungStatus = (typeof BINDUNG_STATUS)[number];

/** Wie aus dem Messwert die Größe wird; „integration" ist für AP-08 gekennzeichnet. */
export const HERLEITUNGEN = ['zaehlerstand', 'differenzen', 'integration', 'momentanwert'] as const;
export type Herleitung = (typeof HERLEITUNGEN)[number];

export const VERGLEICH_ZWECKE = ['Plausibilität', 'Ersatz bei Ausfall', 'Abrechnungszähler'] as const;

export const STELLUNGEN = ['Hauptzähler', 'Unterzähler', 'Erzeuger', 'Speicher', 'Abzweig', 'keine'] as const;

/** Warum eine Stellung abgelehnt wird — in der Reihenfolge der Prüfung. */
export const STELLUNG_GRUENDE = [
  'nicht_elektrisch',
  'bezug_nur_bei_unterzaehler',
  'bezug_fehlt',
  'selbst',
  'fremde_anlage',
  'zyklus',
] as const;
export type StellungGrund = (typeof STELLUNG_GRUENDE)[number];

/** Woran ein Messwert an der Größe scheitert — in der Reihenfolge der Prüfung. */
export const PASSUNG_GRUENDE = ['wertart', 'groesse', 'einheit', 'richtung', 'anteil'] as const;
export type PassungGrund = (typeof PASSUNG_GRUENDE)[number];

/** Das Vokabular `anteil` der Quellenbindung (AP-08 IP-7, E15); kein Anteil ist `null`. */
export const ANTEILE = ['positiv', 'negativ'] as const;
export type Anteil = (typeof ANTEILE)[number];

/**
 * Regel 7, Ausnahme „Anteil“ (AP-08 E15, W8): welche Richtung der Anteil eines Vorzeichen-Werts
 * speist — je Katalogwort. Ein Katalogwort, das hier fehlt, hat keinen Anteil.
 */
export const ANTEIL_RICHTUNGEN: Readonly<Record<string, Readonly<Record<Anteil, string>>>> = {
  import_export: { positiv: 'Bezug', negativ: 'Abgabe' },
};

/**
 * Zwei Flüsse in EINER Messreihe (MessstelleRegeln.RICHTUNGSPAAR). Das ist nicht das
 * Quellenbindungs-Vokabular `ANTEIL_RICHTUNGEN`: hier stehen ausschließlich die Kundenwörter,
 * mit denen gespeicherte positive und negative Mengen nebeneinander angezeigt werden.
 */
export const RICHTUNGSPAAR: Readonly<Record<string, Readonly<Record<Anteil, string>>>> = {
  import_export: { positiv: 'Bezug', negativ: 'Abgabe' },
  charge_discharge: { positiv: 'Laden', negativ: 'Entladen' },
};

export type GroesseGrund = 'groesse' | 'medium' | 'einheit' | 'richtung' | 'wertart';

export const HINWEISE = ['ablesestand_pruefen'] as const;
export type Hinweis = (typeof HINWEISE)[number];

/** Wo ein Zeitpunkt gegen „jetzt" steht (E2): rückwirkend markiert, angekündigt in der Zukunft. */
export const RUECKWIRKUNG_ARTEN = ['rueckwirkend', 'ab_jetzt', 'angekuendigt'] as const;
export type RueckwirkungArt = (typeof RUECKWIRKUNG_ARTEN)[number];

/** Die Fehlertabelle: Code, Status der Schnittstelle und wer ihn feststellt. */
export const FEHLER = [
  { code: 'kennzeichen_format', status: 400, geprueftVon: 'MessstelleRegeln' },
  { code: 'kennzeichen_belegt', status: 409, geprueftVon: 'MessstelleRegeln' },
  { code: 'groesse_ungueltig', status: 400, geprueftVon: 'MessstelleRegeln' },
  { code: 'medium_ohne_quelle', status: 422, geprueftVon: 'MessstelleRegeln' },
  { code: 'vergleich_ohne_zweck', status: 400, geprueftVon: 'MessstelleRegeln' },
  { code: 'quelle_passt_nicht', status: 422, geprueftVon: 'MessstelleRegeln' },
  { code: 'kanal_bereits_fuehrend', status: 409, geprueftVon: 'MessstelleRegeln' },
  { code: 'zeitraum_ungueltig', status: 400, geprueftVon: 'MessstelleRegeln' },
  { code: 'zeitpunkt_vor_vorgaenger', status: 422, geprueftVon: 'MessstelleRegeln' },
  { code: 'bindung_ueberlappt', status: 409, geprueftVon: 'MessstelleRegeln' },
  { code: 'hauptzaehler_vorhanden', status: 409, geprueftVon: 'MessstelleRegeln' },
  { code: 'stellung_ungueltig', status: 422, geprueftVon: 'MessstelleRegeln' },
  // Diese beiden prüft erst IP-7 (Zuordnungen), nicht dieses Modul.
  { code: 'anteile_summe', status: 422, geprueftVon: 'IP-7' },
  { code: 'ort_ungueltig', status: 422, geprueftVon: 'IP-7' },
  // Die Quellenbindung (IP-13): ohne Gerät zum Zeitpunkt; eine beendete Quelle nie erneut.
  { code: 'kein_geraet_zum_zeitpunkt', status: 422, geprueftVon: 'MessstelleRegeln' },
  { code: 'bindung_bereits_beendet', status: 409, geprueftVon: 'MessstelleRegeln' },
] as const;
export type FehlerCode = (typeof FEHLER)[number]['code'];

const STROM = 'Strom';
const ZAEHLERSTAND = 'Zählerstand';
const MOMENTANWERT = 'Momentanwert';

// ----------------------------------------------------------- Größen-Katalog

/** Aus welchem Messwert eine Größe gespeist werden darf. */
export interface KatalogQuelle {
  kanalGroesse: string;
  kanalWertart: string;
  /** Wenn gesetzt: nur für diese Wertart der Größe. */
  nurWertart: string | null;
}

export interface KatalogEintrag {
  groesse: string;
  medien: string[];
  einheit: string;
  richtungen: string[];
  wertarten: string[];
  quellen: KatalogQuelle[];
  /**
   * Richtungen, die NUR eine berechnete Messstelle tragen darf (AP-10 IP-4: `saldiert`) —
   * bewusst NICHT in `richtungen`, damit eine gemessene Reihe sie nie bekommt.
   */
  richtungenNurBerechnet?: string[];
}

/**
 * Die Richtung einer Bilanz-Differenz „Bezug − Abgabe" (AP-10 E1, Formel-Typ `saldo`): ein
 * ADDITIVER Katalog-Eintrag der Wirkenergie, nur für `art = berechnet`, nie an einem Messkanal.
 */
export const SALDIERT = 'saldiert';

/**
 * Der Größen-Katalog (AP-04 §4.1). „Laden / Entladen" bei der Wirkenergie ist
 * die zusammengefasste Richtung des Speichers (E1, MS-04); aus einer Leistung
 * wird nur eine Intervallmenge, nie ein Zählerstand. `saldiert` gibt es nur an
 * einer berechneten Messstelle (AP-10 IP-4).
 */
export const GROESSEN_KATALOG: KatalogEintrag[] = [
  {
    groesse: 'Wirkenergie',
    medien: [STROM],
    einheit: 'kWh',
    richtungen: ['Bezug', 'Abgabe', 'Erzeugung', 'Laden', 'Entladen', 'Laden / Entladen'],
    wertarten: [ZAEHLERSTAND, 'Intervallmenge'],
    quellen: [
      { kanalGroesse: 'Wirkenergie', kanalWertart: 'counter', nurWertart: null },
      { kanalGroesse: 'Wirkleistung', kanalWertart: 'gauge', nurWertart: 'Intervallmenge' },
    ],
    richtungenNurBerechnet: [SALDIERT],
  },
  {
    groesse: 'Wirkleistung',
    medien: [STROM],
    einheit: 'kW',
    richtungen: ['Bezug', 'Abgabe', 'Erzeugung', 'Laden', 'Entladen', 'richtungslos'],
    wertarten: [MOMENTANWERT],
    quellen: [{ kanalGroesse: 'Wirkleistung', kanalWertart: 'gauge', nurWertart: null }],
  },
  {
    groesse: 'Blindenergie',
    medien: [STROM],
    einheit: 'kvarh',
    richtungen: ['Bezug', 'Abgabe'],
    wertarten: [ZAEHLERSTAND, 'Intervallmenge'],
    quellen: [{ kanalGroesse: 'Blindenergie', kanalWertart: 'counter', nurWertart: null }],
  },
  {
    groesse: 'Scheinleistung',
    medien: [STROM],
    einheit: 'kVA',
    richtungen: ['richtungslos'],
    wertarten: [MOMENTANWERT],
    quellen: [{ kanalGroesse: 'Scheinleistung', kanalWertart: 'gauge', nurWertart: null }],
  },
  {
    groesse: 'Ladestand',
    medien: [STROM],
    einheit: '%',
    richtungen: ['richtungslos'],
    wertarten: [MOMENTANWERT],
    quellen: [{ kanalGroesse: 'Ladestand', kanalWertart: 'gauge', nurWertart: null }],
  },
  {
    groesse: 'Volumen',
    medien: ['Gas'],
    einheit: 'm³',
    richtungen: ['Bezug'],
    wertarten: [ZAEHLERSTAND, 'Intervallmenge'],
    quellen: [],
  },
];

/** Welche Einheiten ein Messwert je Größe tragen darf, weil sie sich umrechnen lassen. */
export const KANAL_EINHEITEN: Record<string, string[]> = {
  Wirkenergie: ['Wh', 'kWh', 'MWh'],
  Wirkleistung: ['W', 'kW', 'MW'],
  Blindenergie: ['varh', 'kvarh'],
  Scheinleistung: ['VA', 'kVA'],
  Ladestand: ['%'],
};

/** Eine Messgröße: was, in welche Richtung, in welcher Einheit, wie zu lesen. */
export interface Groesse {
  groesse: string;
  richtung: string;
  einheit: string;
  wertart: string;
}

export interface GroesseUrteil {
  fehler: 'groesse_ungueltig' | null;
  grund: GroesseGrund | null;
}

const katalog = (groesse: string): KatalogEintrag | undefined =>
  GROESSEN_KATALOG.find((e) => e.groesse === groesse);

/**
 * Steht die Größe mit diesem Medium im Katalog? Sonst `groesse_ungueltig` mit
 * dem ERSTEN verletzten Merkmal: groesse → medium → einheit → richtung → wertart.
 *
 * `art` (AP-10 IP-4): nur `berechnet` darf zusätzlich eine Richtung aus
 * `richtungenNurBerechnet` tragen (`saldiert`). Ohne Art urteilt der Katalog wie
 * vorher und wie die Datenbank-Funktion — `saldiert` ist dann `richtung`.
 */
export function groessePruefen(medium: string, g: Groesse, art?: string | null): GroesseUrteil {
  const e = katalog(g.groesse);
  const grund: GroesseGrund | null = !e
    ? 'groesse'
    : !e.medien.includes(medium)
      ? 'medium'
      : e.einheit !== g.einheit
        ? 'einheit'
        : !richtungErlaubt(e, art ?? null, g.richtung)
          ? 'richtung'
          : !e.wertarten.includes(g.wertart)
            ? 'wertart'
            : null;
  return { fehler: grund ? 'groesse_ungueltig' : null, grund };
}

const richtungErlaubt = (e: KatalogEintrag, art: string | null, richtung: string): boolean =>
  e.richtungen.includes(richtung) ||
  (art === 'berechnet' && (e.richtungenNurBerechnet ?? []).includes(richtung));

// -------------------------------------------------------------- Kennzeichen

/** Trägt das Kennzeichen nur erlaubte Zeichen in erlaubter Länge? Nichts wird umgewandelt. */
export function kennzeichenFormatGueltig(kandidat: string | null | undefined): boolean {
  return kandidat != null && KENNZEICHEN.test(kandidat);
}

/** Das automatische Kennzeichen zur laufenden Nummer: `22 → MS-0022`. */
export function automatisch(nummer: number): string {
  return KENNZEICHEN_PRAEFIX + String(nummer).padStart(KENNZEICHEN_STELLEN, '0');
}

/** Der Vorschlag und der Zähler, der gilt, sobald er gespeichert wird. */
export interface Vorschlag {
  kennzeichen: string;
  zaehler: number;
}

/**
 * Der nächste automatische Vorschlag: die kleinste Nummer ÜBER dem Zähler,
 * deren Kennzeichen niemand trägt oder trug. Eine übersprungene Nummer wird nie
 * mehr vergeben.
 */
export function kennzeichenVorschlag(zaehler: number, belegt: Iterable<string>): Vorschlag {
  const b = new Set(belegt);
  let n = zaehler + 1;
  while (b.has(automatisch(n))) n += 1;
  return { kennzeichen: automatisch(n), zaehler: n };
}

/**
 * Ein belegtes Kennzeichen: wer es trägt (`frueher: false`) oder trug
 * (`frueher: true`); `messstelle` ist dessen heutiges Kennzeichen.
 */
export interface Vergeben {
  kennzeichen: string;
  messstelle: string;
  name: string;
  archiviert: boolean;
  frueher: boolean;
}

export interface KennzeichenUrteil {
  fehler: 'kennzeichen_format' | 'kennzeichen_belegt' | null;
  bestehend: Vergeben | null;
}

/**
 * Darf `kandidat` das Kennzeichen der Messstelle `fuerMessstelle` (heutiges
 * Kennzeichen; `null` bei einer neuen) werden? Erst die Form, dann die Belegung —
 * wobei die Messstelle nie mit sich selbst kollidiert und zu ihrem eigenen
 * früheren Kennzeichen zurück darf.
 */
export function kennzeichenPruefen(
  kandidat: string,
  fuerMessstelle: string | null,
  vergeben: Vergeben[],
): KennzeichenUrteil {
  if (!kennzeichenFormatGueltig(kandidat)) return { fehler: 'kennzeichen_format', bestehend: null };
  const v = vergeben.find((x) => x.kennzeichen === kandidat && x.messstelle !== fuerMessstelle);
  return v ? { fehler: 'kennzeichen_belegt', bestehend: v } : { fehler: null, bestehend: null };
}

// ------------------------------------------------------------- Lebenszyklus

/** Eine Quelle mit ihrem Zeitraum `[gueltigAb, gueltigBis)`; `null` = bis auf Weiteres. */
export interface QuelleZeitraum {
  komponente: string;
  kanal: string;
  geraet: string;
  einbau: string;
  gueltigAb: string;
  gueltigBis: string | null;
}

export interface LebenszyklusEingang {
  art: string;
  medium: string;
  kennzeichen: string | null;
  name: string | null;
  hauptgroesse: Groesse | null;
  ortVorhanden: boolean;
  /** Nur berechnet: ob eine Formel hinterlegt ist (erst mit AP-10 möglich). */
  formelVorhanden: boolean;
  /** Nur berechnet: ob alle Eingänge der Formel eingerichtet sind. */
  eingaengeEingerichtet: boolean;
  angehalten: boolean;
  archiviert: boolean;
  fuehrendeQuelle: QuelleZeitraum[];
  jetzt: string;
}

export interface LebenszyklusErgebnis {
  lebenszyklus: Lebenszyklus;
  eingerichtet: boolean;
  fehlt: Fehlt[];
  /** Genau `quelleVorhanden` von `liefertDaten` (uemsZustand.ts): ohne sie „Keine Datenquelle". */
  quelleVorhanden: boolean;
}

/**
 * Wo die Messstelle in ihrem Leben steht (AP-04 §4.5). Gemessen: eingerichtet
 * mit Kennzeichen + Name + Hauptgröße + Ort — eine Quelle ist KEINE
 * Voraussetzung (E8). Berechnet: mit Formel und eingerichteten Eingängen, ohne
 * Ort-Pflicht; bis AP-10 gibt es keine Formel, also bleibt sie Entwurf (E9).
 * Eingerichtet wird von selbst aktiv. Vorrang: archiviert → Entwurf →
 * angehalten → aktiv.
 */
export function lebenszyklus(e: LebenszyklusEingang): LebenszyklusErgebnis {
  const berechnet = e.art === 'berechnet';
  const fehlt: Fehlt[] = [];
  if (leer(e.kennzeichen)) fehlt.push('kennzeichen');
  if (leer(e.name)) fehlt.push('name');
  if (!e.hauptgroesse) fehlt.push('hauptgroesse');
  if (!berechnet && !e.ortVorhanden) fehlt.push('ort');
  if (berechnet && !e.formelVorhanden) fehlt.push('formel');
  if (berechnet && e.formelVorhanden && !e.eingaengeEingerichtet) fehlt.push('eingaenge');
  const eingerichtet = fehlt.length === 0;
  const zyklus: Lebenszyklus = e.archiviert
    ? 'archiviert'
    : !eingerichtet
      ? 'entwurf'
      : e.angehalten
        ? 'angehalten'
        : 'aktiv';
  const jetzt = minute(e.jetzt);
  const quelleVorhanden =
    !berechnet && e.fuehrendeQuelle.some((q) => gilt(q.gueltigAb, q.gueltigBis, jetzt));
  return { lebenszyklus: zyklus, eingerichtet, fehlt, quelleVorhanden };
}

// ------------------------------------------------------------ Quellenbindung

/** Ein abgelesener Zählerstand; `einheit` darf fehlen (dann gibt es einen Hinweis). */
export interface Stand {
  wert: number;
  einheit: string | null;
}

/** Eine bestehende Quelle der Messstelle, mit der Größe, zu der sie gehört. */
export interface Bindung {
  rolle: 'fuehrend' | 'vergleich';
  groesse: string;
  richtung: string;
  komponente: string;
  kanal: string;
  geraet: string;
  einbau: string;
  kanalWertart: string;
  zweck: string | null;
  gueltigAb: string;
  gueltigBis: string | null;
}

/** Die Quelle, die gebunden werden soll, samt dem, was der Messwert-Katalog über sie weiß. */
export interface NeueBindung {
  rolle: 'fuehrend' | 'vergleich';
  zweck: string | null;
  komponente: string;
  kanal: string;
  /** Das Gerät, dessen Einbau die Komponente zu `gueltigAb` speist; `null` (mit `einbau`): keine Speisung. */
  geraet: string | null;
  einbau: string | null;
  kanalGroesse: string | null;
  /** `null`, wenn der Katalog keine EINE Vertrags-Richtung kennt (Vorzeichen-Wert `import_export` — bindet nur mit `anteil`). */
  kanalRichtung: string | null;
  kanalEinheit: string | null;
  kanalWertart: string | null;
  gueltigAb: string;
  gueltigBis: string | null;
  endstandVorgaenger: Stand | null;
  anfangsstand: Stand | null;
  /** Bis wann dieser Einbau die Komponente speist; `null` = bis auf Weiteres. */
  geraetBis: string | null;
  /** Das Katalogwort `direction` des Messwerts (`import_export` …); ohne Anteil nicht gelesen. */
  kanalDirection?: string | null;
  /** `positiv` | `negativ` | `null` = der ganze Wert (AP-08 IP-7). */
  anteil?: Anteil | null;
}

/** Derselbe Messwert speist in diesem Zeitraum eine ANDERE Messstelle führend — mit seinem Anteil. */
export interface FremdeFuehrung {
  messstelle: string;
  gueltigAb: string;
  gueltigBis: string | null;
  /** `null` = der ganze Wert. */
  anteil?: Anteil | null;
}

export interface BindungEingang {
  /** `binden` fügt hinzu; `wechsel` löst die laufende Quelle ab. */
  vorgang: 'binden' | 'wechsel';
  jetzt: string;
  medium: string;
  /** Beginn des ersten Orts; `null` bei einem Entwurf ohne Ort. */
  messstelleBeginn: string | null;
  /** Die Haupt- oder Nebengröße, an die gebunden wird. */
  ziel: Groesse;
  /** ALLE Quellen der Messstelle, jede mit ihrer Größe. */
  bestehende: Bindung[];
  neu: NeueBindung;
  kanalFuehrendAnderswo: FremdeFuehrung[];
}

/** Ein Abschnitt des Zeitstrahls; `quelle === null` ist eine sichtbare Lücke. */
export interface Abschnitt {
  von: string;
  bis: string | null;
  quelle: QuelleZeitraum | null;
}

export interface BindungUrteil {
  fehler: FehlerCode | null;
  grund: PassungGrund | null;
  /** Die Quelle, an der die neue scheitert. */
  bestehend: Bindung | null;
  /** Die andere Messstelle, die der Messwert schon führend speist. */
  messstelle: string | null;
  /** Die laufende Quelle, die die neue genau zu ihrem Beginn beendet. */
  beendet: { bindung: Bindung; endstand: Stand | null } | null;
  status: BindungStatus | null;
  rueckwirkend: boolean;
  angekuendigt: boolean;
  herleitung: Herleitung | null;
  hinweise: Hinweis[];
  zeitstrahl: Abschnitt[] | null;
  /** Bei `kein_geraet_zum_zeitpunkt`: der erste Zeitpunkt der Quelle ohne speisendes Gerät. */
  ohneGeraetAb: string | null;
}

export interface Passung {
  fehler: 'medium_ohne_quelle' | 'quelle_passt_nicht' | null;
  grund: PassungGrund | null;
  herleitung: Herleitung | null;
}

const passtNicht = (grund: PassungGrund): Passung => ({
  fehler: 'quelle_passt_nicht',
  grund,
  herleitung: null,
});

/** Die Einheiten eines Energie-Zählerstands und wie viele davon eine kWh sind (AP-08 IP-7). */
const JE_KWH: Readonly<Record<string, number>> = { Wh: 1000, kWh: 1, MWh: 0.001 };

/**
 * AP-08 IP-7 (Z6, E4): der größte plausible Zuwachs eines Energie-Zählerstands je Kadenz aus der
 * Anschlussleistung — kW × Kadenz in der Einheit des Zählerstands, auf drei Stellen AUFgerundet.
 * `null` ohne Anschlussleistung oder ohne elektrische Energie-Einheit — nie geraten.
 */
export function hoechstzuwachsJeKadenz(
  anschlussleistungKw: number | null,
  einheit: string,
  kadenzS: number,
): number | null {
  const jeKwh = JE_KWH[einheit];
  if (anschlussleistungKw === null || jeKwh === undefined || anschlussleistungKw <= 0 || kadenzS < 1) return null;
  // Erst auf neun Stellen glätten, dann aufrunden — sonst kippte ein glattes 62,5 als 62,500000001 auf 62,501.
  const tausendstel = Math.round(((anschlussleistungKw * kadenzS * jeKwh) / 3600) * 1e9) / 1e6;
  return Math.ceil(tausendstel) / 1000;
}

/**
 * Passt der Messwert zur Größe (Regel 7)? Medium Strom; dann die Wertart
 * (state/bitfield/text nie; Momentanwert nie aus Zählerstand; Zählerstand nie
 * aus Leistung), die Größe laut Katalog, eine umrechenbare Einheit, dieselbe
 * Richtung. Bei Erfolg sagt `herleitung`, wie aus dem Messwert die Größe wird.
 *
 * Ausnahme „Anteil“ (AP-08 E15, W8): mit `anteil` gilt an der Stelle der Richtung — ein Anteil nur
 * an einem Momentanwert-Messwert, dessen Katalogwort in `ANTEIL_RICHTUNGEN` steht (sonst Grund
 * `anteil`), und die Richtung des Anteils ist die Richtung der Größe (sonst Grund `richtung`).
 */
export function passung(
  medium: string,
  ziel: Groesse,
  kanalGroesse: string | null,
  kanalRichtung: string | null,
  kanalEinheit: string | null,
  kanalWertart: string | null,
  kanalDirection: string | null = null,
  anteil: Anteil | null = null,
): Passung {
  if (medium !== STROM) return { fehler: 'medium_ohne_quelle', grund: null, herleitung: null };
  if (kanalWertart !== 'counter' && kanalWertart !== 'gauge') return passtNicht('wertart');
  if (ziel.wertart === MOMENTANWERT && kanalWertart === 'counter') return passtNicht('wertart');
  if (ziel.wertart === ZAEHLERSTAND && kanalWertart === 'gauge') return passtNicht('wertart');
  const mitGroesse = (katalog(ziel.groesse)?.quellen ?? []).filter((q) => q.kanalGroesse === kanalGroesse);
  if (mitGroesse.length === 0) return passtNicht('groesse');
  const wertartPasst = mitGroesse.some(
    (q) => q.kanalWertart === kanalWertart && (q.nurWertart === null || q.nurWertart === ziel.wertart),
  );
  if (!wertartPasst) return passtNicht('wertart');
  if (!(KANAL_EINHEITEN[kanalGroesse ?? ''] ?? []).includes(kanalEinheit ?? '')) return passtNicht('einheit');
  if (anteil !== null) {
    const richtungen = kanalDirection === null ? undefined : ANTEIL_RICHTUNGEN[kanalDirection];
    const richtungDesAnteils = richtungen === undefined || kanalWertart !== 'gauge' ? undefined : richtungen[anteil];
    if (richtungDesAnteils === undefined) return passtNicht('anteil');
    if (ziel.richtung !== richtungDesAnteils) return passtNicht('richtung');
  } else if (ziel.richtung !== kanalRichtung) {
    return passtNicht('richtung');
  }
  const herleitung: Herleitung =
    kanalWertart === 'counter'
      ? ziel.wertart === ZAEHLERSTAND
        ? 'zaehlerstand'
        : 'differenzen'
      : ziel.wertart === MOMENTANWERT
        ? 'momentanwert'
        : 'integration';
  return { fehler: null, grund: null, herleitung };
}

const abgelehnt = (
  fehler: FehlerCode,
  grund: PassungGrund | null = null,
  bestehend: Bindung | null = null,
  messstelle: string | null = null,
): BindungUrteil => ({
  fehler,
  grund,
  bestehend,
  messstelle,
  beendet: null,
  status: null,
  rueckwirkend: false,
  angekuendigt: false,
  herleitung: null,
  hinweise: [],
  zeitstrahl: null,
  ohneGeraetAb: null,
});

const gleicheQuelle = (b: Bindung, n: NeueBindung): boolean =>
  b.komponente === n.komponente && b.kanal === n.kanal && b.geraet === n.geraet && b.einbau === n.einbau;

/**
 * Darf die neue Quelle gebunden werden — und wie sieht der Zeitstrahl danach
 * aus? Die Prüfreihenfolge ist Teil des Vertrags (der erste Treffer gewinnt):
 * Medium → Zweck → Passung → Zeitraum → Gerät zum Zeitpunkt → Messwert führt
 * schon anderswo → Zeitpunkt vor Vorgänger/Beginn → Überlappung.
 */
export function bindungPruefen(e: BindungEingang): BindungUrteil {
  const n = e.neu;
  const vergleich = n.rolle === 'vergleich';
  if (e.medium !== STROM) return abgelehnt('medium_ohne_quelle');
  if (vergleich && !(VERGLEICH_ZWECKE as readonly (string | null)[]).includes(n.zweck)) {
    return abgelehnt('vergleich_ohne_zweck');
  }
  const p = passung(
    e.medium,
    e.ziel,
    n.kanalGroesse,
    n.kanalRichtung,
    n.kanalEinheit,
    n.kanalWertart,
    n.kanalDirection ?? null,
    n.anteil ?? null,
  );
  if (p.fehler) return abgelehnt(p.fehler, p.grund);
  const ab = zeit(n.gueltigAb);
  const bis = n.gueltigBis === null ? null : zeit(n.gueltigBis);
  if (bis !== null && bis <= ab) return abgelehnt('zeitraum_ungueltig');
  // Ein Messkanal gehört genau einem Gerät (Regel 6, W2): ohne Speisung zu Beginn gibt es
  // ihn nicht, und über das Ende der Speisung hinaus ist er ein anderer (Zählerwechsel).
  const ohneGeraet =
    n.einbau === null
      ? n.gueltigAb
      : n.geraetBis !== null && (bis === null || bis > zeit(n.geraetBis))
        ? n.geraetBis
        : null;
  if (ohneGeraet !== null) return { ...abgelehnt('kein_geraet_zum_zeitpunkt'), ohneGeraetAb: ohneGeraet };
  if (!vergleich) {
    // AP-08 E15: der positive und der negative Anteil führen je eine Messstelle; der ganze Wert schließt jeden aus.
    const anteil = n.anteil ?? null;
    const f = e.kanalFuehrendAnderswo.find(
      (x) =>
        !(anteil !== null && (x.anteil ?? null) !== null && x.anteil !== anteil) &&
        ueberschneiden(ab, bis, zeit(x.gueltigAb), ende(x.gueltigBis)),
    );
    if (f) return abgelehnt('kanal_bereits_fuehrend', null, null, f.messstelle);
  }

  // Dieselbe Größe und Rolle — beim Vergleich zusätzlich derselbe Messwert:
  // Vergleichsquellen gibt es 0..n nebeneinander, nur nicht zweimal dieselbe.
  const gleicheRolle = e.bestehende.filter(
    (b) =>
      b.rolle === n.rolle &&
      b.groesse === e.ziel.groesse &&
      b.richtung === e.ziel.richtung &&
      (!vergleich || gleicheQuelle(b, n)),
  );
  const laufend = vergleich
    ? null
    : gleicheRolle
        .filter((b) => b.gueltigBis === null)
        .reduce<Bindung | null>((m, b) => (m === null || zeit(b.gueltigAb) > zeit(m.gueltigAb) ? b : m), null);
  if (e.vorgang === 'wechsel' && laufend && ab <= zeit(laufend.gueltigAb)) {
    return abgelehnt('zeitpunkt_vor_vorgaenger', null, laufend);
  }
  if (e.messstelleBeginn !== null && ab < zeit(e.messstelleBeginn)) {
    return abgelehnt('zeitpunkt_vor_vorgaenger');
  }

  // Die EINZIGE Änderung an Bestehendem (Regel 2): eine neue offene führende
  // Quelle beendet die laufende genau zu ihrem Beginn.
  const zuBeenden = laufend && bis === null && zeit(laufend.gueltigAb) < ab ? laufend : null;
  const danach = gleicheRolle.map((b) => (b === zuBeenden ? { ...b, gueltigBis: n.gueltigAb } : b));
  const konflikt = danach
    .filter((b) => ueberschneiden(ab, bis, zeit(b.gueltigAb), ende(b.gueltigBis)))
    .reduce<Bindung | null>((m, b) => (m === null || zeit(b.gueltigAb) < zeit(m.gueltigAb) ? b : m), null);
  if (konflikt) return abgelehnt('bindung_ueberlappt', null, konflikt);

  const jetzt = minute(e.jetzt);
  const status: BindungStatus = ab > jetzt ? 'geplant' : bis === null || bis > jetzt ? 'gilt' : 'beendet';
  const zeitstrahl = vergleich
    ? null
    : zeitstrahlAus(e.messstelleBeginn, [
        ...danach.map(({ komponente, kanal, geraet, einbau, gueltigAb, gueltigBis }) => ({
          komponente,
          kanal,
          geraet,
          einbau,
          gueltigAb,
          gueltigBis,
        })),
        {
          komponente: n.komponente,
          kanal: n.kanal,
          // Beide gesetzt: ohne Einbau hat die Prüfung oben schon abgelehnt.
          geraet: n.geraet as string,
          einbau: n.einbau as string,
          gueltigAb: n.gueltigAb,
          gueltigBis: n.gueltigBis,
        },
      ]);
  return {
    fehler: null,
    grund: null,
    bestehend: null,
    messstelle: null,
    beendet: zuBeenden
      ? { bindung: { ...zuBeenden, gueltigBis: n.gueltigAb }, endstand: n.endstandVorgaenger }
      : null,
    status,
    rueckwirkend: ab < jetzt,
    angekuendigt: ab > jetzt,
    herleitung: p.herleitung,
    hinweise: ablesestandHinweise(zuBeenden, n),
    zeitstrahl,
    ohneGeraetAb: null,
  };
}

/** Eine bestehende Quelle beenden: `gueltigBis` setzen (auch in der Zukunft — angekündigt), optional mit Endstand. */
export interface BeendenEingang {
  jetzt: string;
  bindung: Bindung;
  gueltigBis: string;
  endstand: Stand | null;
}

export interface BeendenUrteil {
  fehler: FehlerCode | null;
  status: BindungStatus | null;
  rueckwirkend: boolean;
  angekuendigt: boolean;
  hinweise: Hinweis[];
}

/**
 * Darf die Quelle zu `gueltigBis` beendet werden (Regel 2)? Eine Quelle wird genau
 * EINMAL beendet — eine beendete nie verschoben (409 `bindung_bereits_beendet`); das
 * Ende liegt nach dem Beginn (400 `zeitraum_ungueltig`). Beenden hinterlässt eine
 * Lücke, bis eine neue Quelle beginnt — nie aufgefüllt. Ein Endstand ohne Einheit ist
 * ein Hinweis, kein Verbot.
 */
export function beendenPruefen(e: BeendenEingang): BeendenUrteil {
  const nein = (fehler: FehlerCode): BeendenUrteil => ({
    fehler,
    status: null,
    rueckwirkend: false,
    angekuendigt: false,
    hinweise: [],
  });
  if (e.bindung.gueltigBis !== null) return nein('bindung_bereits_beendet');
  const bis = zeit(e.gueltigBis);
  const ab = zeit(e.bindung.gueltigAb);
  if (bis <= ab) return nein('zeitraum_ungueltig');
  const jetzt = minute(e.jetzt);
  const status: BindungStatus = ab > jetzt ? 'geplant' : bis > jetzt ? 'gilt' : 'beendet';
  return {
    fehler: null,
    status,
    rueckwirkend: bis < jetzt,
    angekuendigt: bis > jetzt,
    hinweise: e.endstand !== null && e.endstand.einheit === null ? ['ablesestand_pruefen'] : [],
  };
}

// ------------------------------------------------------------ Zählerwechsel

/**
 * Der Einbau, der beim Zählerwechsel geht (IP-17) — so, wie er gespeichert ist
 * (`geraet`, eine Zeile = EIN Einbau). `geraet` ist die Stelle (GR-4, bleibt über den
 * Wechsel), `einbau` das konkrete Kästchen (Z-5a); `ausgebautAm === null` = steckt noch.
 */
export interface EinbauStand {
  geraet: string;
  einbau: string;
  eingebautAm: string;
  ausgebautAm: string | null;
}

/** `zeitpunkt`: wann getauscht wird, auf die Minute (E2) — Vergangenheit und Zukunft erlaubt. */
export interface WechselEingang {
  jetzt: string;
  alt: EinbauStand;
  zeitpunkt: string;
}

/** `ohneGeraetAb` bei `kein_geraet_zum_zeitpunkt`: ab wann der Vorgänger nicht mehr steckt. */
export interface WechselUrteil {
  fehler: FehlerCode | null;
  ohneGeraetAb: string | null;
  rueckwirkend: boolean;
  angekuendigt: boolean;
}

/**
 * Darf zu diesem Zeitpunkt gewechselt werden (Regel 5)? Der Wechsel liegt IM laufenden
 * Einbau des Vorgängers: NACH seinem Einbau — genau auf ihm zählt als davor, denn ein
 * Einbau von null Minuten ist keiner (422 `zeitpunkt_vor_vorgaenger`) — und VOR seinem
 * Ausbau: ein ausgebauter Einbau steckt nicht mehr und wird kein zweites Mal getauscht;
 * sein Zeitraum ist geschlossen und wird nie nachträglich geteilt (422
 * `kein_geraet_zum_zeitpunkt` mit `ausgebaut_am`). Was danach mit den Quellen geschieht,
 * urteilt `beendenPruefen` (die laufende endet) und `bindungPruefen` mit dem Vorgang
 * `wechsel` (die neue beginnt) — hier steht NUR das Gerät.
 */
export function wechselPruefen(e: WechselEingang): WechselUrteil {
  const t = zeit(e.zeitpunkt);
  if (t <= zeit(e.alt.eingebautAm)) {
    return { fehler: 'zeitpunkt_vor_vorgaenger', ohneGeraetAb: null, rueckwirkend: false, angekuendigt: false };
  }
  if (e.alt.ausgebautAm !== null) {
    return {
      fehler: 'kein_geraet_zum_zeitpunkt',
      ohneGeraetAb: e.alt.ausgebautAm,
      rueckwirkend: false,
      angekuendigt: false,
    };
  }
  const jetzt = minute(e.jetzt);
  return { fehler: null, ohneGeraetAb: null, rueckwirkend: t < jetzt, angekuendigt: t > jetzt };
}

/** Wie weit ein Zeitpunkt von „jetzt" entfernt ist, auf die Minute (E2). */
export interface Rueckwirkung {
  art: RueckwirkungArt;
  minuten: number;
  abzeichen: string | null;
}

/**
 * Rückwirkend ist erlaubt, aber immer sichtbar (E2, Regel 5): `rueckwirkend` vor der
 * Minute von „jetzt", `ab_jetzt` genau in ihr, `angekuendigt` danach. Das Abzeichen
 * trägt nur die Rückwirkung, mit ihrer Dauer: „rückwirkend (25 min)", „rückwirkend
 * (2 h 5 min)", ab einem Tag in ganzen Tagen „rückwirkend (933 Tage)".
 */
export function rueckwirkung(jetzt: string, zeitpunkt: string): Rueckwirkung {
  const t = zeit(zeitpunkt);
  const j = minute(jetzt);
  const minuten = Math.floor(Math.abs(j - t) / 60_000);
  const art: RueckwirkungArt = t < j ? 'rueckwirkend' : t > j ? 'angekuendigt' : 'ab_jetzt';
  return { art, minuten, abzeichen: art === 'rueckwirkend' ? `rückwirkend (${dauer(minuten)})` : null };
}

function dauer(minuten: number): string {
  if (minuten < 60) return `${minuten} min`;
  if (minuten < 24 * 60) {
    const rest = minuten % 60;
    return `${Math.floor(minuten / 60)} h${rest === 0 ? '' : ` ${rest} min`}`;
  }
  const tage = Math.floor(minuten / (24 * 60));
  return `${tage} ${tage === 1 ? 'Tag' : 'Tage'}`;
}

/**
 * „Ablesestand prüfen" (§5.12): ein Stand ohne Einheit, oder ein Anfangsstand
 * über dem Endstand DESSELBEN Geräts. Bei verschiedenen Geräten nie — sie haben
 * verschiedene Zählwerke.
 */
function ablesestandHinweise(vorgaenger: Bindung | null, n: NeueBindung): Hinweis[] {
  const alt = n.endstandVorgaenger;
  const neu = n.anfangsstand;
  const ohneEinheit = (alt !== null && alt.einheit === null) || (neu !== null && neu.einheit === null);
  const ueberEndstand =
    vorgaenger !== null && alt !== null && neu !== null && vorgaenger.einbau === n.einbau && neu.wert > alt.wert;
  return ohneEinheit || ueberEndstand ? ['ablesestand_pruefen'] : [];
}

/**
 * Die führenden Quellen EINER Größe ab Beginn der Messstelle, lückenlos: jede
 * Lücke ist ein eigener Abschnitt ohne Quelle — auch vor der ersten und nach der
 * letzten beendeten Quelle („keine Quelle seit …"). Ohne jede Quelle ist der
 * Zeitstrahl EIN offener Abschnitt ohne Quelle (E8: „Keine Datenquelle").
 */
export function zeitstrahlAus(beginn: string | null, fuehrend: QuelleZeitraum[]): Abschnitt[] {
  const sortiert = [...fuehrend].sort((a, b) => zeit(a.gueltigAb) - zeit(b.gueltigAb));
  const out: Abschnitt[] = [];
  let cursor = beginn;
  for (const b of sortiert) {
    if (cursor !== null && zeit(cursor) < zeit(b.gueltigAb)) out.push({ von: cursor, bis: b.gueltigAb, quelle: null });
    out.push({ von: b.gueltigAb, bis: b.gueltigBis, quelle: b });
    cursor = b.gueltigBis;
    if (cursor === null) return out;
  }
  if (cursor !== null) out.push({ von: cursor, bis: null, quelle: null });
  return out;
}

// --------------------------------------------------------- Elektrische Stellung

/** Eine Messstelle mit ihrer Stellung am Stichtag (in der Reihenfolge des Registers). */
export interface StellungEintrag {
  kennzeichen: string;
  name: string;
  anlage: string;
  stellung: string;
  unterzaehlerVon: string | null;
  richtung: string;
  komponente: string | null;
}

/** Die Messstelle, deren Stellung geändert werden soll; `komponente` der führenden Quelle. */
export interface StellungKandidat {
  kennzeichen: string;
  art: string;
  medium: string;
  richtung: string;
  komponente: string | null;
}

export interface Stellung {
  anlage: string;
  stellung: string;
  unterzaehlerVon: string | null;
}

export interface StellungUrteil {
  fehler: 'hauptzaehler_vorhanden' | 'stellung_ungueltig' | null;
  grund: StellungGrund | null;
  bestehend: StellungEintrag | null;
  kette: string[];
}

const ungueltig = (grund: StellungGrund, bestehend: StellungEintrag | null = null, kette: string[] = []): StellungUrteil => ({
  fehler: 'stellung_ungueltig',
  grund,
  bestehend,
  kette,
});

/**
 * Darf die Messstelle diese Stellung einnehmen (Regel 8, E12)? Reihenfolge:
 * nicht elektrisch → Bezug nur bei Unterzähler → Bezug fehlt → sich selbst →
 * fremde Anlage → Zyklus; dann der Hauptzähler: je Anlage und Richtung höchstens
 * einer, alle am selben Zähler.
 */
export function stellungPruefen(
  m: StellungKandidat,
  s: Stellung | null,
  messstellen: StellungEintrag[],
): StellungUrteil {
  const ok: StellungUrteil = { fehler: null, grund: null, bestehend: null, kette: [] };
  if (s === null) return ok;
  if ((m.art === 'berechnet' || m.medium !== STROM) && s.stellung !== 'keine') return ungueltig('nicht_elektrisch');
  if (s.stellung !== 'Unterzähler' && s.unterzaehlerVon !== null) return ungueltig('bezug_nur_bei_unterzaehler');
  const andere = new Map(messstellen.filter((e) => e.kennzeichen !== m.kennzeichen).map((e) => [e.kennzeichen, e]));
  if (s.stellung === 'Unterzähler') {
    const ziel = s.unterzaehlerVon;
    if (ziel === null) return ungueltig('bezug_fehlt');
    if (ziel === m.kennzeichen) return ungueltig('selbst');
    const z = andere.get(ziel) ?? null;
    if (z === null || z.anlage !== s.anlage) return ungueltig('fremde_anlage', z);
    const kette = [m.kennzeichen];
    const gesehen = new Set<string>();
    for (let cur: string | null = ziel; cur !== null && !gesehen.has(cur); ) {
      gesehen.add(cur);
      kette.push(cur);
      if (cur === m.kennzeichen) return ungueltig('zyklus', null, kette);
      const e = andere.get(cur);
      cur = e && e.stellung === 'Unterzähler' ? e.unterzaehlerVon : null;
    }
  }
  if (s.stellung === 'Hauptzähler') {
    for (const e of andere.values()) {
      if (e.stellung !== 'Hauptzähler' || e.anlage !== s.anlage) continue;
      const derselbeZaehler = m.komponente !== null && m.komponente === e.komponente;
      if (e.richtung === m.richtung || !derselbeZaehler) {
        return { fehler: 'hauptzaehler_vorhanden', grund: null, bestehend: e, kette: [] };
      }
    }
  }
  return ok;
}

// ------------------------------------------------------- Vorschlagsliste (E6)

/** Die Flüsse, aus denen ein Vorschlag wird (E6) — in der Reihenfolge der Liste. */
export const VORSCHLAG_FLUESSE = ['Bezug', 'Abgabe', 'Erzeugung', 'Laden / Entladen', 'Laden', 'Entladen'] as const;

/** Was eine Komponente in der Vorschlagsliste ist — sie sagt, welche Stellung ein Fluss bekommt. */
export const VORSCHLAG_ROLLEN = ['netzmessung', 'zaehler', 'geraet', 'abgeleitet'] as const;
export type VorschlagRolle = (typeof VORSCHLAG_ROLLEN)[number];

/** Warum eine Komponente oder ein Messwert NICHT vorgeschlagen wird — in der Reihenfolge der Prüfung. */
export const VORSCHLAG_GRUENDE = [
  'abgeleitet',
  'ohne_messkanal',
  'ohne_geraet',
  'attribut_kanal',
  'keine_messgroesse',
  'ohne_richtung',
  'weitere_groesse',
  'vorzeichen_wert',
  'vergleich_kandidat',
  'gleicher_fluss',
  'passt_nicht',
] as const;
export type VorschlagGrund = (typeof VORSCHLAG_GRUENDE)[number];

/** Was an einem Vorschlag hängt, ohne ihn zu verhindern — in der Reihenfolge der Zeile. */
export const VORSCHLAG_HINWEISE = ['integration', 'ladestand_herkunft', 'geraet_gewechselt', 'standort_spaeter'] as const;
export type VorschlagHinweisCode = (typeof VORSCHLAG_HINWEISE)[number];

/** Warum die Liste leer ist. */
export const VORSCHLAG_LEER = ['alle_zugeordnet', 'keine_komponente'] as const;
export type VorschlagLeer = (typeof VORSCHLAG_LEER)[number];

/**
 * Die Kanäle, die nie ein Messwert einer Messstelle sind (P4, P5b, P5c): die Herkunft des
 * Ladestands, die Freigaben und die Grenzen. Dazu der Namensraum `ATTRIBUT_PRAEFIX`.
 */
export const ATTRIBUT_KANAELE = [
  'soc_source_code',
  'charge_allowed',
  'discharge_allowed',
  'charge_limit_a',
  'discharge_limit_a',
] as const;

/** Der Namensraum der BMS-Kanäle (P4) — Zustände, Grenzen und Bitfelder, nie eine Messung. */
export const ATTRIBUT_PRAEFIX = 'bms_';

const WIRKENERGIE = 'Wirkenergie';
const WIRKLEISTUNG = 'Wirkleistung';
const LADESTAND = 'Ladestand';
const INTERVALLMENGE = 'Intervallmenge';
const BEZUG = 'Bezug';
const RICHTUNGSLOS = 'richtungslos';
const IMPORT_EXPORT = 'import_export';
const HAUPTZAEHLER = 'Hauptzähler';
const UNTERZAEHLER = 'Unterzähler';
const ERZEUGER = 'Erzeuger';
const SPEICHER = 'Speicher';
const SOC_SOURCE_CODE = 'soc_source_code';

/** Ein Messkanal der Komponente, wie das Read-Model ihn zeigt (IP-9). */
export interface VorschlagKanal {
  kanal: string;
  anzeigename: string | null;
  groesse: string | null;
  richtung: string | null;
  einheit: string | null;
  wertart: string | null;
  /** Das Katalogwort; `import_export` ist ein Vorzeichen-Wert (AP-08). */
  direction: string | null;
  /** Das Kennzeichen der Messstelle, die dieser Messwert schon speist. */
  speist: string | null;
}

export interface VorschlagKomponente {
  id: string;
  anlage: string;
  name: string;
  rolle: VorschlagRolle;
  verlaufsbeginn: string | null;
  /** Der Beginn der LAUFENDEN Speisung — ein Vorschlag beginnt nie davor. */
  speisungAb: string | null;
  messkanaele: VorschlagKanal[];
}

export interface VorschlagHauptzaehler {
  messstelle: string;
  richtung: string;
  komponente: string | null;
  seit: string | null;
}

export interface VorschlagAnlage {
  id: string;
  name: string;
  netzanschluss: boolean;
  hauptzaehler: VorschlagHauptzaehler[];
}

export interface VorschlagStandort {
  kennzeichen: string;
  name: string;
  beginn: string | null;
  zeitzone: string;
}

export interface VorschlagEingang {
  standort: VorschlagStandort;
  anlagen: VorschlagAnlage[];
  komponenten: VorschlagKomponente[];
  zaehler: number;
  belegt: string[];
}

export interface VorschlagQuelle {
  kanal: string;
  anzeigename: string | null;
  kanalWertart: string;
  herleitung: Herleitung;
}

export interface VorschlagNebengroesse {
  groesse: Groesse;
  quelle: VorschlagQuelle;
}

export interface VorschlagBezug {
  messstelle: string;
  bestehend: boolean;
  komponente: string | null;
  kanal: string | null;
}

export interface VorschlagHinweis {
  code: VorschlagHinweisCode;
  text: string;
}

export interface VorschlagZeile {
  kennzeichen: string;
  name: string;
  anlage: string;
  komponente: string;
  hauptgroesse: Groesse;
  quelle: VorschlagQuelle;
  nebengroessen: VorschlagNebengroesse[];
  stellung: string | null;
  unterzaehlerVon: VorschlagBezug | null;
  ort: string;
  ab: string;
  stellungAb: string;
  hinweise: VorschlagHinweis[];
}

export interface Ausgelassen {
  anlage: string;
  komponente: string;
  kanal: string | null;
  grund: VorschlagGrund;
  zu: string | null;
  text: string;
}

export interface Vorschlagsliste {
  vorschlaege: VorschlagZeile[];
  ausgelassen: Ausgelassen[];
  leer: VorschlagLeer | null;
  text: string | null;
  zaehler: number;
}

/** Ein Vorschlag, bevor Reihenfolge, Kennzeichen und Name feststehen. */
interface Roh {
  anlage: VorschlagAnlage;
  komponente: VorschlagKomponente;
  anlageIndex: number;
  komponenteIndex: number;
  flussIndex: number;
  hauptgroesse: Groesse;
  quelle: VorschlagQuelle;
  nebengroessen: VorschlagNebengroesse[];
  stellung: string | null;
  bezugBestehend: VorschlagHauptzaehler | null;
  bezugVorschlag: Roh | null;
  ab: string;
  hinweise: VorschlagHinweisCode[];
  kennzeichen: string;
}

interface RohAusgelassen {
  anlage: string;
  komponente: string;
  kanal: string | null;
  anzeige: string;
  grund: VorschlagGrund;
  zuBestehend: string | null;
  zuVorschlag: Roh | null;
  passungGrund: PassungGrund | null;
  einheit: string | null;
  anlageIndex: number;
  komponenteIndex: number;
  kanalIndex: number;
}

/**
 * Die Vorschlagsliste eines Standorts (E6, §5.10, §5.15): aus den Komponenten seiner Anlagen
 * und deren Messkanälen wird je Komponente und Fluss HÖCHSTENS EIN Vorschlag — nie aus einem
 * Attribut-Kanal, nie aus einer Ableitung (Haus), nie ein zweiter für denselben Messwert.
 *
 * - **Die Größe kommt aus dem Messwert:** ein Zählerstand trägt die Wirkenergie als
 *   Zählerstand, eine Leistung als Intervallmenge (Herleitung `integration`, gekennzeichnet).
 *   Ein Ladestand steht als Nebengröße neben dem Speicher-Fluss derselben Komponente.
 * - **Die Stellung kommt aus der Topologie:** die maßgebliche Netzmessung wird Hauptzähler
 *   (nur mit Netzanschluss), Erzeugung → Erzeuger, Speicher → Speicher, jeder andere Bezug →
 *   „Unterzähler von" dem Bezug-Hauptzähler seiner Anlage. Findet sich keiner, bleibt die
 *   Stellung offen — nie geraten.
 * - **Der Beginn ist der Verlauf:** die Bindung beginnt am Beginn der laufenden Speisung (ein
 *   vorhandener Gerätewechsel wird NIE verkettet) und nie vor dem ersten Tag des Standorts.
 */
export function vorschlagsliste(e: VorschlagEingang): Vorschlagsliste {
  const zone = e.standort.zeitzone || VORGABE_ZEITZONE;
  const standortBeginn = e.standort.beginn === null ? null : mitternacht(e.standort.beginn, zone).iso;
  const rohe: Roh[] = [];
  const ausgelassen: RohAusgelassen[] = [];
  let etwasGespeist = false;
  let etwasVorhanden = false;

  e.anlagen.forEach((a, ai) => {
    const ihre: { k: VorschlagKomponente; index: number }[] = [];
    e.komponenten.forEach((k, ki) => {
      if (k.anlage === a.id) ihre.push({ k, index: ki });
    });
    // Die Netzmessung zuerst: erst nach ihr steht fest, ob die Anlage einen
    // Hauptzähler-Vorschlag hat, an dem die Unterzähler hängen.
    const reihenfolge = [
      ...ihre.filter((x) => x.k.rolle === 'netzmessung'),
      ...ihre.filter((x) => x.k.rolle !== 'netzmessung'),
    ];
    for (const { k, index } of reihenfolge) {
      etwasVorhanden = true;
      if (k.messkanaele.some((c) => c.speist !== null)) etwasGespeist = true;
      komponenteZuVorschlaegen(a, ai, k, index, standortBeginn, rohe, ausgelassen);
    }
  });

  rohe.sort(
    (x, y) =>
      x.anlageIndex - y.anlageIndex ||
      stellungRang(x.stellung) - stellungRang(y.stellung) ||
      x.komponenteIndex - y.komponenteIndex ||
      x.flussIndex - y.flussIndex,
  );
  let zaehler = e.zaehler;
  const belegt = new Set(e.belegt);
  for (const r of rohe) {
    const v = kennzeichenVorschlag(zaehler, belegt);
    r.kennzeichen = v.kennzeichen;
    belegt.add(v.kennzeichen);
    zaehler = v.zaehler;
  }

  const zeilen: VorschlagZeile[] = rohe.map((r) => {
    const eigene = rohe.filter((x) => x.komponente === r.komponente).length + gespeisteFluesse(r.komponente);
    const name = eigene > 1 ? `${r.komponente.name} · ${nameZusatz(r.hauptgroesse)}` : r.komponente.name;
    const bezug: VorschlagBezug | null =
      r.bezugVorschlag !== null
        ? {
            messstelle: r.bezugVorschlag.kennzeichen,
            bestehend: false,
            komponente: r.bezugVorschlag.komponente.id,
            kanal: r.bezugVorschlag.quelle.kanal,
          }
        : r.bezugBestehend !== null
          ? { messstelle: r.bezugBestehend.messstelle, bestehend: true, komponente: null, kanal: null }
          : null;
    let stellungAb = lokalerTag(r.ab, zone);
    if (r.bezugVorschlag !== null) stellungAb = spaeter(stellungAb, lokalerTag(r.bezugVorschlag.ab, zone));
    else if (r.bezugBestehend !== null && r.bezugBestehend.seit !== null)
      stellungAb = spaeter(stellungAb, r.bezugBestehend.seit);
    return {
      kennzeichen: r.kennzeichen,
      name,
      anlage: r.anlage.id,
      komponente: r.komponente.id,
      hauptgroesse: r.hauptgroesse,
      quelle: r.quelle,
      nebengroessen: r.nebengroessen,
      stellung: r.stellung,
      unterzaehlerVon: bezug,
      ort: e.standort.kennzeichen,
      ab: r.ab,
      stellungAb,
      hinweise: VORSCHLAG_HINWEISE.filter((code) => r.hinweise.includes(code)).map((code) => ({
        code,
        text: hinweisText(code),
      })),
    };
  });

  ausgelassen.sort(
    (x, y) =>
      x.anlageIndex - y.anlageIndex || x.komponenteIndex - y.komponenteIndex || x.kanalIndex - y.kanalIndex,
  );
  const ohne: Ausgelassen[] = ausgelassen.map((x) => {
    const zu = x.zuVorschlag !== null ? x.zuVorschlag.kennzeichen : x.zuBestehend;
    return {
      anlage: x.anlage,
      komponente: x.komponente,
      kanal: x.kanal,
      grund: x.grund,
      zu,
      text: ausgelassenText(x, zu),
    };
  });
  const leerGrund: VorschlagLeer | null =
    zeilen.length > 0 ? null : etwasGespeist && etwasVorhanden ? 'alle_zugeordnet' : 'keine_komponente';
  const text =
    leerGrund === null
      ? null
      : leerGrund === 'alle_zugeordnet'
        ? `Alle Komponenten von ${e.standort.name} sind Messstellen zugeordnet.`
        : `In ${e.standort.name} gibt es keine Komponente, aus der eine Messstelle werden kann.`;
  return { vorschlaege: zeilen, ausgelassen: ohne, leer: leerGrund, text, zaehler };
}

/** Eine Komponente: ihre Messkanäle werden zu Vorschlägen — oder benannt ausgelassen. */
function komponenteZuVorschlaegen(
  a: VorschlagAnlage,
  anlageIndex: number,
  k: VorschlagKomponente,
  komponenteIndex: number,
  standortBeginn: string | null,
  rohe: Roh[],
  ausgelassen: RohAusgelassen[],
): void {
  const kanaele = k.messkanaele;
  const ohne = (kanal: string | null, anzeige: string, grund: VorschlagGrund, kanalIndex = -1): RohAusgelassen => ({
    anlage: a.id,
    komponente: k.id,
    kanal,
    anzeige,
    grund,
    zuBestehend: null,
    zuVorschlag: null,
    passungGrund: null,
    einheit: null,
    anlageIndex,
    komponenteIndex,
    kanalIndex,
  });
  if (k.rolle === 'abgeleitet') {
    ausgelassen.push(ohne(null, k.name, 'abgeleitet'));
    return;
  }
  if (kanaele.length === 0) {
    ausgelassen.push(ohne(null, k.name, 'ohne_messkanal'));
    return;
  }
  if (kanaele.every((c) => c.speist !== null)) return;
  if (k.speisungAb === null) {
    ausgelassen.push(ohne(null, k.name, 'ohne_geraet'));
    return;
  }
  let ab = aufDieMinute(k.speisungAb);
  let standortSpaeter = false;
  if (standortBeginn !== null && zeit(standortBeginn) > zeit(ab)) {
    ab = standortBeginn;
    standortSpaeter = true;
  }
  const gewechselt = k.verlaufsbeginn !== null && zeit(k.speisungAb) > zeit(k.verlaufsbeginn);

  // 1. Jeden Messwert einordnen; ein gespeister sagt nur, welcher Fluss schon vergeben ist.
  const fluesse = new Map<string, VorschlagKanal[]>();
  const vergeben = new Map<string, string>();
  const ladestand: VorschlagKanal[] = [];
  let ladestandVergeben: string | null = null;
  const einfach = new Map<string, VorschlagGrund>();
  const vorzeichen = new Set<string>();
  for (const c of kanaele) {
    const f = fluss(c);
    const wirkgroesse = c.groesse === WIRKENERGIE || c.groesse === WIRKLEISTUNG;
    if (c.speist !== null) {
      if (f !== null) {
        if (!vergeben.has(f)) vergeben.set(f, c.speist);
      } else if (c.groesse === LADESTAND && ladestandVergeben === null) {
        ladestandVergeben = c.speist;
      }
    } else if (attributKanal(c)) {
      einfach.set(c.kanal, 'attribut_kanal');
    } else if (c.groesse === null || (c.wertart !== 'counter' && c.wertart !== 'gauge')) {
      einfach.set(c.kanal, 'keine_messgroesse');
    } else if (f !== null) {
      fluesse.set(f, [...(fluesse.get(f) ?? []), c]);
    } else if (c.groesse === LADESTAND) {
      ladestand.push(c);
    } else if (wirkgroesse && c.direction === IMPORT_EXPORT) {
      vorzeichen.add(c.kanal);
    } else if (wirkgroesse) {
      einfach.set(c.kanal, 'ohne_richtung');
    } else {
      einfach.set(c.kanal, 'weitere_groesse');
    }
  }

  // 2. Je Fluss EIN Messwert: Zählerstand vor Leistung, und Regel 7 entscheidet.
  const verwendet = new Set<string>();
  const passtNicht = new Map<string, PassungGrund>();
  const gleicherFluss = new Map<string, Roh>();
  const gleicherFlussBestehend = new Map<string, string>();
  const vergleichBestehend = new Map<string, string>();
  for (const f of VORSCHLAG_FLUESSE) {
    const kandidaten = fluesse.get(f) ?? [];
    if (kandidaten.length === 0) continue;
    const schonVergeben = vergeben.get(f);
    if (schonVergeben !== undefined) {
      kandidaten.forEach((c) => gleicherFlussBestehend.set(c.kanal, schonVergeben));
      continue;
    }
    // Ist diese Richtung an der Anlage schon ein Hauptzähler, misst dieser Messwert den
    // Netzanschluss ein zweites Mal: ein Kandidat für eine Vergleichsquelle (E3).
    const schon = k.rolle === 'netzmessung' ? hauptzaehlerDer(a, f) : null;
    if (schon !== null) {
      kandidaten.forEach((c) => vergleichBestehend.set(c.kanal, schon.messstelle));
      continue;
    }
    let treffer: Roh | null = null;
    for (const c of nachWertart(kandidaten)) {
      const ziel: Groesse = {
        groesse: WIRKENERGIE,
        richtung: f,
        einheit: einheitVon(WIRKENERGIE),
        wertart: c.wertart === 'counter' ? 'Zählerstand' : INTERVALLMENGE,
      };
      const p = passung(STROM, ziel, c.groesse, c.richtung, c.einheit, c.wertart);
      if (p.fehler !== null) {
        passtNicht.set(c.kanal, p.grund as PassungGrund);
      } else if (treffer === null) {
        treffer = neuerRoh(a, k, anlageIndex, komponenteIndex, f, ziel, quelleAus(c, p), ab, rohe);
        verwendet.add(c.kanal);
        hinweiseSetzen(treffer, p.herleitung, standortSpaeter, gewechselt);
      } else {
        gleicherFluss.set(c.kanal, treffer);
      }
    }
  }

  // 3. Der Ladestand: Nebengröße des Speichers derselben Komponente, sonst eine eigene Zeile.
  const speicher = rohe.find((r) => r.komponente === k && r.stellung === SPEICHER) ?? null;
  const speicherVergeben =
    [...vergeben.entries()].filter(([f]) => speicherFluss(f)).map(([, m]) => m)[0] ?? ladestandVergeben;
  let ladestandZeile: Roh | null = null;
  for (const c of ladestand) {
    const ziel: Groesse = {
      groesse: LADESTAND,
      richtung: RICHTUNGSLOS,
      einheit: einheitVon(LADESTAND),
      wertart: 'Momentanwert',
    };
    const p = passung(STROM, ziel, c.groesse, c.richtung, c.einheit, c.wertart);
    if (p.fehler !== null) {
      passtNicht.set(c.kanal, p.grund as PassungGrund);
    } else if (speicher !== null && speicher.nebengroessen.length === 0) {
      speicher.nebengroessen.push({ groesse: ziel, quelle: quelleAus(c, p) });
      verwendet.add(c.kanal);
      if (kanaele.some((x) => x.kanal === SOC_SOURCE_CODE)) speicher.hinweise.push('ladestand_herkunft');
    } else if (speicher !== null) {
      gleicherFluss.set(c.kanal, speicher);
    } else if (speicherVergeben !== null && speicherVergeben !== undefined) {
      gleicherFlussBestehend.set(c.kanal, speicherVergeben);
    } else if (ladestandZeile === null) {
      ladestandZeile = neuerRoh(a, k, anlageIndex, komponenteIndex, LADESTAND, ziel, quelleAus(c, p), ab, rohe);
      verwendet.add(c.kanal);
      hinweiseSetzen(ladestandZeile, p.herleitung, standortSpaeter, gewechselt);
      if (kanaele.some((x) => x.kanal === SOC_SOURCE_CODE)) ladestandZeile.hinweise.push('ladestand_herkunft');
    } else {
      gleicherFluss.set(c.kanal, ladestandZeile);
    }
  }

  // 4. Jeden ausgelassenen Messwert in der Reihenfolge der Komponente benennen.
  const vorschlagBezug = bezugVorschlagDer(rohe, a, BEZUG);
  const bestehend = hauptzaehlerDer(a, BEZUG);
  kanaele.forEach((c, ci) => {
    if (c.speist !== null || verwendet.has(c.kanal)) return;
    const anzeige = anzeigeVon(c);
    const grundEinfach = einfach.get(c.kanal);
    if (grundEinfach !== undefined) {
      ausgelassen.push(ohne(c.kanal, anzeige, grundEinfach, ci));
    } else if (vorzeichen.has(c.kanal)) {
      const kandidat = k.rolle === 'geraet' && (vorschlagBezug !== null || bestehend !== null);
      ausgelassen.push({
        ...ohne(c.kanal, anzeige, kandidat ? 'vergleich_kandidat' : 'vorzeichen_wert', ci),
        zuBestehend: kandidat && vorschlagBezug === null && bestehend !== null ? bestehend.messstelle : null,
        zuVorschlag: kandidat ? vorschlagBezug : null,
      });
    } else if (vergleichBestehend.has(c.kanal)) {
      ausgelassen.push({
        ...ohne(c.kanal, anzeige, 'vergleich_kandidat', ci),
        zuBestehend: vergleichBestehend.get(c.kanal) ?? null,
      });
    } else if (gleicherFluss.has(c.kanal)) {
      ausgelassen.push({
        ...ohne(c.kanal, anzeige, 'gleicher_fluss', ci),
        zuVorschlag: gleicherFluss.get(c.kanal) ?? null,
      });
    } else if (gleicherFlussBestehend.has(c.kanal)) {
      ausgelassen.push({
        ...ohne(c.kanal, anzeige, 'gleicher_fluss', ci),
        zuBestehend: gleicherFlussBestehend.get(c.kanal) ?? null,
      });
    } else if (passtNicht.has(c.kanal)) {
      ausgelassen.push({
        ...ohne(c.kanal, anzeige, 'passt_nicht', ci),
        passungGrund: passtNicht.get(c.kanal) ?? null,
        einheit: c.einheit,
      });
    }
  });
}

/** Zählerstände zuerst: aus einem Zählerstand wird eine Wirkenergie ohne Rechenweg. */
const nachWertart = (kandidaten: VorschlagKanal[]): VorschlagKanal[] => [
  ...kandidaten.filter((c) => c.wertart === 'counter'),
  ...kandidaten.filter((c) => c.wertart !== 'counter'),
];

const quelleAus = (c: VorschlagKanal, p: Passung): VorschlagQuelle => ({
  kanal: c.kanal,
  anzeigename: c.anzeigename,
  kanalWertart: c.wertart as string,
  herleitung: p.herleitung as Herleitung,
});

function hinweiseSetzen(r: Roh, herleitung: Herleitung | null, standortSpaeter: boolean, gewechselt: boolean): void {
  if (herleitung === 'integration') r.hinweise.push('integration');
  if (gewechselt) r.hinweise.push('geraet_gewechselt');
  if (standortSpaeter) r.hinweise.push('standort_spaeter');
}

/** Legt den Vorschlag an — mit Stellung und „Unterzähler von" aus Topologie und Fluss. */
function neuerRoh(
  a: VorschlagAnlage,
  k: VorschlagKomponente,
  anlageIndex: number,
  komponenteIndex: number,
  fluss: string,
  ziel: Groesse,
  quelle: VorschlagQuelle,
  ab: string,
  rohe: Roh[],
): Roh {
  let stellung: string | null = null;
  let bestehend: VorschlagHauptzaehler | null = null;
  let bezug: Roh | null = null;
  if (fluss === LADESTAND || speicherFluss(fluss)) {
    stellung = SPEICHER;
  } else if (fluss === 'Erzeugung') {
    stellung = ERZEUGER;
  } else if (k.rolle === 'netzmessung' && a.netzanschluss) {
    const fremderZaehler = a.hauptzaehler.some((h) => h.komponente === null || h.komponente !== k.id);
    stellung = fremderZaehler ? null : HAUPTZAEHLER;
  } else if (fluss === BEZUG) {
    const v = bezugVorschlagDer(rohe, a, BEZUG);
    const b = hauptzaehlerDer(a, BEZUG);
    if (v !== null) {
      stellung = UNTERZAEHLER;
      bezug = v;
    } else if (b !== null) {
      stellung = UNTERZAEHLER;
      bestehend = b;
    }
  }
  const r: Roh = {
    anlage: a,
    komponente: k,
    anlageIndex,
    komponenteIndex,
    flussIndex: fluss === LADESTAND ? VORSCHLAG_FLUESSE.length : VORSCHLAG_FLUESSE.indexOf(fluss as never),
    hauptgroesse: ziel,
    quelle,
    nebengroessen: [],
    stellung,
    bezugBestehend: bestehend,
    bezugVorschlag: bezug,
    ab,
    hinweise: [],
    kennzeichen: '',
  };
  rohe.push(r);
  return r;
}

const speicherFluss = (fluss: string): boolean =>
  fluss === 'Laden / Entladen' || fluss === 'Laden' || fluss === 'Entladen';

/** Der Bezug-Hauptzähler-Vorschlag DERSELBEN Anlage, wenn es ihn schon gibt. */
const bezugVorschlagDer = (rohe: Roh[], a: VorschlagAnlage, richtung: string): Roh | null =>
  rohe.find((r) => r.anlage === a && r.stellung === HAUPTZAEHLER && r.hauptgroesse.richtung === richtung) ?? null;

const hauptzaehlerDer = (a: VorschlagAnlage, richtung: string): VorschlagHauptzaehler | null =>
  a.hauptzaehler.find((h) => h.richtung === richtung) ?? null;

/** Der Fluss eines Messwerts: seine Vertrags-Richtung, wenn sie eine Wirkgröße trägt. */
function fluss(c: VorschlagKanal): string | null {
  if (c.groesse !== WIRKENERGIE && c.groesse !== WIRKLEISTUNG) return null;
  return c.richtung !== null && (VORSCHLAG_FLUESSE as readonly string[]).includes(c.richtung) ? c.richtung : null;
}

/**
 * Wie viele Flüsse der Komponente schon eine Messstelle speisen — zusammen mit ihren
 * Vorschlägen sagen sie, ob der Name den Fluss nennen muss („Netzzähler Halle 1 · Bezug").
 */
function gespeisteFluesse(k: VorschlagKomponente): number {
  const gesehen = new Set<string>();
  for (const c of k.messkanaele) {
    if (c.speist === null || attributKanal(c)) continue;
    const f = fluss(c);
    if (f !== null) gesehen.add(f);
    else if (c.groesse === LADESTAND) gesehen.add(LADESTAND);
  }
  return gesehen.size;
}

/** Ein Attribut-Kanal: eine Herkunft, eine Freigabe, eine Grenze oder ein Zustand (P4, P5b, P5c). */
function attributKanal(c: VorschlagKanal): boolean {
  if ((ATTRIBUT_KANAELE as readonly string[]).includes(c.kanal) || c.kanal.startsWith(ATTRIBUT_PRAEFIX)) return true;
  return c.wertart !== null && c.wertart !== 'counter' && c.wertart !== 'gauge';
}

const stellungRang = (stellung: string | null): number =>
  stellung === HAUPTZAEHLER ? 0 : stellung === ERZEUGER ? 1 : stellung === SPEICHER ? 2 : stellung === UNTERZAEHLER ? 3 : 4;

/** Was hinter den Namen der Komponente tritt, wenn sie mehr als einen Fluss liest. */
const nameZusatz = (g: Groesse): string => (g.groesse === LADESTAND ? LADESTAND : g.richtung);

const einheitVon = (groesse: string): string => katalog(groesse)?.einheit ?? '';

const anzeigeVon = (c: VorschlagKanal): string => (leer(c.anzeigename) ? c.kanal : (c.anzeigename as string));

const spaeter = (a: string, b: string): string => (b > a ? b : a);

/** Die Auflösung eines Zeitpunkts ist die Minute (E2) — Sekunden fallen weg. */
const aufDieMinute = (t: string): string => t.replace(/:\d\d([+-]\d\d:\d\d|Z)$/, ':00$1');

function hinweisText(code: VorschlagHinweisCode): string {
  switch (code) {
    case 'integration':
      return 'Die Wirkenergie wird aus der Leistung integriert — gekennzeichnet.';
    case 'ladestand_herkunft':
      return 'Die Herkunft des Ladestands reist mit (soc_source_code).';
    case 'geraet_gewechselt':
      return 'Das Gerät wurde gewechselt — die Messstelle beginnt beim heutigen Gerät; die Zeit davor verketten Sie von Hand.';
    case 'standort_spaeter':
      return 'Der Verlauf beginnt vor dem Standort — die Messstelle beginnt mit ihm.';
  }
}

function ausgelassenText(x: RohAusgelassen, zu: string | null): string {
  const was = `„${x.anzeige}“`;
  switch (x.grund) {
    case 'abgeleitet':
      return `${was} ist keine Messung, sondern eine Ableitung der Box — eine berechnete Messstelle kommt später.`;
    case 'ohne_messkanal':
      return `${was} liest keinen Messwert — ohne Messwert gibt es keine Messstelle.`;
    case 'ohne_geraet':
      return `${was} wird gerade von keinem Gerät gespeist — ohne Gerät gibt es keine Quelle.`;
    case 'attribut_kanal':
      return `${was} ist ein Attribut (Zustand, Grenze, Freigabe oder Herkunft), kein Messwert — daraus wird nie eine Messstelle.`;
    case 'keine_messgroesse':
      return `${was} misst keine Größe, die eine Messstelle trägt.`;
    case 'ohne_richtung':
      return `${was} nennt keine Richtung — ob Bezug, Abgabe oder Erzeugung, sagt der Messwert nicht.`;
    case 'weitere_groesse':
      return `${was} misst eine weitere Größe — sie kommt als Nebengröße von Hand dazu.`;
    case 'vorzeichen_wert':
      return `${was} trägt Bezug und Abgabe in einem Vorzeichen — er wird keine eigene Messstelle; sein positiver und sein negativer Anteil kommen als Nebengröße von Hand an Bezug und Abgabe.`;
    case 'vergleich_kandidat':
      return `${was} misst den Netzanschluss ein zweites Mal — ein Kandidat für eine Vergleichsquelle an ${zu}, nie eine eigene Messstelle.`;
    case 'gleicher_fluss':
      return `${was} misst denselben Fluss wie ${zu} — als Nebengröße oder Vergleichsquelle von Hand.`;
    case 'passt_nicht':
      return x.passungGrund === 'einheit'
        ? `${was} hat eine Einheit, die sich nicht umrechnen lässt („${x.einheit}“).`
        : `${was} passt nicht zu dieser Größe (${x.passungGrund}).`;
  }
}

// ------------------------------------------------------------------ Hilfen

const OFFEN = Number.POSITIVE_INFINITY;

const zeit = (s: string): number => Date.parse(s);

const ende = (s: string | null): number => (s === null ? OFFEN : zeit(s));

/** Die Auflösung eines Zeitpunkts ist die Minute (E2). */
const minute = (s: string): number => Math.floor(zeit(s) / 60_000) * 60_000;

const gilt = (ab: string, bis: string | null, t: number): boolean => zeit(ab) <= t && t < ende(bis);

/** Überschneiden sich `[ab1, bis1)` und `[ab2, bis2)`? `null`/unendlich = offen. */
const ueberschneiden = (ab1: number, bis1: number | null, ab2: number, bis2: number): boolean =>
  ab1 < bis2 && ab2 < (bis1 ?? OFFEN);

const leer = (s: string | null): boolean => s === null || s.trim() === '';

/** AP-04 E10; Java-Zwilling MessstelleRegeln.kartenWechselPruefen. */
export function kartenWechselPruefen(karten: string[], uebernommen: string[] | null,
  fuehrendeBindungen: string[], ablesestaende: string[]): string | null {
  if (!uebernommen || uebernommen.some(k => !karten.includes(k)) || new Set(uebernommen).size !== uebernommen.length) return 'karten_uebernommen';
  if (ablesestaende.some(q => !fuehrendeBindungen.includes(q)) || new Set(ablesestaende).size !== ablesestaende.length) return 'ablesestaende';
  return null;
}
