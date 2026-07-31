/**
 * **Die zwei Welten eine Ebene höher** — die Portfolio-Fassung von „Messwerte"
 * und „Erlöse" für die Betreiber-Schale (Konzept `data/vp-historie-konzept-t4`
 * §4.3 „Betreiber-Schale", PR **G**).
 *
 * Der behobene Befund: ein Betreiber musste **jede Anlage einzeln öffnen**, um
 * ihre Historie zu sehen — die Portfolio-Seite kennt nur „jetzt". Also bekommen
 * die zwei Welten dieselbe Fassung eine Ebene höher: **Σ oben, Anlagen-Tabelle
 * darunter, ein Klick auf eine Zeile öffnet DIESELBE Welt der Anlage im
 * GLEICHEN Zeitraum** (der Zeitraum reist über dieselben `z=`/`at=`-Parameter
 * mit, `historieWelten.historieHash`).
 *
 * Dieses Modul ist die reine, unit-getestete Wahrheit dazu (das
 * `portfolio.ts`/`historieWelten.ts`-Muster): kein React, kein Netz. **Es
 * rechnet nichts neu** — die Messwerte kommen aus `energieBilanz.energieSummen`
 * (derselbe Kern wie die Anlagen-Welt), das Geld aus dem mandantenweiten
 * `GET /api/v1/earnings` (dafür existiert er).
 *
 * **Die drei Ehrlichkeitsregeln, die hier Gesetz sind:**
 *
 * 1. **Eine Anlage ohne Daten fließt nie als 0 in eine Summe.** Sie steht mit
 *    ihrem ehrlichen Grund in der Tabelle; eine Summe ist `null`, wenn KEINE
 *    Anlage diesen Kanal getragen hat (die `energieBilanz`-Regel, nur eine
 *    Ebene höher).
 * 2. **Gemischte Abdeckung wird an der Summe BENANNT** („3 von 4 Anlagen mit
 *    Daten"), inklusive der Anlagen, deren Abruf fehlgeschlagen ist — ein
 *    Fehler ist keine Datenlage.
 * 3. **Quoten werden nicht aggregiert.** Autarkie und Eigenverbrauchsquote sind
 *    je Anlage definiert; ein Portfolio-Mittel über verschieden große Anlagen
 *    wäre eine Behauptung, kein Messwert. Sie stehen deshalb ausschließlich in
 *    der Anlagen-Welt (Konzept §4.3: „Summen ja, Quoten nur wenn sauber
 *    ableitbar").
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type {
  EarningsRange,
  EarningsReason,
  EarningsSite,
  History,
  HistoryRange,
  Site,
} from './api';
import {
  energieSummen,
  type EnergieFarbe,
  type EnergieSumme,
  type EnergieSummeKey,
} from './energieBilanz';
import { WELTEN, type Provenienz, type WeltId } from './historieWelten';
import type { PageId } from './nav';
import { activeModes } from './surface';
import { rangeWord } from './verlauf';

// ---------------------------------------------------------------------------
// Die zwei Welten des Portfolios
// ---------------------------------------------------------------------------

/** Dieselben zwei Welten wie auf der Anlage — nur über alle Anlagen. */
export type PortfolioWeltId = WeltId;

/** Kanonische Reihenfolge: erst die Basis-Welt, dann das Geld. */
export const PORTFOLIO_WELT_ORDER: readonly PortfolioWeltId[] = ['messwerte', 'erloese'];

export interface PortfolioWelt {
  id: PortfolioWeltId;
  /** Die Seite dieser Welt (`#/portfolio/messwerte` bzw. `…/erloese`). */
  page: PageId;
  /** Label, Icon und Abzeichen kommen aus der ANLAGEN-Welt — nie ein zweiter
   *  Name für dieselbe Sache. */
  label: string;
  icon: IconName;
  badge: Provenienz;
  /** Der Einleitungssatz des Welt-Kopfs (Portfolio-Fassung). */
  lead: string;
  /** Die Unterzeile auf der Wechsel-Karte. */
  switchLead: string;
  /** Die Fußkarte „Was diese Zahlen sind". */
  fussText: string;
}

