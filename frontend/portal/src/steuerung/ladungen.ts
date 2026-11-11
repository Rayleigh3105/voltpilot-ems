/**
 * „Ladungen" auf dem Reiter Laden (Konzept „Ein Ort fürs Laden" e1, §4.1
 * Punkt 5 / §4.4, Scheibe 2): Menge, anteiliger Sonnenanteil und Euro kommen
 * vom Server (`GET .../ocpp/transactions/economics`), auf DERSELBEN
 * Preisgrundlage wie die Erlöse - diese Schicht filtert nur nach Ladepunkt
 * und formt die CSV „für die Abrechnung". Keine eigene Preisrechnung hier.
 */
import type { OcppTransactionEconomics } from '../api';

export interface LadungZeile {
  key: string;
  /** Wann die Ladung begann (ISO) - die Fläche formatiert, diese Schicht nicht. */
  startedAt: string;
  /** `null` = Menge nicht bestimmbar (fehlender/unplausibler Zählerstand), nie 0 geraten. */
  kwh: number | null;
  /** Ein ANTEILIGER SCHLUSS aus der Hausbilanz, nie eine Messung der Wallbox selbst. */
  sonnenanteilPct: number | null;
  /** `null`, solange eine Zutat (Menge, Preis, Hausbilanz) fehlt - nie eine erfundene Zahl. */
  euro: number | null;
  durchschnittCtKwh: number | null;
  /** Das Karten-Pseudonym der Box - nie der OCPP-Bezug der Cloud. */
  kartenRef: string | null;
}

function zeile(t: OcppTransactionEconomics): LadungZeile {
  return {
    key: `${t.chargePointId}-${t.transactionId}`,
    startedAt: t.startedAt,
    kwh: t.kwh,
    sonnenanteilPct: t.sonnenanteilPct,
    euro: t.euro,
    durchschnittCtKwh: t.durchschnittCtKwh,
    kartenRef: t.kartenRef,
  };
}

/**
 * Die Ladungen EINES Ladepunkts aus der site-weiten Antwort (der Server
 * liefert sie schon neueste zuerst, wie `/ocpp/transactions`) - optional auf
 * die ersten `n` begrenzt.
 */
export function ladungenZeilen(
  all: readonly OcppTransactionEconomics[] | null | undefined,
  chargePointId: string,
  n?: number,
): LadungZeile[] {
  const gefiltert = (all ?? []).filter((t) => t.chargePointId === chargePointId).map(zeile);
  return n != null ? gefiltert.slice(0, n) : gefiltert;
}

export interface LadungenSumme {
  /** Summe der bekannten Mengen - `null`, wo keine Zeile eine Menge kennt. */
  kwh: number | null;
  /** kWh-gewichteter Schnitt, nur aus Zeilen mit bekannter Menge UND bekanntem Anteil. */
  sonnenanteilPct: number | null;
  euro: number | null;
  /** `Euro ÷ kWh` der Summen - keine eigene zweite Rechnung. */
  durchschnittCtKwh: number | null;
}

/**
 * Die drei Zahlen über „Ladungen" (§4.1 Punkt 5): Menge, Sonnenanteil und
 * Euro-Betrag EINES Monats, aus den schon vom Server gelieferten Zeilen -
 * keine eigene Preis- oder Anteilsrechnung, nur ihre Summe.
 */
export function ladungenSumme(zeilen: readonly LadungZeile[]): LadungenSumme {
  let kwhSumme = 0;
  let kwhN = 0;
  let sonneKwh = 0;
  let sonneN = 0;
  let euroSumme = 0;
  let euroN = 0;
  for (const z of zeilen) {
    if (z.kwh != null) {
      kwhSumme += z.kwh;
      kwhN++;
      if (z.sonnenanteilPct != null) {
        sonneKwh += z.kwh * (z.sonnenanteilPct / 100);
        sonneN++;
      }
    }
    if (z.euro != null) {
      euroSumme += z.euro;
      euroN++;
    }
  }
  const kwh = kwhN > 0 ? kwhSumme : null;
  const sonnenanteilPct = sonneN > 0 && kwhSumme > 0 ? (sonneKwh / kwhSumme) * 100 : null;
  const euro = euroN > 0 ? euroSumme : null;
  const durchschnittCtKwh = kwh != null && kwh > 0 && euro != null ? (euro / kwh) * 100 : null;
  return { kwh, sonnenanteilPct, euro, durchschnittCtKwh };
}

const CSV_KOPF = ['Beginn', 'kWh', 'Sonnenanteil %', 'Euro', 'Durchschnitt ct/kWh', 'Karte'];

/** Ein CSV-Feld ohne Trennzeichen-Verwechslung - in Anführungszeichen, falls es ein Komma oder Anführungszeichen trägt. */
function csvFeld(wert: string | number | null): string {
  const text = wert == null ? '' : String(wert);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV „für die Abrechnung" (§4.4) - UNGERUNDET mit Dezimalpunkt und
 * ISO-Zeit (Haus-Disziplin für CSV-Export, wie bei den UEMS-Berichten), ohne
 * jede Aussage über steuerliche oder messrechtliche Eignung.
 */
export function ladungenCsv(zeilen: readonly LadungZeile[]): string {
  const rows = zeilen.map((z) => [
    z.startedAt, z.kwh, z.sonnenanteilPct, z.euro, z.durchschnittCtKwh, z.kartenRef,
  ].map(csvFeld).join(','));
  return [CSV_KOPF.join(','), ...rows].join('\n');
}
