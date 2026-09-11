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
export const PASSUNG_GRUENDE = ['wertart', 'groesse', 'einheit', 'richtung'] as const;
export type PassungGrund = (typeof PASSUNG_GRUENDE)[number];

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
}

/**
 * Der Größen-Katalog (AP-04 §4.1). „Laden / Entladen" bei der Wirkenergie ist
 * die zusammengefasste Richtung des Speichers (E1, MS-04); aus einer Leistung
 * wird nur eine Intervallmenge, nie ein Zählerstand.
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
 */
export function groessePruefen(medium: string, g: Groesse): GroesseUrteil {
  const e = katalog(g.groesse);
  const grund: GroesseGrund | null = !e
    ? 'groesse'
    : !e.medien.includes(medium)
      ? 'medium'
      : e.einheit !== g.einheit
        ? 'einheit'
        : !e.richtungen.includes(g.richtung)
          ? 'richtung'
          : !e.wertarten.includes(g.wertart)
            ? 'wertart'
            : null;
  return { fehler: grund ? 'groesse_ungueltig' : null, grund };
}

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
  /** `null`, wenn der Katalog keine EINE Vertrags-Richtung kennt (Vorzeichen-Wert `import_export` — AP-08). */
  kanalRichtung: string | null;
  kanalEinheit: string | null;
  kanalWertart: string | null;
  gueltigAb: string;
  gueltigBis: string | null;
  endstandVorgaenger: Stand | null;
  anfangsstand: Stand | null;
  /** Bis wann dieser Einbau die Komponente speist; `null` = bis auf Weiteres. */
  geraetBis: string | null;
}

/** Derselbe Messwert speist in diesem Zeitraum eine ANDERE Messstelle führend. */
export interface FremdeFuehrung {
  messstelle: string;
  gueltigAb: string;
  gueltigBis: string | null;
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

/**
 * Passt der Messwert zur Größe (Regel 7)? Medium Strom; dann die Wertart
 * (state/bitfield/text nie; Momentanwert nie aus Zählerstand; Zählerstand nie
 * aus Leistung), die Größe laut Katalog, eine umrechenbare Einheit, dieselbe
 * Richtung. Bei Erfolg sagt `herleitung`, wie aus dem Messwert die Größe wird.
 */
export function passung(
  medium: string,
  ziel: Groesse,
  kanalGroesse: string | null,
  kanalRichtung: string | null,
  kanalEinheit: string | null,
  kanalWertart: string | null,
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
  if (ziel.richtung !== kanalRichtung) return passtNicht('richtung');
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
  const p = passung(e.medium, e.ziel, n.kanalGroesse, n.kanalRichtung, n.kanalEinheit, n.kanalWertart);
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
    const f = e.kanalFuehrendAnderswo.find((x) => ueberschneiden(ab, bis, zeit(x.gueltigAb), ende(x.gueltigBis)));
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
