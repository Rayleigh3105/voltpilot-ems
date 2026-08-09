/**
 * **Δ zur Vorperiode** — die reine Wahrheit hinter der Vergleichszeile jeder
 * Kennzahl der Karte 1 beider Historie-Welten (Konzept
 * `data/vp-historie-konzept-t4`, Feature **F3**).
 *
 * Warum das die billigste Form von „nachschauen" ist: die Frage hinter jeder
 * Zahl auf dieser Seite lautet „ist das viel?", und sie war bisher nur durch
 * Blättern zu beantworten. Der Vergleich ist ein zweiter Abruf **desselben**
 * Endpunkts mit verschobenem Anker — er läuft durch denselben Cache
 * (`historyCache.ts`), kostet also beim Zurückblättern nichts mehr.
 *
 * **Die drei Ehrlichkeitsregeln, die hier Gesetz sind:**
 *
 * 1. **Kein Δ ohne Vergleichsbasis.** Trug die Vorperiode diesen Kanal gar
 *    nicht (`null`), gibt es keine Zeile — niemals ein Vergleich gegen eine
 *    erfundene Null (die genau dann „+∞ %" bedeutete).
 * 2. **Eine laufende Periode wird als solche beschriftet.** Ein halber Juli
 *    gegen einen vollen Juni ist kein Rückgang, sondern ein halber Monat; der
 *    Vergleich wird trotzdem gezeigt (er ist die einzige Einordnung, die es
 *    gibt), aber der Satz darüber sagt es ausdrücklich.
 * 3. **Gewertet wird nur, wo die Richtung eindeutig ist.** Mehr Erzeugung ist
 *    besser, weniger Netzbezug ist besser — mehr Verbrauch, mehr Ladung oder
 *    mehr Einspeisung sind es NICHT (eine Eigenverbrauchs-Anlage will weniger
 *    einspeisen). Wo es keine eindeutige Richtung gibt, bleibt die Zeile
 *    neutral: die Richtung ist die Tatsache, die Wertung wäre eine Behauptung.
 *
 * Kein React, kein Netz (das `fleet.ts`/`schedule.ts`-Muster).
 */
import type { HistoryCoverage, HistoryRange } from './api';
import type { EnergieSummeKey } from './energieBilanz';
import { isCurrentPeriod } from './energieBilanz';
import { isoWeek, periodLabel, shiftAnchor } from './periodNav';

/** Unter dieser Änderung sagt die Seite „etwa wie" statt einer Richtung. */
export const FLACH_PCT = 3;

/** Beträge unter dieser Schwelle sind keine Vergleichsbasis (kWh bzw. €). */
export const BASIS_EPSILON = 0.05;

/** Wie eine Änderung zu lesen ist. */
export type DeltaRichtung = 'mehr' | 'weniger' | 'gleich';

/** Ob die Richtung für DIESE Kennzahl gut, schlecht oder schlicht neutral ist. */
export type DeltaWertung = 'gut' | 'schlecht' | 'neutral';

export interface DeltaView {
  richtung: DeltaRichtung;
  wertung: DeltaWertung;
  /** Gerundete Änderung in Prozent, Betrag (das Vorzeichen steckt in `richtung`). */
  pct: number;
  /** Die fertige Zeile: „18 % mehr als im Juni" / „etwa wie im Juni". */
  text: string;
  /** Der ausführliche Titel mit beiden Zahlen. */
  titel: string;
}

/**
 * Wohin der Vergleich schaut — der Anker der Vorperiode. Bewusst genau die
 * bestehende Blätter-Geste (`shiftAnchor(-1)`), damit „Vergleich" und
 * „ein Zeitraum zurück" nie auseinanderlaufen können.
 */
export function vergleichsAnker(anchor: Date, range: HistoryRange): Date {
  return shiftAnchor(anchor, range, -1);
}

