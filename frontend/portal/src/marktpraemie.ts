/**
 * Die **Marktprämie-Zeile erklärt sich selbst** — rein, ohne React.
 *
 * Anlass war eine echte Kundenrückfrage („Wie ist das zu lesen?") vor einem
 * nackten „+ 0,00 € · Marktprämie": die Zahl war RICHTIG (anzulegender Wert
 * 6,9 ct, vorläufiger Monatsmarktwert Solar 7,0 ct ⇒ `max(6,9 − 7,0, 0) = 0`,
 * Formel `SlotEconomics.java:293–312`), aber sie sagte nicht, dass sie eine
 * gute Nachricht ist — die Vergütung kam in diesem Monat schlicht voll aus dem
 * Markt. Erklärt hat es am Ende ein Mensch von Hand; genau das soll die Zeile
 * selbst tun.
 *
 * **Vier ehrliche Zustände**, und der Unterschied zwischen ihnen ist der ganze
 * Punkt — vorher trugen zwei davon dieselbe „0":
 *  1. `voll_aus_dem_markt` — Prämie 0, weil der Monatsmarktwert den
 *     anzulegenden Wert erreicht hat. Eine BERECHNETE Null, also eine Zahl,
 *     und ein RUHIGER Ton: hier ist nichts kaputt.
 *  2. `aufstockung` — Prämie > 0. Die Rechnung steht kompakt daneben, damit
 *     der Betrag nachrechenbar ist statt geglaubt.
 *  3. `kein_wert` — kein anzulegender Wert hinterlegt. Hier ist „0,00 €"
 *     verboten: eine Null behauptete eine Rechnung, die nie stattgefunden hat.
 *     Es gibt „—" MIT Grund (und, wo es etwas zu tun gibt, den Weg dorthin).
 *  4. `nicht_berechenbar` — der Wert ist gepflegt, für diesen Zeitraum gibt es
 *     aber keine Zurechnung (kein veröffentlichter Monatsmarktwert, keine
 *     berechtigte Viertelstunde). Ebenfalls „—" mit Grund.
 *
 * **Die Vorläufigkeit ist eine eigene, ruhige Zeile** und kein Alarm: solange
 * der Monatsmarktwert vorläufig ist UND nah am anzulegenden Wert liegt
 * (`BORDERLINE_CT`), kann sich die Prämie noch drehen — das gehört gesagt,
 * bevor der Kunde es an einer geänderten Zahl bemerkt.
 *
 * Es wird hier **nichts gerechnet, was der Server nicht schon geliefert hat**:
 * `marktpraemieEur` ist die Wahrheit, die drei ct-Größen erklären sie nur.
 */

import { einstellungenHash } from './settingsNav';
import { NBSP } from './format';
import type { PlantKind, SiteEarningsRange } from './api';

/** Die eine Zeitzone, in der Perioden hier geschnitten werden (`HistoryRange.ZONE`). */
const ZONE = 'Europe/Berlin';

/**
 * Ab welchem Abstand zwischen Monatsmarktwert und anzulegendem Wert ein noch
 * VORLÄUFIGER Monatswert die Aussage nicht mehr kippen kann. 0,3 ct/kWh ist
 * bewusst großzügig: eine Nachmeldung bewegt den Monatswert typischerweise um
 * Zehntel, und lieber einmal zu oft „kann sich noch ändern" als eine Zahl, die
 * sich später kommentarlos dreht.
 */
export const BORDERLINE_CT = 0.3;

/** Der Gedankenstrich — die einzige erlaubte Nicht-Zahl. */
const DASH = '—';

export type MarktpraemieState =
  | 'aufstockung'
  | 'voll_aus_dem_markt'
  | 'kein_wert'
  | 'nicht_berechenbar';

