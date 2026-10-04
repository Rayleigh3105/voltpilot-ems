import { request } from './api';
import { NBSP } from './format';

/**
 * Der MiSpeL-Check je Anlage (MP-48, Vertrag `docs/contracts/v2/mispel-check.md`, Bedienkonzept BK-48 Variante A):
 * dieselbe Anlage mit demselben Speicher und VoltPilot heute gegen die Abgrenzungsoption (Anlage 1 der Festlegung
 * vom 01.10.2026) über ein Ganzjahr echter Viertelstundenpreise — nie gegen „ohne Speicher“. Gerechnet von MP-13,
 * abgelegt von MP-13b; hier nur gelesen. Ohne Ergebnis „wird gerechnet“ — nie ein Betrag von 0 €.
 */

export type MispelCheckStand = 'wird_gerechnet' | 'fertig' | 'fehlgeschlagen' | 'nicht_unterstuetzt';

/** Ein Posten mit Vorzeichen je Annahmen-Fall (Vertrag § 3): + bringt, − kostet. */
export interface MispelCheckPosten {
  art: string;
  niedrig_eur: number | null;
  mittel_eur: number | null;
  hoch_eur: number | null;
  herkunft?: string | null;
}

/** Eine Angabe, aus der gerechnet wurde (Vertrag § 4). */
export interface MispelCheckAngabe {
  angabe: string;
  wert: number | string | null;
  einheit?: string | null;
  herkunft: 'gemessen' | 'stammdaten' | 'angenommen' | string;
  quelle?: string | null;
}

export interface MispelCheckAnsicht {
  site_id: string;
  stand: MispelCheckStand;
  stand_seit: string | null;
  formelsatz: string | null;
  fenster_von: string | null;
  fenster_bis: string | null;
  /** Unterschied im Jahr = mit Abgrenzungsoption − heute, je Fall; nur im Stand `fertig`. */
  differenz: { niedrig_eur: number; mittel_eur: number; hoch_eur: number } | null;
  posten: MispelCheckPosten[];
  datenbasis: MispelCheckAngabe[];
  hinweis: string | null;
}

export const mispelCheckApi = {
  lesen: (siteId: string) => request<MispelCheckAnsicht>(`/api/v1/sites/${encodeURIComponent(siteId)}/mispel-check`),
};

/**
 * Die Wörter der Posten (Vertrag § 3) — Begriff aus EEG und Festlegung, Erklärung und Fundstelle wie im
 * abgestimmten Bedienkonzept; `kurz` ist das Wort im Satz des Urteils.
 */