/**
 * **F8 · welche Periode überlagert wird.** `'aus'` blendet die Überlagerung ab,
 * lässt das Δ (F3) aber unverändert gegen die Vorperiode laufen — es ist die
 * Einordnung, die es immer gibt. `'vorjahr'` ist die zweite Wahl beim Monat
 * (Juli 2026 gegen Juli 2025 ist die Frage, die ein Betreiber wirklich stellt;
 * Juni ist ein anderer Sonnenstand).
 */
export type VergleichsModus = 'aus' | 'vorperiode' | 'vorjahr';

/**
 * Gegen WAS gerechnet wird. `'aus'` schaltet nur die Überlagerung ab, nicht den
 * Vergleich — sonst könnten Δ-Zeile und Überlagerung sich widersprechen, weil
 * jede ihre eigene Vorperiode wählte. Es gibt genau diese eine Quelle.
 */
export function wirksamerModus(modus: VergleichsModus): 'vorperiode' | 'vorjahr' {
  return modus === 'vorjahr' ? 'vorjahr' : 'vorperiode';
}

/** Wird die zweite Reihe gezeichnet? */
export function ueberlagerungAktiv(modus: VergleichsModus): boolean {
  return modus !== 'aus';
}

/**
 * Der Anker der Vergleichsperiode. Vorperiode = die bestehende Blätter-Geste;
 * Vorjahr = derselbe Zeitraum ein Jahr früher (beim Monat der 1., damit keine
 * Monatslänge den Anker in den Nachbarmonat kippt).
 */
export function vergleichsAnkerFor(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus,
): Date {
  if (wirksamerModus(modus) === 'vorperiode') return vergleichsAnker(anchor, range);
  const d = new Date(anchor);
  if (range === 'month') {
    d.setFullYear(d.getFullYear() - 1, d.getMonth(), 1);
    return d;
  }
  d.setFullYear(d.getFullYear() - 1);
  return d;
}

/**
 * Der Name der Vorperiode, wie ihn ein Mensch sagt: „Juni", „2025",
 * „der Vorwoche", „dem Vortag". Bei einem Monat aus einem anderen Jahr steht
 * das Jahr dabei — „Dezember 2025" ist eine andere Aussage als „Dezember".
 */
export function vergleichsName(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus = 'vorperiode',
): string {
  const vorher = vergleichsAnkerFor(anchor, range, modus);
  const vorjahr = wirksamerModus(modus) === 'vorjahr';
  if (range === 'day') return vorjahr ? datumName(vorher) : 'dem Vortag';
  if (range === 'week') return vorjahr ? `KW ${isoWeek(vorher)} ${vorher.getFullYear()}` : 'der Vorwoche';
  if (range === 'year') return String(vorher.getFullYear());
  const monat = vorher.toLocaleDateString('de-DE', { month: 'long' });
  return vorher.getFullYear() === anchor.getFullYear()
    ? monat
    : `${monat} ${vorher.getFullYear()}`;
}