export const PORTFOLIO_WELTEN: Record<PortfolioWeltId, PortfolioWelt> = {
  messwerte: {
    id: 'messwerte',
    page: 'portfolio-messwerte',
    label: WELTEN.messwerte.label,
    icon: WELTEN.messwerte.icon,
    badge: WELTEN.messwerte.badge,
    lead: 'Was alle Ihre Anlagen erzeugt, verbraucht und gespeichert haben.',
    switchLead: 'Energie über alle Anlagen',
    fussText:
      'Gemessene Werte Ihrer Anlagen in Viertelstunden, zu Tages- und Monatssummen verdichtet und ' +
      'über die Anlagen aufsummiert. Eine Anlage ohne Messwerte im Zeitraum fließt nicht als Null ' +
      'in die Summe ein, sondern steht mit ihrem Grund in der Tabelle. Autarkie und ' +
      'Eigenverbrauchsquote stehen bewusst nur je Anlage: ein Mittel über verschieden große ' +
      'Anlagen wäre eine Behauptung.',
  },
  erloese: {
    id: 'erloese',
    page: 'portfolio-erloese',
    label: WELTEN.erloese.label,
    icon: WELTEN.erloese.icon,
    badge: WELTEN.erloese.badge,
    lead: 'Was alle Ihre Anlagen im Zeitraum eingebracht haben.',
    switchLead: 'Einspeisung · Eigenverbrauch · Steuerung',
    fussText:
      'Bewertet, nicht abgerechnet: jede Viertelstunde wird mit dem heute gepflegten Preisblatt ' +
      'bzw. dem hinterlegten Stromtarif der jeweiligen Anlage gerechnet. Der Beitrag der Steuerung ' +
      'steckt bereits im Ertrag und ist deshalb eine Zurechnung, nie ein weiterer Summand. Ein ' +
      'Vermarktungsentgelt Ihres Direktvermarkters ist nicht abgezogen.',
  },
};