export const POSTEN_WORTE: Record<string, { wort: string; erklaerung: string; kurz: string; nullSatz?: string }> = {
  handel_saldierung: {
    wort: 'Netzladen-Handel mit Saldierung',
    erklaerung:
      'günstig aus dem Netz laden, teuer zurückspeisen; Umlagen und Netzentgelt entfallen auf die saldierte Menge (umlagereduzierende Strommenge (20), Anlage 1 S. 37)',
    kurz: 'Handel',
  },
  handel_heute: {
    wort: 'abzüglich Handel heute ohne Saldierung',
    erklaerung: 'was der Speicher schon heute ohne Saldierung am Markt verdient',
    kurz: 'Handel von heute',
  },
  jahresmarktwert: {
    wort: 'Jahresmarktwert statt Monatsmarktwert',
    erklaerung:
      'gesetzlich in jeder MiSpeL-Option: die Marktprämie rechnet mit dem Jahres- statt dem Monatsmarktwert (EEG Anlage 1 Nr. 2 S. 2; Anlage 1 S. 21)',
    kurz: 'Jahresmarktwert',
    nullSatz: 'Der Jahresmarktwert kostet bei dieser Anlage nichts.',
  },
  zaehler_z2: {
    wort: 'Zweiter Zähler Z2',
    erklaerung: 'Messentgelt und Einbau des geeichten Speicherzählers, auf 10 Jahre verteilt (Anlage 1 S. 32–33)',
    kurz: 'Zähler',
  },
  bilanzkreis: {
    wort: 'Gesonderter Bilanzkreis',
    erklaerung: 'Entgelt des Direktvermarkters für den gesonderten Bilanzkreis (§ 20 S. 2 EEG)',
    kurz: 'Bilanzkreis',
  },
  vermarktungsentgelt: {
    wort: 'Mehr Vermarktungsentgelt',
    erklaerung: 'Entgelt des Direktvermarkters auf die zusätzliche Rückspeisung',
    kurz: 'Vermarktungsentgelt',
  },
  // Pauschaloption P1 (MP-29; Wörter MP-27, BK-27)
  einspeisung_marktpraemie: {
    wort: 'Marktprämie statt Einspeisevergütung',
    erklaerung:
      'die Einspeisung bis zur Pauschalgrenze (P1) bekommt die Marktprämie mit dem Jahresmarktwert statt der festen Vergütung (§ 19 Abs. 3c EEG; Anlage 2 S. 28)',
    kurz: 'Marktprämie',
  },
  handel_pauschal: {
    wort: 'Netzladen-Handel mit der Pauschaloption',
    erklaerung: 'günstig aus dem Netz laden, teuer zurückspeisen — erlaubt in der Pauschaloption (Tenor Ziff. 4)',
    kurz: 'Handel',
  },
  saldierung_pauschal: {
    wort: 'Saldierung oberhalb der Pauschalgrenze',
    erklaerung:
      'Einspeisung über (P4) senkt die Umlagen auf Ihren Netzbezug, höchstens bis zum Netzbezug (P9) (saldierungsfähige Netzeinspeisung (P10), Anlage 2 S. 31)',
    kurz: 'Saldierung',
    nullSatz: 'Über die Saldierungsgrenze (P4) kommt diese Anlage voraussichtlich nicht.',
  },
  direktvermarktungsentgelt: {
    wort: 'Direktvermarktungsentgelt',
    erklaerung: 'Entgelt Ihres Direktvermarkters — in der Pauschaloption geht die ganze Anlage in die Direktvermarktung (§ 20 EEG)',
    kurz: 'Direktvermarkter',
  },
  messstellenbetrieb: {
    wort: 'Mehrkosten Messstellenbetrieb',
    erklaerung: 'Viertelstundenwerte am Hausanschluss (intelligentes Messsystem); ein zweiter Zähler ist nicht nötig (Anlage 2 S. 27)',
    kurz: 'Messstellenbetrieb',
  },
};

/** Was die Abgrenzungsoption verlangt — mit Fundstelle in Festlegung und EEG. */
export const ABGRENZUNG_VERLANGT: { satz: string; fundstelle: string }[] = [
  { satz: 'zweiter geeichter Zähler Z2 am Speicher', fundstelle: 'Anlage 1 S. 32–33' },
  { satz: 'Direktvermarkter mit gesondertem Bilanzkreis', fundstelle: '§ 20 S. 2 EEG' },
  { satz: 'bis 30.09.2027: Einverständnis von Netz- und Messstellenbetreiber', fundstelle: 'Tenor Ziff. 9a' },
  { satz: 'Marktprämie mit Jahres- statt Monatsmarktwert', fundstelle: 'EEG Anlage 1 Nr. 2 S. 2; Anlage 1 S. 21' },
];

/** Was die Pauschaloption verlangt — Voraussetzungen der Anlage 2 (Abschn. 3.1.1, S. 18–19). */
export const PAUSCHAL_VERLANGT: { satz: string; fundstelle: string }[] = [
  { satz: 'höchstens 30 kWp Solarleistung, Steckersolargeräte nicht mitgezählt', fundstelle: 'Anlage 2 S. 19, Voraussetzung 3' },
  { satz: 'nur Solar, Speicher und Ladepunkte hinter dem Zähler', fundstelle: 'Anlage 2 S. 18, Voraussetzung 1' },
  { satz: 'alles betreibt dieselbe Person', fundstelle: 'Anlage 2 S. 18, Voraussetzung 2' },
  { satz: 'alles in der Direktvermarktung, auch Steckersolargeräte', fundstelle: 'Anlage 2 S. 19, Voraussetzung 4' },
  { satz: 'gilt erst ab dem Monatsersten nach der EU-Genehmigung', fundstelle: 'Tenor Ziff. 9b' },
];

