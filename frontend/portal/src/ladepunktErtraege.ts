/**
 * MiSpeL MP-41a: der bidirektionale Ladepunkt im Portal — die Erträge im Monat (Verlauf › Erlöse) und die Fähigkeit,
 * die der Installateur in Anlage › Aufbau einträgt. Vertrag: `docs/contracts/v2/mispel-ladepunkt-bidirektional.md`
 * (Fähigkeit MP-31, Erträge MP-41a); Bedienkonzept BK-41 Variante A (Captain 04.10.2026).
 *
 * ⚠ Keine eigene Rechnung: jede Menge kommt fertig aus dem Rechenwerk (MP-32) über die Route, jeder Betrag ebenso.
 * Unbekannt ist „offen“, nie 0.
 */

/** Eine Menge nach Anlage 1 mit Formelnummer, Begriff und Fundstelle; `kwh` `null` = offen. */
export interface LadepunktMenge {
  nr: string;
  begriff: string;
  fundstelle: string;
  kwh: number | null;
}

/** Ein Lauf des Monats (Kalender- oder Rumpfmonat) in einem Formelsatz mit Ladepunkt (A2, A3, A4). */
export interface LadepunktErtragTeil {
  schluessel: string;
  erster_tag: string;
  letzter_tag: string;
  formelsatz: string;
  formelsatz_bezeichnung: string;
  /** A2: Z2 misst nur den Ladepunkt. A3/A4: Stromspeicher und Ladepunkt zusammen (A1 S. 30–32). */
  nur_ladepunkt: boolean;
  stand: 'endgueltig' | 'vorlaeufig';
  wertequelle: string | null;
  mengen: LadepunktMenge[];
  ins_haus: LadepunktMenge;
}

export type LadepunktPostenId =
  | 'weniger_gekauft'
  | 'mehr_geladen'
  | 'ins_netz_verkauft'
  | 'vermiedene_umlagen'
  | 'vermiedenes_netzentgelt'
  | 'akku_verschleiss'
  | 'marktpraemie';

export interface LadepunktPosten {
  schluessel: LadepunktPostenId;
  stand: 'bestimmt' | 'offen';
  eur: number | null;
  menge_kwh: number | null;
  formel: string | null;
  satz_ct: number | null;
  grund: string | null;
  vorbehalt: boolean;
}

export interface LadepunktErtraege {
  anlage: string;
  monat: string;
  ladepunkte: Array<{ komponente: string; name: string; einordnung: string }>;
  teile: LadepunktErtragTeil[];
  posten: LadepunktPosten[];
  vergleich: { stand: 'bestimmt' | 'offen'; grund: string | null; summe_eur: number | null };
  /** USt-Satz des Preisblatts, mit dem Umlagen und Netzentgelt brutto gerechnet sind; null ohne Preisblatt. */
  ust_pct?: number | null;
}

/** Titel und Unterzeile je Posten — Kundendeutsch vorn, Formelnummer und Grund daneben (BK-41 „Was es gebracht hat“). */
export const POSTEN_TITEL: Record<LadepunktPostenId, string> = {
  weniger_gekauft: 'Weniger Strom gekauft',
  mehr_geladen: 'Mehr geladen, um zurückzugeben',
  ins_netz_verkauft: 'Ins Netz verkauft',
  vermiedene_umlagen: 'Vermiedene Umlagen',
  vermiedenes_netzentgelt: 'Vermiedenes Netzentgelt',
  akku_verschleiss: 'Akku-Verschleiß',
  marktpraemie: 'Marktprämie',
};

/** Warum ein Posten offen ist (Code der Route). */
export function postenOffenText(grund: string | null): string {
  switch (grund) {
    case 'messlatte_fehlt':
      return 'braucht den Vergleich mit dem Haus, in dem das Auto nur lädt';
    case 'speicher_und_ladepunkt':
      return 'Stromspeicher und Ladepunkt hängen an einem Zähler; den Anteil des Autos zeigt erst der Vergleich';
    case 'jahresmarktwert_offen':
      return 'mit dem Jahresmarktwert, nach Jahresende';
    case 'anzulegender_wert_fehlt':
      return 'der anzulegende Wert der Anlage fehlt in den Einstellungen';
    case 'preisblatt_fehlt':
      return 'Satz fehlt im Preisblatt der Anlage';
    default:
      return 'noch nicht bestimmbar';
  }
}