export interface MarktpraemieInput {
  /** Der vom Server berechnete Betrag; `null` = keine Zurechnung. */
  marktpraemieEur: number | null | undefined;
  /** Der EEG-Referenzsatz der Anlage (ct/kWh). */
  anzulegenderWertCtKwh: number | null | undefined;
  /** Der export-gewichtete Monatsmarktwert Solar (ct/kWh). */
  marketValueSolarCtKwh: number | null | undefined;
  /** Ob dieser Monatswert noch vorläufig ist. */
  marketValueProvisional: boolean | null | undefined;
  /** Die eingespeiste Menge des Zeitraums — belegt die Rechnung. */
  eingespeistKwh: number | null | undefined;
  plantKind: PlantKind;
  /** Der gewählte Zeitraum — er entscheidet über den Anteiligkeits-Hinweis. */
  range?: SiteEarningsRange | null;
  /** Fensterbeginn (ISO) — Berlin-geschnitten, siehe `HistoryRange.window()`. */
  from?: string | null;
  /** Fensterende (ISO, EXKLUSIV). */
  to?: string | null;
  /** Für den Weg in die Einstellungen; ohne ihn gibt es keinen Link. */
  siteId?: string | null;
}

export interface MarktpraemieView {
  state: MarktpraemieState;
  /** Die Zeilen-Überschrift MIT ihrem Monat: „Marktprämie · August 2026". */
  label: string;
  /** Der Monat, dem die Prämie gehört — null, sobald der Zeitraum mehrere umfasst. */
  monatLabel: string | null;
  /**
   * „vorläufig — amtlich ca. Mitte des Folgemonats" / „amtlich". Null, solange
   * der Server den Stand nicht meldet: ein „amtlich" zu behaupten, das niemand
   * gesagt hat, wäre die schlimmere Auskunft.
   */
  statusText: string | null;
  /**
   * Der Anteiligkeits-Zusatz in Tages-/Wochenansichten. Die Prämie ist eine
   * MONATS-Größe: die hier gezeigte Zahl ist die Zurechnung der Tages-kWh zur
   * Monatsrate, keine Tagesabrechnung.
   */
  anteiligText: string | null;
  /** „+ 212,40 €" · „0,00 €" · „—". */
  wert: string;
  /** false ⇒ die Zeile zeigt „—" (gedämpft). */
  vorhanden: boolean;
  /** Die eine Hauptaussage mit den ECHTEN Zahlen. */
  note: string;
  /** Ruhige Zusatzzeilen (Vorläufigkeit, „bereits enthalten", Weg dorthin). */
  hinweise: string[];
  /** true, solange ein vorläufiger Monatswert die Aussage noch drehen kann. */
  vorlaeufigKnapp: boolean;
  /** Deep-Link in die Einstellungs-Gruppe „Strompreis & Vergütung" — oder null. */
  href: string | null;
}

/**
 * Der Vorläufigkeits-Satz für den KNAPPEN Fall — er trägt den amtlichen
 * Termin gleich mit, damit daneben nicht zweimal dasselbe steht.
 */
const VORLAEUFIG_HINWEIS =
  'Endgültiger Monatswert steht aus (amtlich ca. Mitte des Folgemonats) — die Prämie kann sich noch ändern.';

const ENTHALTEN_HINWEIS = 'bereits im Einspeise-Erlös enthalten';

export const STATUS_VORLAEUFIG = 'vorläufig — amtlich ca. Mitte des Folgemonats';
export const STATUS_AMTLICH = 'amtlich';

export const ANTEILIG_HINWEIS = 'anteilig — abgerechnet je Monat';

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ct/kWh in Kundenschreibweise — eine Nachkommastelle, feinere Werte bleiben fein. */
function ct(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function euro(v: number): string {
  const betrag = Math.abs(v).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Eine berechnete Null ist weder Plus noch Minus — ein „+ 0,00 €" liest sich
  // wie ein Zugewinn, den es nicht gab.
  if (Math.abs(v) < 0.005) return `0,00${NBSP}€`;
  return `${v < 0 ? '−' : '+'} ${betrag}${NBSP}€`;
}

function kwh(v: number): string {
  return `${v.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}${NBSP}kWh`;
}

/** Rundet auf die ANGEZEIGTEN zwei Stellen — für die Nachrechenbarkeitsprobe. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Der Monat, dem die Prämie gehört — oder null, sobald der Zeitraum mehrere
 * Kalendermonate berührt.
 *
 * **Warum der Kalendermonat und nicht der Zeitraum:** ein Slot zieht seinen
 * Monatsmarktwert über den BERLINER Kalendermonat, in dem er liegt
 * (`EarningsRepository.MARKET_VALUE_JOIN`), und die Rate ist
 * `premium(M) = greatest(anzulegender Wert − Monatsmarktwert(M), 0)` (Klassen-
 * Javadoc derselben Datei). Der Monat IST also die Abrechnungseinheit.
 *
 * Das Fensterende ist EXKLUSIV, deshalb wird die letzte Millisekunde davor
 * bewertet — sonst zöge ein sauberes Monatsfenster den Folgemonat mit herein.
 */
export function praemieMonat(from?: string | null, to?: string | null): string | null {
  if (!from || !to) return null;
  const start = new Date(from);
  const ende = new Date(new Date(to).getTime() - 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(ende.getTime())) return null;

  const key = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: ZONE }).slice(0, 7);
  if (key(start) !== key(ende)) return null;
  return start.toLocaleDateString('de-DE', { timeZone: ZONE, month: 'long', year: 'numeric' });
}