/** Ist das ein Check der Pauschaloption (Formelsatz P1–P5 der Anlage 2)? */
export function istPauschal(formelsatz: string | null | undefined): boolean {
  return formelsatz != null && /^P\d/.test(formelsatz);
}

/** „+ 1.899 €“ / „− 555 €“ / „0 €“ — ganze Euro im Jahr, das Vorzeichen ein eigenes Zeichen. */
export function jahresEuro(v: number): string {
  const ganz = Math.sign(v) * Math.round(Math.abs(v));
  const betrag = `${Math.abs(ganz).toLocaleString('de-DE', { maximumFractionDigits: 0 })}${NBSP}€`;
  if (ganz === 0) return betrag;
  return `${ganz < 0 ? '−' : '+'}${NBSP}${betrag}`;
}

function liste(woerter: string[]): string {
  if (woerter.length <= 1) return woerter.join('');
  return `${woerter.slice(0, -1).join(', ')} und ${woerter[woerter.length - 1]}`;
}

export interface CheckPostenZeile {
  art: string;
  wort: string;
  erklaerung: string | null;
  eur: number;
}

export type CheckKurzfassung =
  | { art: 'wird_gerechnet' }
  | { art: 'hinweis'; stand: 'fehlgeschlagen' | 'nicht_unterstuetzt'; satz: string }
  | {
      art: 'ergebnis';
      ton: 'plus' | 'minus' | 'null';
      betrag: string;
      urteil: string;
      grund: string;
      ungunstig: number;
      mittel: number;
      guenstig: number;
      fenster: string | null;
      posten: CheckPostenZeile[];
      summe: number;
      angenommen: string[];
      /** Der Satz des Schreibers (z. B. „Information vor dem Wechsel …“, Knotengrenze) — nie verschluckt. */
      hinweis: string | null;
      pauschal: boolean;
    };

/** „10/2025–09/2026“ aus dem tagesgenauen Fenster (letzter Tag eingeschlossen). */
export function fensterText(von: string | null, bis: string | null): string | null {
  if (!von || !bis) return null;
  const m = (t: string) => `${t.slice(5, 7)}/${t.slice(0, 4)}`;
  return `${m(von)}–${m(bis)}`;
}

function wertText(a: MispelCheckAngabe): string {
  if (a.wert == null) return a.angabe;
  const w = typeof a.wert === 'number' ? a.wert.toLocaleString('de-DE') : a.wert;
  return `${a.angabe} ${w}${a.einheit ? `${NBSP}${a.einheit}` : ''}`;
}

/**
 * Der Satz des Grundes aus den Posten der mittleren Schätzung: was bringt, trägt was kostet — oder nicht. Ein Minus
 * steht nie allein (BK-48 A): der Satz nennt, wofür es anfällt; ein Posten von 0 € bekommt seinen eigenen Satz.
 */
export function grundSatz(posten: CheckPostenZeile[], mittel: number, formelsatz: string | null): string {
  const plus = posten.filter((p) => Math.round(p.eur) > 0);
  const minus = posten.filter((p) => Math.round(p.eur) < 0);
  const nullen = posten.filter((p) => Math.round(p.eur) === 0);
  const kurz = (p: CheckPostenZeile) => POSTEN_WORTE[p.art]?.kurz ?? p.wort;
  const summe = (l: CheckPostenZeile[]) => l.reduce((s, p) => s + p.eur, 0);
  const saetze: string[] = [];
  if (plus.length && minus.length) {
    const verb = plus.length > 1 ? 'tragen' : 'trägt';
    saetze.push(
      `${jahresEuro(summe(plus))} ${liste(plus.map(kurz))} ${verb} ${jahresEuro(summe(minus))} für ${liste(minus.map(kurz))}${mittel < 0 ? ' nicht' : ''}.`,
    );
  } else if (plus.length) {
    saetze.push(`${jahresEuro(summe(plus))} ${liste(plus.map(kurz))}, keine Kosten dagegen.`);
  } else if (minus.length) {
    saetze.push(`Kein Posten bringt etwas; ${jahresEuro(summe(minus))} für ${liste(minus.map(kurz))}.`);
  }
  for (const p of nullen) {
    const s = POSTEN_WORTE[p.art]?.nullSatz;
    if (s) saetze.push(s);
  }
  if (mittel < 0) {
    saetze.push(
      formelsatz === 'A1'
        ? 'Sie können trotzdem wechseln — etwa für Rechtssicherheit beim Mischen.'
        : 'Sie können trotzdem wechseln.',
    );
  }
  return saetze.join(' ');
}