/** Die Menge mit genau dieser Formelnummer, sonst `null` (dann zeigt die Karte „offen“). */
export function menge(teil: LadepunktErtragTeil, nr: string): LadepunktMenge | null {
  return teil.mengen.find((m) => m.nr === nr) ?? null;
}

// ---------------------------------------------------------------------------- Fähigkeit (MP-31)

export interface LadepunktFaehigkeit {
  erfasst: boolean;
  nutzbarkeit: 'unidirektional' | 'bidirektional';
  v2h: boolean;
  v2g: boolean;
  rueckspeisung_bei_einspeisung_unterbunden: boolean;
  rueckspeiseleistung_kw: number | null;
  gueltig_ab: string | null;
  gueltig_bis: string | null;
}

export interface LadepunktZ2 {
  groesse: string;
  messstelle: string;
  zaehlpunkt: string | null;
  messstellenbetreiber: string | null;
  eichstatus: string | null;
  eichfrist_bis: string | null;
  wertequelle: string | null;
  urteil: string | null;
}

export interface LadepunktBefund {
  code: string;
  schwere: 'fehler' | 'hinweis';
  messstelle: string | null;
  fundstelle: string;
  satz: string;
}

export type LadepunktEinordnung = 'sonstiger_verbrauch' | 'ladepunkt_der_festlegung' | 'alternative_zur_ausschliesslichkeit';

export interface LadepunktAnsicht {
  anlage: string;
  komponente: string;
  name: string;
  typ: string;
  charge_point_id: string | null;
  am: string;
  faehigkeit: LadepunktFaehigkeit;
  einordnung: LadepunktEinordnung;
  einordnung_fundstelle: string;
  z2: LadepunktZ2[];
  befunde: LadepunktBefund[];
  fassungen: Array<{ id: string; gueltig_ab: string; gueltig_bis: string | null; aufgehoben_am: string | null }>;
  /** MP-31 § 5: das Fahrzeugfenster; `null` = nie gesetzt. */
  fahrzeugfenster?: LadepunktFahrzeugfenster | null;
  /** MP-41a § 5a: die Einstellungen des Fahrers. */
  fahrer_einstellungen?: FahrerEinstellungen | null;
}

// ---------------------------------------------------------------------------- Fahrzeugfenster und Fahrer (MP-31 § 5, MP-41a § 5a)

export interface LadepunktFahrzeugfenster {
  mindest_soc_pct: number | null;
  kapazitaet_kwh: number | null;
  anwesenheit: Array<{ wochentag: number; ankunft: string; abfahrt: string; abfahrt_soc_pct: number | null }>;
}

/** Zurückspeisen: `aus` · `v2h` (nur ins Haus) · `v2g` (Haus und Netz) - Vokabular des Fahrplans 2.0. */
export type Rueckspeisen = 'aus' | 'v2h' | 'v2g';

/** Eine Abfahrt für einen oder mehrere ISO-Wochentage (1 = Montag), `HH:MM` in der Ortszeit des Kundenbereichs. */
export interface FahrerAbfahrt {
  wochentage: number[];
  abfahrt: string;
  abfahrt_soc_pct: number;
}

/** „Nur die nächste Fahrt“: Ortszeit `JJJJ-MM-TTTHH:MM`, höchstens 7 Tage voraus. */
export interface NaechsteFahrt {
  abfahrt: string;
  abfahrt_soc_pct: number;
}

export interface FahrerEinstellungen {
  erfasst: boolean;
  rueckspeisen: Rueckspeisen;
  /** Der Wunsch am Tag, nie über der Fähigkeit dieses Tages. */
  rueckspeisen_wirksam: Rueckspeisen;
  /** = `mindest_soc_pct` des Fahrzeugfensters; `null` = nicht gesagt (dann speist die Box nicht zurück). */
  reserve_pct: number | null;
  vollzyklen_je_tag: number | null;
  abfahrten: FahrerAbfahrt[];
  naechste_fahrt: NaechsteFahrt | null;
  /** Kapazität × 6 km/kWh ÷ 100; `null` ohne Kapazität - eine Anzeigehilfe, kein Messwert. */
  km_je_prozent: number | null;
  geaendert_am: string | null;
  geaendert_von: string | null;
}