/**
 * Der amtliche Stand des Monatswerts. **Null bleibt null:** meldet der Server
 * den Stand nicht, wird keiner behauptet.
 */
export function statusText(provisional: boolean | null | undefined): string | null {
  if (provisional === true) return STATUS_VORLAEUFIG;
  if (provisional === false) return STATUS_AMTLICH;
  return null;
}

/**
 * Tages- und Wochenansichten zeigen eine ZURECHNUNG: die Tages-kWh mal der
 * Monatsrate. Abgerechnet wird der Monat — das gehört an die Zahl.
 */
export function anteiligText(range: SiteEarningsRange | null | undefined): string | null {
  return range === 'day' || range === 'week' ? ANTEILIG_HINWEIS : null;
}

/**
 * Ein vorläufiger Monatswert nahe am anzulegenden Wert kann die Prämie noch
 * drehen. Beide Größen müssen bekannt sein — ohne sie wird nichts behauptet.
 */
export function istKnappUndVorlaeufig(input: MarktpraemieInput): boolean {
  const aw = num(input.anzulegenderWertCtKwh);
  const mw = num(input.marketValueSolarCtKwh);
  if (aw == null || mw == null || input.marketValueProvisional !== true) return false;
  return Math.abs(mw - aw) <= BORDERLINE_CT;
}

/**
 * Die Aufstockungs-Rechnung („6,9 − 5,8 = 1,1 ct/kWh × 9.573,8 kWh eingespeist").
 * Sie erscheint NUR, wenn die angezeigten Zahlen wirklich aufgehen — eine
 * Gleichung, die um eine gerundete Stelle danebenliegt, wäre schlimmer als
 * keine.
 */
export function aufstockungsRechnung(input: MarktpraemieInput): string | null {
  const aw = num(input.anzulegenderWertCtKwh);
  const mw = num(input.marketValueSolarCtKwh);
  if (aw == null || mw == null) return null;
  const satz = aw - mw;
  if (satz <= 0) return null;
  if (Math.abs(round2(aw) - round2(mw) - round2(satz)) > 0.005) return null;

  const menge = num(input.eingespeistKwh);
  const rechnung = `${ct(aw)} − ${ct(mw)} = ${ct(satz)}${NBSP}ct/kWh`;
  return menge == null ? rechnung : `${rechnung} × ${kwh(menge)} eingespeist`;
}

/**
 * Die selbsterklärende Marktprämie-Zeile. Sie liest ausschließlich Felder, die
 * der Endpunkt schon liefert.
 */