export function kurzfassung(a: MispelCheckAnsicht | null | undefined): CheckKurzfassung {
  if (!a || a.stand === 'wird_gerechnet') return { art: 'wird_gerechnet' };
  if (a.stand === 'fehlgeschlagen' || a.stand === 'nicht_unterstuetzt') {
    const sonst =
      a.stand === 'fehlgeschlagen'
        ? 'Der Check konnte für diese Anlage nicht gerechnet werden.'
        : 'Diesen Formelsatz rechnet der Check noch nicht.';
    return { art: 'hinweis', stand: a.stand, satz: a.hinweis?.trim() || sonst };
  }
  // „fertig“ ohne Beträge darf es nicht geben (Datenbank-CHECK); käme es doch: lieber warten als 0 € zeigen.
  if (!a.differenz) return { art: 'wird_gerechnet' };
  const { niedrig_eur, mittel_eur, hoch_eur } = a.differenz;
  const posten: CheckPostenZeile[] = a.posten.map((p) => ({
    art: p.art,
    wort: POSTEN_WORTE[p.art]?.wort ?? p.art,
    erklaerung: POSTEN_WORTE[p.art]?.erklaerung ?? null,
    eur: p.mittel_eur ?? 0,
  }));
  const mittel = mittel_eur;
  const ton = Math.round(mittel) > 0 ? 'plus' : Math.round(mittel) < 0 ? 'minus' : 'null';
  const urteil =
    ton === 'plus'
      ? 'Lohnt sich für diese Anlage voraussichtlich.'
      : ton === 'minus'
        ? 'Lohnt sich für diese Anlage voraussichtlich nicht.'
        : 'Bringt dieser Anlage voraussichtlich weder mehr noch weniger.';
  return {
    art: 'ergebnis',
    ton,
    betrag: jahresEuro(mittel),
    urteil,
    grund: grundSatz(posten, mittel, a.formelsatz),
    ungunstig: Math.min(niedrig_eur, mittel_eur, hoch_eur),
    mittel,
    guenstig: Math.max(niedrig_eur, mittel_eur, hoch_eur),
    fenster: fensterText(a.fenster_von, a.fenster_bis),
    posten,
    summe: posten.reduce((s, p) => s + p.eur, 0),
    angenommen: a.datenbasis
      .filter((d) => d.herkunft === 'angenommen')
      .map((d) => `${wertText(d)}${d.quelle ? ` (${d.quelle})` : ''}`),
    hinweis: a.hinweis?.trim() || null,
    pauschal: istPauschal(a.formelsatz),
  };
}

/** Lage der Spanne auf einer Achse, die 0 € immer einschließt: Prozent für Band, Null-Strich und Mitte. */
export function spanneLage(ungunstig: number, mittel: number, guenstig: number): {
  von: number;
  bis: number;
  null: number;
  mitte: number;
} {
  const lo = Math.min(ungunstig, 0);
  const hi = Math.max(guenstig, 0);
  const rand = (hi - lo || 1) * 0.12;
  const a = lo - rand;
  const b = hi + rand;
  const pct = (v: number) => Math.round(((v - a) / (b - a)) * 1000) / 10;
  return { von: pct(ungunstig), bis: pct(guenstig), null: pct(0), mitte: pct(mittel) };
}