/** `PUT …/fahrer-einstellungen` ersetzt den Stand ganz. */
export interface FahrerAnfrage {
  rueckspeisen: Rueckspeisen;
  reserve_pct: number | null;
  vollzyklen_je_tag: number | null;
  abfahrten: FahrerAbfahrt[];
  naechste_fahrt: NaechsteFahrt | null;
}

export interface LadepunktListe {
  anlage: string;
  am: string;
  ladepunkte: LadepunktAnsicht[];
}

export interface FaehigkeitAnfrage {
  nutzbarkeit: 'unidirektional' | 'bidirektional';
  v2h: boolean;
  v2g: boolean;
  rueckspeisung_bei_einspeisung_unterbunden: boolean;
  rueckspeiseleistung_kw: number | null;
  gueltig_ab: string;
}

/** „31.05.2027“ aus einem ISO-Tag. */
function tag(iso: string): string {
  const [j, m, d] = iso.split('-');
  return `${d}.${m}.${j}`;
}

/** Die Zeile im Kurzblick: „Nur laden“ oder „Laden und zurückspeisen · ins Haus (V2H) · ab 01.03.2028“. */
export function faehigkeitZeile(f: LadepunktFaehigkeit): string {
  if (f.nutzbarkeit !== 'bidirektional') return 'Nur laden';
  const wohin = [f.v2h ? 'ins Haus (V2H)' : null, f.v2g ? 'ins Netz (V2G)' : null].filter(Boolean).join(' · ');
  return ['Laden und zurückspeisen', wohin, f.gueltig_ab ? `ab ${tag(f.gueltig_ab)}` : null].filter(Boolean).join(' · ');
}

/** Ob der Ladepunkt nach dem Bild der Angaben wie ein Stromspeicher zählt (Regel des Vertrags MP-31 § 3). */
export function einordnungAus(a: Pick<FaehigkeitAnfrage, 'nutzbarkeit' | 'v2h' | 'v2g' | 'rueckspeisung_bei_einspeisung_unterbunden'>): LadepunktEinordnung {
  if (a.nutzbarkeit !== 'bidirektional' || (!a.v2h && !a.v2g)) return 'sonstiger_verbrauch';
  if (!a.v2g && a.rueckspeisung_bei_einspeisung_unterbunden) return 'alternative_zur_ausschliesslichkeit';
  return 'ladepunkt_der_festlegung';
}

/** Der Satz zur Einordnung, mit der Fundstelle der Festlegung. */
export function einordnungSatz(e: LadepunktEinordnung): string {
  switch (e) {
    case 'ladepunkt_der_festlegung':
      return 'Zählt wie ein Stromspeicher — Ladepunkt der Festlegung (A1 S. 26).';
    case 'alternative_zur_ausschliesslichkeit':
      return 'Zählt nicht wie ein Stromspeicher: Die Rückspeisung stoppt, sobald Strom ins Netz fließt (A1 S. 27, Fn. 22).';
    default:
      return 'Nur laden: gewöhnlicher Verbrauch wie heute (A1 S. 26).';
  }
}

/** Die Ablehnung der Route in Kundendeutsch (Codes aus MP-31 § 6). */
export function faehigkeitFehlerText(code: string | undefined, grund: string | undefined): string {
  if (code === 'faehigkeit_unveraendert') return 'An diesem Tag gilt schon genau diese Angabe.';
  if (code === 'faehigkeit_ungueltig') {
    switch (grund) {
      case 'betriebsweise':
        return 'Bitte wählen Sie, wohin der Ladepunkt zurückspeisen kann: ins Haus, ins Netz oder beides.';
      case 'unterbunden':
        return 'Das Stoppen bei Netzeinspeisung gibt es nur ohne „Ins Netz“.';
      case 'rueckspeiseleistung':
        return 'Die höchste Rückspeiseleistung liegt über 0 und höchstens bei 1.000 kW — oder bleibt leer, wenn sie nicht bekannt ist.';
      case 'angaben_ohne_rueckspeisung':
        return 'Ein Ladepunkt, der nur lädt, hat keine Angaben zum Zurückspeisen.';
      default:
        return 'Die Angaben passen nicht zusammen. Bitte prüfen Sie sie.';
    }
  }
  if (code === 'anfrage_ungueltig') return 'Bitte geben Sie den Tag an, ab dem die Angabe gilt.';
  if (code === 'ladepunkt_unbekannt' || code === 'anlage_unbekannt') return 'Diesen Ladepunkt gibt es nicht mehr.';
  return 'Die Angabe konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.';
}
