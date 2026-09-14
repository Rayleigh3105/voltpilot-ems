import { NBSP } from './format';
import { quoteSatz, quoteUnplausibel, quoteZahl } from './quoteUnplausibel';
import type { DeltaView } from './historieVergleich';
import { delta } from './historieVergleich';
import { ENERGIE_WERTUNG } from './historieVergleich';
import type { EnergieBilanz, EnergieSumme, EnergieSummeKey } from './energieBilanz';

/**
 * **Die Ledger-Zeilen des Reiters „Messwerte"** (Konzept
 * `vp-verlauf-sprache-konzept-v5` §3.2 V5, §4.1 Karte 2; Paket P3).
 *
 * Sie ist die REINE Hälfte der Karte „Energie im Zeitraum": aus der schon
 * vorhandenen `energieBilanz` plus der Vorperiode entstehen sechs Zeilen in der
 * Form `Name · Wert · Balken · Δ` und darunter zwei Quoten-Zeilen. **Hier
 * entsteht keine neue Zahl** — jede kommt aus `energieBilanz`, jedes Δ aus
 * `historieVergleich.delta`; P3 ändert die FORM, nicht die Aussage.
 *
 * ⚠ **EINE Speicher-Farbe.** Erzeugt/Verbraucht tragen `--vp-c-primary`,
 *   Bezogen/Eingespeist `--vp-c-secondary`, Geladen/Entladen die Tinte
 *   `--vp-c-fg` (Konzept §4.1). Die sechs Kanal-Hues des Diagramms
 *   (`EnergieFarbe`) gelten dem BILD — ein Balken in der Ledger-Zeile ist eine
 *   Grössen-Anzeige, keine zweite Reihen-Kennung, und sechs Hues in einer Liste
 *   waren der gemessene Befund B2 der Erlöse-Runde.
 *
 * ⚠ **Der Balken misst gegen die GRÖSSTE Zeile, nie gegen die eigene.** Nur so
 *   sind die sechs Zeilen untereinander vergleichbar; eine je Zeile normierte
 *   Länge wäre sechsmal 100 %.
 *
 * ⚠ **`null` ist kein 0.** Eine Anlage ohne Netzzähler trägt bei
 *   Bezogen/Eingespeist gar keinen Kanal — die Zeile zeigt „—" und NENNT den
 *   Grund in ihrer Sekundärzeile (Hausstandard, Konzept §4.1 Sonderzustände).
 */

/** Die Balkenfarbe je Gruppe — drei, nicht sechs. */
const FARBE: Record<EnergieSummeKey, string> = {
  erzeugt: 'var(--vp-c-primary, #2563eb)',
  verbraucht: 'var(--vp-c-primary, #2563eb)',
  bezogen: 'var(--vp-c-secondary, #3b82f6)',
  eingespeist: 'var(--vp-c-secondary, #3b82f6)',
  geladen: 'var(--vp-c-fg, #1e293b)',
  entladen: 'var(--vp-c-fg, #1e293b)',
};

/**
 * Warum eine Zeile gar keinen Wert trägt. Er hängt am KANAL, nicht an einer
 * Vermutung über die Anlage: fehlt der Netz-Kanal, fehlt der Netzzähler.
 */
const GRUND: Partial<Record<EnergieSummeKey, string>> = {
  bezogen: 'ohne Netzzähler nicht messbar',
  eingespeist: 'ohne Netzzähler nicht messbar',
  geladen: 'ohne Speicher nicht messbar',
  entladen: 'ohne Speicher nicht messbar',
  erzeugt: 'in diesem Zeitraum nicht gemessen',
  verbraucht: 'in diesem Zeitraum nicht gemessen',
};

export interface MesswerteZeile {
  key: EnergieSummeKey;
  name: string;
  /** Der fertige Wert samt Einheit — `null` = nicht messbar (die Fläche zeigt „—"). */
  wert: string | null;
  /** Der Grund, wenn `wert` fehlt; sonst leer. */
  grund: string | null;
  /** Anteil an der grössten Zeile, 0..1 — `null` = kein Balken. */
  anteil: number | null;
  /** Die Balkenfarbe (Token-Ausdruck). */
  farbe: string;
  /** Das Δ zur Vorperiode — `null`, wo es keinen ehrlichen Vergleich gibt. */
  delta: DeltaView | null;
  /** Der erklärende Satz (Titel/Tooltip) — unverändert aus `energieBilanz`. */
  hinweis: string;
}