function datumName(d: Date): string {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Die Kopfzeile der Karte: „Vergleich: Juni 2026". */
export function vergleichsKopf(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus = 'vorperiode',
): string {
  return `Vergleich: ${periodLabel(vergleichsAnkerFor(anchor, range, modus), range)}`;
}

/**
 * **Der Zustands-Chip der Mobil-Bedienzeile.** Am Telefon wandert der
 * „Vergleichen"-Umschalter ins ⋯-Blatt (P4) — ein GESETZTER Vergleich darf
 * damit aber nicht unsichtbar werden, sonst überlagert das Diagramm eine zweite
 * Reihe, die niemand bestellt zu haben scheint. Also: **Bedienung versteckt,
 * Zustand sichtbar.**
 *
 * Null bei „Aus" — ein Chip, der „kein Vergleich" sagt, wäre Rauschen.
 */
export function vergleichsChip(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus,
): string | null {
  if (!ueberlagerungAktiv(modus)) return null;
  return vergleichsKopf(anchor, range, modus);
}

/**
 * Der Hinweis, der eine LAUFENDE Periode als solche kennzeichnet — sonst läse
 * sich ein halber Juli gegen einen vollen Juni wie ein Einbruch. Null, wenn der
 * Zeitraum abgeschlossen ist (dann gibt es nichts klarzustellen).
 */
export function laufendHinweis(
  anchor: Date,
  range: HistoryRange,
  now: Date,
  modus: VergleichsModus = 'vorperiode',
): string | null {
  if (!isCurrentPeriod(anchor, range, now)) return null;
  const jetzt = periodLabel(anchor, range);
  const vorher = periodLabel(vergleichsAnkerFor(anchor, range, modus), range);
  return `${jetzt} läuft noch — verglichen wird mit dem vollständigen Zeitraum ${vorher}.`;
}

/**
 * Ob mehr von dieser Kennzahl für den Kunden gut ist. `null` = nicht eindeutig,
 * dann bleibt der Vergleich neutral (Regel 3).
 */
export type MehrIstBesser = boolean | null;

/** Die Wertung je Energiesumme — bewusst nur dort, wo sie eindeutig ist. */
export const ENERGIE_WERTUNG: Record<EnergieSummeKey, MehrIstBesser> = {
  // Mehr Ertrag der eigenen Anlage ist eindeutig gut.
  erzeugt: true,
  // Mehr Verbrauch ist weder gut noch schlecht — es ist der Bedarf des Hauses.
  verbraucht: null,
  // Weniger Netzbezug ist eindeutig gut (weniger gekaufter Strom).
  bezogen: false,
  // Mehr Einspeisung ist NICHT per se gut: eine Eigenverbrauchs-Anlage will
  // genau das Gegenteil. Deshalb neutral.
  eingespeist: null,
  // Speicherbewegung ist Betrieb, keine Leistung — neutral.
  geladen: null,
  entladen: null,
};

/**
 * Das Δ einer Kennzahl. `null`, wenn es keinen ehrlichen Vergleich gibt:
 * die Vorperiode trug den Kanal nicht (`null`), oder ihr Wert ist so nah an
 * null, dass jeder Prozentsatz Unsinn wäre (Regel 1). Der aktuelle Wert darf
 * `null` sein — dann gibt es ebenfalls nichts zu vergleichen.
 */
export function delta(
  jetzt: number | null | undefined,
  vorher: number | null | undefined,
  mehrIstBesser: MehrIstBesser = null,
  name = 'der Vorperiode',
): DeltaView | null {
  if (jetzt == null || vorher == null) return null;
  if (!Number.isFinite(jetzt) || !Number.isFinite(vorher)) return null;
  if (Math.abs(vorher) < BASIS_EPSILON) return null;

  const roh = ((jetzt - vorher) / Math.abs(vorher)) * 100;
  const pct = Math.round(Math.abs(roh));
  const flach = pct < FLACH_PCT;
  const richtung: DeltaRichtung = flach ? 'gleich' : roh > 0 ? 'mehr' : 'weniger';
  const wertung: DeltaWertung =
    flach || mehrIstBesser == null
      ? 'neutral'
      : (richtung === 'mehr') === mehrIstBesser
        ? 'gut'
        : 'schlecht';
  const text = flach ? `etwa wie ${praep(name)}` : `${pct} % ${richtung} als ${praep(name)}`;
  const titel =
    `Zeitraum: ${fmt(jetzt)} · ${name === 'der Vorperiode' ? 'Vorperiode' : name}: ${fmt(vorher)}`;
  return { richtung, wertung, pct, text, titel };
}

/** „im Juni" / „am Vortag" / „in der Vorwoche" / „2025" — im richtigen Fall. */
function praep(name: string): string {
  if (name === 'dem Vortag') return 'am Vortag';
  if (name === 'der Vorwoche') return 'in der Vorwoche';
  if (name === 'der Vorperiode') return 'in der Vorperiode';
  // Eine Jahreszahl steht bloß: „mehr als 2025", nie „mehr als im 2025".
  if (/^\d{4}$/.test(name)) return name;
  return `im ${name}`;
}

function fmt(v: number): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

// --- F8: zwei Zeiträume überlagern ------------------------------------------

/** Eine Wahl des „Vergleichen"-Umschalters. */
export interface VergleichsOption {
  id: VergleichsModus;
  /** Der Knopftext („Aus" · „Vorperiode" · „Juli 2025"). */
  label: string;
  /** Der Titel, der die Wahl in einem Satz erklärt. */
  titel: string;
}

/**
 * Ob der VORJAHRES-Zeitraum überhaupt zur Wahl steht: nur beim **Monat**
 * (Captain-Vorgabe) und nur, wenn dort Daten liegen KÖNNEN — also die erste
 * gemessene Viertelstunde vor dem Ende jenes Monats liegt. Ohne Abdeckungsdaten
 * wird nichts behauptet und die Wahl bleibt offen (die Karte sagt dann selbst,
 * wenn nichts kam).
 */
export function vorjahrVerfuegbar(
  anchor: Date,
  range: HistoryRange,
  coverage?: HistoryCoverage | null,
): boolean {
  if (range !== 'month') return false;
  const ab = coverage?.firstDataAt ? new Date(coverage.firstDataAt) : null;
  if (!ab || Number.isNaN(ab.getTime())) return true;
  const vorjahr = vergleichsAnkerFor(anchor, range, 'vorjahr');
  // Ende jenes Monats: erster Tag des Folgemonats.
  const ende = new Date(vorjahr.getFullYear(), vorjahr.getMonth() + 1, 1);
  return ab.getTime() < ende.getTime();
}

/** Die Wahlmöglichkeiten des Umschalters — „Vorjahr" nur, wo es sie gibt. */
export function vergleichsOptionen(
  anchor: Date,
  range: HistoryRange,
  coverage?: HistoryCoverage | null,
): VergleichsOption[] {
  const optionen: VergleichsOption[] = [
    { id: 'aus', label: 'Aus', titel: 'Nur den gewählten Zeitraum zeigen' },
    {
      id: 'vorperiode',
      label: periodLabel(vergleichsAnkerFor(anchor, range, 'vorperiode'), range),
      titel: `Den vorherigen Zeitraum darüberlegen (${periodLabel(
        vergleichsAnkerFor(anchor, range, 'vorperiode'),
        range,
      )})`,
    },
  ];
  if (vorjahrVerfuegbar(anchor, range, coverage)) {
    const vorjahr = periodLabel(vergleichsAnkerFor(anchor, range, 'vorjahr'), range);
    optionen.push({
      id: 'vorjahr',
      label: vorjahr,
      titel: `Denselben Monat des Vorjahres darüberlegen (${vorjahr})`,
    });
  }
  return optionen;
}

/**
 * Ein per Lesezeichen mitgebrachter Modus, der hier gar nicht zur Wahl steht
 * („Vorjahr" auf einem Tages-Zeitraum), fällt auf die Vorperiode zurück statt
 * einen Zeitraum zu überlagern, den der Umschalter nicht anbietet.
 */
export function normalisiereModus(
  modus: VergleichsModus,
  anchor: Date,
  range: HistoryRange,
  coverage?: HistoryCoverage | null,
): VergleichsModus {
  if (modus === 'vorjahr' && !vorjahrVerfuegbar(anchor, range, coverage)) return 'vorperiode';
  return modus;
}

/** Die Beschriftung der Überlagerung: welche zwei Zeiträume liegen übereinander. */
export interface UeberlagerungLegende {
  /** „Juli 2026" — der gewählte Zeitraum (durchgezogen). */
  aktuell: string;
  /** „Juni 2026" — die Vergleichsperiode (blass/gestrichelt). */
  vergleich: string;
  /** Der eine Satz unter der Legende. */
  satz: string;
}

export function ueberlagerungLegende(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus,
): UeberlagerungLegende | null {
  if (!ueberlagerungAktiv(modus)) return null;
  const aktuell = periodLabel(anchor, range);
  const vergleich = periodLabel(vergleichsAnkerFor(anchor, range, modus), range);
  return {
    aktuell,
    vergleich,
    satz: `Durchgezogen: ${aktuell} · blass gestrichelt: ${vergleich}`,
  };
}

/**
 * Was die Seite sagt, wenn die gewählte Vergleichsperiode NICHTS trägt: es wird
 * gesagt, nicht gezeichnet — eine leere Reihe läse sich wie gemessene Nullen.
 */
export function keineVergleichsDatenText(
  anchor: Date,
  range: HistoryRange,
  modus: VergleichsModus,
): string {
  const vergleich = periodLabel(vergleichsAnkerFor(anchor, range, modus), range);
  return `Keine Daten für ${vergleich} — es gibt nichts zu überlagern.`;
}

/**
 * Zwei Zeiträume haben selten gleich viele Abschnitte (28 gegen 31 Tage, eine
 * Sommerzeit-Nacht). Die Überlagerung richtet sie deshalb am INDEX aus — der
 * erste Abschnitt liegt auf dem ersten — und schneidet bzw. füllt den Rest mit
 * `null`: eine Lücke ist ehrlich, ein gestreckter Wert wäre erfunden.
 */
export function angleichen(
  werte: readonly (number | null)[] | null | undefined,
  laenge: number,
): (number | null)[] {
  const quelle = werte ?? [];
  const out: (number | null)[] = [];
  for (let i = 0; i < laenge; i++) out.push(quelle[i] ?? null);
  return out;
}

/**
 * **Die EINE Δ-Zeile der Mobil-Fassung** (Konzept `data/vp-mobile-views-x1` §5,
 * Captain-Abnahme 09.08.2026). Am Telefon trug jede der sechs kWh-Kacheln ihre
 * eigene Δ-Zeile — 6 × ~90 px VOR dem Diagramm, das dadurch erst bei 1 908 px
 * begann. Die Summen bleiben vollzählig (zwei Spalten statt sechs Kacheln), der
 * VERGLEICH wird auf eine Zeile eingedampft.
 *
 * **Die Ehrlichkeit steckt darin, dass die Zeile ihre Größe NENNT.** Der
 * Entwurf zeichnete „gegen Vortag: etwa gleich" — ein Vergleich ohne
 * Gegenstand, der über sechs verschiedene Kanäle gleichzeitig zu sprechen
 * scheint. Hier steht stattdessen „Erzeugt · 18 % mehr als im Juni": WELCHE
 * Summe verglichen wurde, ist Teil der Aussage.
 *
 * Gewählt wird die ERSTE Summe der kanonischen Reihenfolge, die in BEIDEN
 * Zeiträumen eine Basis hat (die Reihenfolge beginnt mit „Erzeugt", also ist es
 * auf einer PV-Anlage die Erzeugung und auf einer Anlage ohne PV die nächste
 * wirklich gemessene Größe). Gibt es nirgends eine ehrliche Basis, ist das
 * Ergebnis `null` und die Zeile rendert gar nicht — nie ein Δ gegen eine
 * erfundene Null (`delta()` setzt dieselbe Regel je Kanal durch).
 */
export interface FuehrendesDelta {
  /** Das Etikett der verglichenen Summe („Erzeugt"). */
  label: string;
  view: DeltaView;
}

export function fuehrendesDelta(
  summen: readonly { key: EnergieSummeKey; label: string; kwh: number | null }[],
  vorherSummen: readonly { kwh: number | null }[] | null | undefined,
  vergleichName: string,
): FuehrendesDelta | null {
  if (!vorherSummen) return null;
  for (let i = 0; i < summen.length; i += 1) {
    const s = summen[i];
    const view = delta(s.kwh, vorherSummen[i]?.kwh, ENERGIE_WERTUNG[s.key], vergleichName);
    if (view) return { label: s.label, view };
  }
  return null;
}