/** Die Portfolio-Welt hinter einer Seite — null, wenn die Seite keine ist. */
export function portfolioWeltForPage(page: PageId): PortfolioWelt | null {
  for (const id of PORTFOLIO_WELT_ORDER) {
    if (PORTFOLIO_WELTEN[id].page === page) return PORTFOLIO_WELTEN[id];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zeiträume
// ---------------------------------------------------------------------------

/** Ein Eintrag des Zeitraum-Segments. */
export interface PortfolioRange {
  id: HistoryRange;
  label: string;
}

const ALLE_RANGES: PortfolioRange[] = [
  { id: 'day', label: 'Tag' },
  { id: 'week', label: 'Woche' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
];

/**
 * Welche Zeiträume DIESE Welt ehrlich beantworten kann.
 *
 * Die Messwerte-Welt liest je Anlage `GET /sites/{id}/history` und kann deshalb
 * alle vier. **Die Erlöse-Welt liest den mandantenweiten `GET /earnings`, und
 * der kennt keine Woche** (`EarningsRange` = Tag/Monat/Jahr/Gesamt; die
 * Kalenderwoche ist dort bewusst nicht angeboten). Also steht sie hier gar
 * nicht erst zur Wahl — lieber eine Taste weniger als eine, die ins Leere
 * führt. Die Anlagen-eigene Erlöse-Welt kennt die Woche weiterhin.
 */
export function portfolioRanges(welt: PortfolioWeltId): PortfolioRange[] {
  return welt === 'erloese' ? ALLE_RANGES.filter((r) => r.id !== 'week') : ALLE_RANGES;
}

/**
 * Der Zeitraum, den diese Welt aus einem (womöglich per Lesezeichen
 * mitgebrachten) Wunsch macht: eine Woche in der Erlöse-Welt wird zum Monat —
 * sichtbar, denn das Segment zeigt dann „Monat" als aktiv, nie ein falsches
 * Etikett über Monatszahlen.
 */
export function portfolioRange(welt: PortfolioWeltId, range: HistoryRange): HistoryRange {
  return portfolioRanges(welt).some((r) => r.id === range) ? range : 'month';
}

/** Der Zeitraum-Name des mandantenweiten Geld-Endpunkts. */
export function earningsRangeFor(range: HistoryRange): EarningsRange {
  return range === 'week' ? 'month' : range;
}

/**
 * Der Link in eine Portfolio-Welt — MIT Zeitraum, damit der Wechsel ihn
 * mitnimmt (dieselben `z=`/`at=`-Parameter wie die Anlagen-Welten).
 */
export function portfolioHash(
  welt: PortfolioWeltId,
  range: HistoryRange,
  at?: string | null,
): string {
  const parts = [`z=${rangeWord(portfolioRange(welt, range))}`];
  if (at) parts.push(`at=${at}`);
  return `#/portfolio/${welt}?${parts.join('&')}`;
}

// ---------------------------------------------------------------------------
// Der Nav-Eintrag der Erlöse-Welt
// ---------------------------------------------------------------------------

/**
 * Gibt es im Portfolio überhaupt Geld zu zeigen? Genau dann, wenn **mindestens
 * eine Anlage einen Geld-Modus hat** — dieselbe Regel wie auf der Anlage
 * (`erloes-historie` kommt aus dem Markt- bzw. dem Lastspitzen-Manifest,
 * `surface.ts`), nur über die Flotte. Eine reine Privat-Flotte bekommt gar
 * keinen Erlöse-Eintrag statt einer Fläche, die dann nichts erklärt.
 *
 * **Bewusste Grenze (dokumentiert, kein Versehen):** abgeleitet wird aus den
 * Stammdaten, die die Schale ohnehin geladen hat (`SiteDto`) — es kostet
 * KEINEN zusätzlichen Abruf je Anlage. Ein Geld-Modus, der ausschließlich aus
 * einem aktiven Markt-FLOW stammt (ohne Direktvermarktung, ohne Netzladen auf
 * dynamischem Tarif, ohne Leistungspreis), ist hier deshalb nicht sichtbar; die
 * Erlöse-Welt DIESER Anlage bleibt über die Anlage selbst erreichbar.
 */
export function hatGeldWelt(sites: readonly Site[]): boolean {
  return sites.some((s) =>
    activeModes({
      config: {
        plantKind: s.plantKind,
        tarifArt: s.tarifArt,
        netzladenErlaubt: s.netzladenErlaubt,
        leistungspreisEurKw: s.leistungspreisEurKw ?? null,
      },
    }).some((m) => m.manifest.deepViews.includes('erloes-historie')),
  );
}

// ---------------------------------------------------------------------------
// Abdeckung: wie viele Anlagen tragen den Zeitraum?
// ---------------------------------------------------------------------------

/** Wie eine Anlage im Zeitraum dasteht. */
export type ZeilenZustand = 'daten' | 'leer' | 'fehler';

export interface PortfolioAbdeckung {
  gesamt: number;
  mitDaten: number;
  ohneDaten: number;
  fehler: number;
  /** Der Satz an der Summe — null, wenn ALLE Anlagen Daten tragen. */
  satz: string | null;
}

function anlagenWort(n: number): string {
  return n === 1 ? 'Anlage' : 'Anlagen';
}

/**
 * Der Abdeckungs-Satz an der Portfolio-Summe. Er erscheint nur, wenn es etwas
 * zu sagen gibt: tragen alle Anlagen Daten, ist die Summe vollständig und ein
 * Satz wäre Rauschen. Ein fehlgeschlagener Abruf wird SEPARAT benannt — er ist
 * keine Datenlage, sondern eine Störung.
 */
export function abdeckung(zustaende: readonly ZeilenZustand[]): PortfolioAbdeckung {
  const gesamt = zustaende.length;
  const mitDaten = zustaende.filter((z) => z === 'daten').length;
  const fehler = zustaende.filter((z) => z === 'fehler').length;
  const ohneDaten = zustaende.filter((z) => z === 'leer').length;
  let satz: string | null = null;
  if (gesamt > 0 && mitDaten < gesamt) {
    const teile = [`${mitDaten} von ${gesamt} ${anlagenWort(gesamt)} mit Daten in diesem Zeitraum`];
    if (fehler > 0) {
      teile.push(
        `${fehler} ${anlagenWort(fehler)} konnte${fehler === 1 ? '' : 'n'} nicht geladen werden`,
      );
    }
    satz = teile.join(' · ');
  }
  return { gesamt, mitDaten, ohneDaten, fehler, satz };
}

// ---------------------------------------------------------------------------
// Welt A · Messwerte
// ---------------------------------------------------------------------------

/** Was die Seite je Anlage geladen hat (`null` + `fehler` sind verschieden!). */
export interface PortfolioHistoryInput {
  siteId: string;
  name: string;
  /** Die Antwort — null, wenn (noch) keine vorliegt. */
  history: History | null;
  /** Der Abruf ist fehlgeschlagen (≠ „keine Daten"). */
  fehler?: boolean;
}

/** Eine Zeile der Messwerte-Tabelle. */
export interface MesswerteZeile {
  siteId: string;
  name: string;
  zustand: ZeilenZustand;
  /** Die vier Tabellen-Werte, in `PORTFOLIO_TABELLE_KEYS`-Reihenfolge. */
  werte: (number | null)[];
  /** Die PV-Erzeugung je Abschnitt — die Mini-Trend-Spalte (kann leer sein). */
  spark: (number | null)[];
  /** Der ehrliche Grund, wenn die Zeile keine Zahlen trägt. */
  hinweis: string | null;
}

/**
 * Die vier Summen der TABELLE. Laden/Entladen stehen bewusst nur in der
 * Portfolio-Summe darüber: eine Betreiber-Tabelle mit sechs Zahlenspalten liest
 * am Telefon niemand mehr — versteckt ist damit nichts.
 */
export const PORTFOLIO_TABELLE_KEYS: readonly EnergieSummeKey[] = [
  'erzeugt',
  'verbraucht',
  'bezogen',
  'eingespeist',
];

export interface PortfolioSumme {
  key: EnergieSummeKey;
  label: string;
  farbe: EnergieFarbe;
  hinweis: string;
  /** Σ über die Anlagen, die diesen Kanal getragen haben — sonst `null`. */
  kwh: number | null;
  /** Wie viele Anlagen zu dieser Summe beigetragen haben. */
  anlagen: number;
}

export interface MesswerteAggregat {
  summen: PortfolioSumme[];
  zeilen: MesswerteZeile[];
  abdeckung: PortfolioAbdeckung;
  /** Keine einzige Summe vorhanden → der ehrliche Leerzustand. */
  leer: boolean;
}

function zustandFor(input: PortfolioHistoryInput, hatWerte: boolean): ZeilenZustand {
  if (input.fehler) return 'fehler';
  return hatWerte ? 'daten' : 'leer';
}

/**
 * Die Portfolio-Summe der Messwerte plus die Anlagen-Tabelle darunter.
 *
 * Aggregiert wird über `energieSummen(buckets)` — DERSELBE Kern, den die
 * Anlagen-Welt benutzt, also können Portfolio und Anlage nie verschiedene
 * Zahlen erzählen. Eine Summe ist `null`, solange keine einzige Anlage diesen
 * Kanal getragen hat; eine gemessene 0 zählt als Wert.
 */
export function messwerteAggregat(
  inputs: readonly PortfolioHistoryInput[],
): MesswerteAggregat {
  const vorlage = energieSummen([]);
  const sums = vorlage.map((s) => ({ desc: s, sum: 0, anlagen: 0 }));
  const zeilen: MesswerteZeile[] = [];

  for (const input of inputs) {
    const summen: EnergieSumme[] = input.history ? energieSummen(input.history.buckets) : vorlage;
    let hatWerte = false;
    summen.forEach((s, i) => {
      if (s.kwh == null) return;
      hatWerte = true;
      sums[i].sum += s.kwh;
      sums[i].anlagen += 1;
    });
    const byKey = new Map(summen.map((s) => [s.key, s.kwh] as const));
    const zustand = zustandFor(input, hatWerte);
    zeilen.push({
      siteId: input.siteId,
      name: input.name,
      zustand,
      werte: PORTFOLIO_TABELLE_KEYS.map((k) => byKey.get(k) ?? null),
      spark: input.history ? input.history.buckets.map((b) => b.pvKwh) : [],
      hinweis:
        zustand === 'fehler'
          ? 'Konnte nicht geladen werden.'
          : zustand === 'leer'
            ? 'Keine Messwerte in diesem Zeitraum.'
            : null,
    });
  }

  const summen: PortfolioSumme[] = sums.map((s) => ({
    key: s.desc.key,
    label: s.desc.label,
    farbe: s.desc.farbe,
    hinweis: s.desc.hinweis,
    kwh: s.anlagen > 0 ? s.sum : null,
    anlagen: s.anlagen,
  }));

  return {
    summen,
    zeilen,
    abdeckung: abdeckung(zeilen.map((z) => z.zustand)),
    leer: summen.every((s) => s.kwh == null),
  };
}

// ---------------------------------------------------------------------------
// Welt B · Erlöse
// ---------------------------------------------------------------------------

/** Eine Zeile der Erlöse-Tabelle. */
export interface ErloeseZeile {
  siteId: string;
  name: string;
  zustand: ZeilenZustand;
  /** Ertrag der Anlage im Zeitraum (Einspeisung + Wert des Eigenverbrauchs). */
  ertragEur: number | null;
  /** Die ZURECHNUNG der Steuerung — steckt bereits im Ertrag. */
  savedEur: number | null;
  eingespeistKwh: number | null;
  /** Der Ertrag je Abschnitt — die Mini-Trend-Spalte. */
  spark: (number | null)[];
  hinweis: string | null;
}

export interface ErloeseAggregat {
  /** Σ Ertrag — per Konstruktion die Summe der beiden Teile darunter. */
  ertragEur: number | null;
  einspeiseEur: number | null;
  eigenverbrauchEur: number | null;
  /** Σ der Steuerungs-Zurechnung (nie ein weiterer Summand). */
  savedEur: number | null;
  /** Σ der bewerteten Viertelstunden — die Datenbasis in einer Zahl. */
  coveredSlots: number;
  zeilen: ErloeseZeile[];
  abdeckung: PortfolioAbdeckung;
  leer: boolean;
}

function summe(werte: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let any = false;
  for (const w of werte) {
    if (typeof w !== 'number' || !Number.isFinite(w)) continue;
    sum += w;
    any = true;
  }
  return any ? sum : null;
}

/** Der kurze Zeilen-Hinweis zu einem nicht berechenbaren Zeitraum. */
export function zeilenHinweis(reason: EarningsReason | null): string {
  switch (reason) {
    case 'missing_channels':
      return 'Gerät liefert nicht alle benötigten Messwerte.';
    case 'no_prices':
      return 'Noch keine Börsenpreise für den Zeitraum.';
    default:
      return 'Keine Messwerte in diesem Zeitraum.';
  }
}

/**
 * Die Portfolio-Summe des Geldes plus die Anlagen-Tabelle darunter.
 *
 * **Die große Zahl ist per Konstruktion die Summe der zwei gezeigten Teile**
 * (Einspeise-Erlös + Wert des Eigenverbrauchs) — genau die Regel der
 * Anlagen-Welt, eine Ebene höher. `savedEur` ist die ZURECHNUNG der Steuerung
 * und steckt bereits darin (MIG §5); die vermiedenen Leistungskosten gehören
 * einer anderen Periode und tauchen hier bewusst gar nicht auf.
 *
 * Die Reihenfolge der Zeilen folgt dem Ertrag (die größte Anlage zuerst);
 * Anlagen ohne Zahlen stehen am Ende, mit ihrem Grund.
 */
export function erloeseAggregat(
  sites: readonly EarningsSite[],
  /** Alle Anlagen des Mandanten — auch die, die der Endpunkt nicht nennt. */
  alle?: readonly { id: string; name: string }[],
): ErloeseAggregat {
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const liste: { id: string; name: string }[] =
    alle && alle.length > 0
      ? alle.map((s) => ({ id: s.id, name: byId.get(s.id)?.name ?? s.name }))
      : sites.map((s) => ({ id: s.id, name: s.name }));

  const zeilen: ErloeseZeile[] = liste.map((s) => {
    const money = byId.get(s.id) ?? null;
    const ertragEur = money?.gesamtertragEur ?? null;
    const zustand: ZeilenZustand = ertragEur == null ? 'leer' : 'daten';
    return {
      siteId: s.id,
      name: s.name,
      zustand,
      ertragEur,
      savedEur: money?.savedEur ?? null,
      eingespeistKwh: money?.eingespeistKwh ?? null,
      spark: money ? money.series.map((p) => p.gesamtertragEur) : [],
      hinweis: zustand === 'daten' ? null : zeilenHinweis(money?.reason ?? null),
    };
  });

  zeilen.sort((a, b) => {
    if (a.zustand !== b.zustand) return a.zustand === 'daten' ? -1 : 1;
    if (a.ertragEur != null && b.ertragEur != null) return b.ertragEur - a.ertragEur;
    return a.name.localeCompare(b.name, 'de');
  });

  const beitragende = zeilen
    .map((z) => byId.get(z.siteId))
    .filter((m): m is EarningsSite => m != null);
  const einspeiseEur = summe(beitragende.map((m) => m.einspeiseErloesEur));
  const eigenverbrauchEur = summe(beitragende.map((m) => m.eigenverbrauchsWertEur));
  const ertragEur =
    einspeiseEur == null && eigenverbrauchEur == null
      ? null
      : (einspeiseEur ?? 0) + (eigenverbrauchEur ?? 0);

  return {
    ertragEur,
    einspeiseEur,
    eigenverbrauchEur,
    savedEur: summe(beitragende.map((m) => m.savedEur)),
    coveredSlots: beitragende.reduce((n, m) => n + (m.coveredSlots ?? 0), 0),
    zeilen,
    abdeckung: abdeckung(zeilen.map((z) => z.zustand)),
    leer: ertragEur == null,
  };
}