export interface MesswerteQuote {
  key: 'autarkie' | 'eigenverbrauch';
  name: string;
  /** Die Zahl als Text (ungeklemmt), oder `null` = nicht berechenbar. */
  wert: string | null;
  /**
   * Der eine erklärende Satz unter der Zahl — bei einer Quote außerhalb 0…100 %
   * statt der Erklärung „Messwerte passen nicht zusammen (…)" (AP-10 E16 Nr. 5).
   */
  satz: string;
  /** Die Quote liegt außerhalb 0…100 %. */
  unplausibel: boolean;
}

/** de-DE mit geschütztem Leerzeichen vor der Einheit — die Hausform. */
function kwh(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}kWh`;
}

function pct(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return `${Math.round(v)}${NBSP}%`;
}

/**
 * Die sechs Zeilen der Karte „Energie im Zeitraum".
 *
 * `vorherSummen` ist dieselbe Liste der Vorperiode (gleiche Reihenfolge) —
 * `null`, solange sie nicht geladen ist; dann trägt keine Zeile ein Δ.
 */
export function messwerteZeilen(
  summen: readonly EnergieSumme[],
  vorherSummen: readonly EnergieSumme[] | null,
  vergleichName: string,
): MesswerteZeile[] {
  const werte = summen.map((s) => s.kwh).filter((v): v is number => v != null && Number.isFinite(v));
  const max = werte.length > 0 ? Math.max(...werte, 0) : 0;
  return summen.map((s, i) => {
    const wert = kwh(s.kwh);
    return {
      key: s.key,
      name: s.label,
      wert,
      grund: wert == null ? (GRUND[s.key] ?? 'nicht gemessen') : null,
      // Ein Balken ohne Skala sagt nichts: ohne einen positiven Grösstwert
      // bleibt die Spur leer, statt jede Zeile auf 0 oder 100 % zu setzen.
      anteil: s.kwh != null && max > 0 ? Math.max(0, Math.min(1, s.kwh / max)) : null,
      farbe: FARBE[s.key],
      delta: vorherSummen
        ? delta(s.kwh, vorherSummen[i]?.kwh, ENERGIE_WERTUNG[s.key], vergleichName)
        : null,
      hinweis: s.hinweis,
    };
  });
}

/**
 * Die zwei Quoten als eigene Zeilen mit grosser Zahl (§4.1: „Autarkie/
 * Eigenverbrauch als zwei Zeilen mit `--vp-c-fs-24`-Zahl").
 *
 * Der Satz darunter ist die frühere InfoTip-Erklärung im Fliesstext — sie
 * verschwindet nicht, sie steht nur ohne Klick da.
 */
export function messwerteQuoten(bilanz: EnergieBilanz): MesswerteQuote[] {
  return [
    quote(
      'autarkie',
      'Autarkie',
      bilanz.autarkiePct,
      bilanz.autarkieUnplausibel,
      'Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben — der Rest kam aus dem Netz.',
    ),
    quote(
      'eigenverbrauch',
      'Eigenverbrauch',
      bilanz.eigenverbrauchPct,
      bilanz.eigenverbrauchUnplausibel,
      'Anteil Ihrer Erzeugung, den Sie selbst genutzt statt eingespeist haben.',
    ),
  ];
}

/**
 * Eine Quoten-Zeile. Außerhalb 0…100 % wird die Zahl NICHT in den Bereich
 * gebogen (AP-10 E16 Nr. 5): sie steht ungeklemmt, und statt der Erklärung, die
 * einen echten Anteil voraussetzt, steht der Satz aus dem Bilanz-Vertrag.
 */
function quote(
  key: MesswerteQuote['key'],
  name: string,
  wert: number | null,
  flag: boolean | null | undefined,
  satz: string,
): MesswerteQuote {
  if (wert != null && Number.isFinite(wert) && quoteUnplausibel(wert, flag)) {
    return { key, name, wert: quoteZahl(wert), satz: quoteSatz(wert), unplausibel: true };
  }
  return { key, name, wert: pct(wert), satz, unplausibel: false };
}