export function marktpraemie(input: MarktpraemieInput): MarktpraemieView {
  const eur = num(input.marktpraemieEur);
  const aw = num(input.anzulegenderWertCtKwh);
  const mw = num(input.marketValueSolarCtKwh);
  const knapp = istKnappUndVorlaeufig(input);
  const href = input.siteId ? einstellungenHash(input.siteId, 'geld') : null;

  const monat = praemieMonat(input.from, input.to);
  const status = statusText(input.marketValueProvisional);
  const anteilig = anteiligText(input.range);

  /**
   * Der gemeinsame Rahmen JEDES Zustands: der Monat gehört in die Überschrift,
   * Stand und Anteiligkeit stehen VOR den zustandsspezifischen Zeilen — sie
   * qualifizieren die Zahl, die darüber steht.
   *
   * Der Vorläufigkeits-Stand entfällt genau dort, wo die knappe Lage ihn
   * ausführlicher schon sagt; zweimal derselbe Termin wäre Rauschen.
   */
  const rahmen = (
    v: Omit<
      MarktpraemieView,
      'label' | 'monatLabel' | 'statusText' | 'anteiligText' | 'vorlaeufigKnapp'
    > & { hinweise: string[] },
  ): MarktpraemieView => ({
    ...v,
    label: monat ? `Marktprämie · ${monat}` : 'Marktprämie',
    monatLabel: monat,
    statusText: status,
    anteiligText: anteilig,
    vorlaeufigKnapp: knapp,
    hinweise: [
      ...(status && !knapp ? [status] : []),
      ...(anteilig ? [anteilig] : []),
      ...v.hinweise,
    ],
  });

  // (3) Ohne anzulegenden Wert hat NIEMAND gerechnet — also gibt es auch keine
  // Zahl, nicht einmal eine Null.
  if (aw == null) {
    return input.plantKind === 'direktvermarktung'
      ? rahmen({
          state: 'kein_wert',
          wert: DASH,
          vorhanden: false,
          note: 'Kein anzulegender Wert hinterlegt — ohne ihn lässt sich keine Marktprämie berechnen.',
          hinweise: ['Sie können ihn unter „Einstellungen · Strompreis & Vergütung" nachtragen.'],
          href,
        })
      : // Ohne Direktvermarktung gibt es GAR KEINE Prämie — dann ist der Stand
        // des Monatsmarktwerts kein Zusatz, sondern Rauschen. Diese eine Zeile
        // steht deshalb bewusst ohne Rahmen.
        {
          state: 'kein_wert',
          label: 'Marktprämie',
          monatLabel: null,
          statusText: null,
          anteiligText: null,
          wert: DASH,
          vorhanden: false,
          note: 'Ihre Anlage wird nicht direkt vermarktet — eine Marktprämie fällt hier nicht an.',
          hinweise: [],
          vorlaeufigKnapp: false,
          href: null,
        };
  }

  // (4) Der Wert ist gepflegt, für diesen Zeitraum gibt es aber keine
  // Zurechnung. Auch das ist „—" MIT Grund, nie eine erfundene Null.
  if (eur == null) {
    return rahmen({
      state: 'nicht_berechenbar',
      wert: DASH,
      vorhanden: false,
      note:
        mw == null
          ? 'Für diesen Zeitraum ist noch kein Monatsmarktwert Solar veröffentlicht — die Prämie steht damit noch nicht fest.'
          : 'In diesem Zeitraum ist keine Prämie angefallen.',
      hinweise: [],
      href: null,
    });
  }

  // (1) Eine berechnete Null: der Markt hat den anzulegenden Wert erreicht.
  if (Math.abs(eur) < 0.005) {
    let note: string;
    if (mw == null) {
      note =
        'In diesem Zeitraum lag der Monatsmarktwert Solar nicht unter Ihrem Garantiewert — Ihre Vergütung kommt voll aus dem Markt.';
    } else if (Math.abs(round2(mw) - round2(aw)) < 0.005) {
      note = `Monatsmarktwert (${ct(mw)}${NBSP}ct) liegt genau auf Höhe Ihres Garantiewerts — Ihre Vergütung kommt diesen Monat voll aus dem Markt.`;
    } else {
      note = `Monatsmarktwert (${ct(mw)}${NBSP}ct) liegt über Ihrem Garantiewert (${ct(aw)}${NBSP}ct) — Ihre Vergütung kommt diesen Monat voll aus dem Markt.`;
    }
    return rahmen({
      state: 'voll_aus_dem_markt',
      wert: euro(0),
      vorhanden: true,
      note,
      hinweise: knapp ? [VORLAEUFIG_HINWEIS] : [],
      href: null,
    });
  }

  // (2) Eine echte Aufstockung — mit ihrer Rechnung.
  const rechnung = aufstockungsRechnung(input);
  return rahmen({
    state: 'aufstockung',
    wert: euro(eur),
    vorhanden: true,
    note: rechnung ?? ENTHALTEN_HINWEIS,
    hinweise: [...(rechnung ? [ENTHALTEN_HINWEIS] : []), ...(knapp ? [VORLAEUFIG_HINWEIS] : [])],
    href: null,
  });
}
