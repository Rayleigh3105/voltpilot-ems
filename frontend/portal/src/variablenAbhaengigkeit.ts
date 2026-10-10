/**
 * Die Abhängigkeits-Regel zweier Variablen (UEMS AP-17 G4, V5) — TS-Zwilling von
 * `services/api/.../uems/VariablenAbhaengigkeit.java`. Pearson-r über die
 * Monatspaare der Referenzperiode; ab |r| ≥ 0,9 (Startwert, G6) hängen sie
 * aneinander. Vertrag: `docs/contracts/v2/variablen-vorschlag-vectors.json`.
 *
 * Die Entscheidung an der Schwelle trifft `abhaengigkeit` aus `bezugsbasis.ts`
 * (IP-2, exakt als Sxy² ≥ 0,81·Sxx·Syy) — eine Wahrheit für Vorschlag und
 * Übernahme. Hier stehen nur die Paare, die Gründe ohne Zahl und r für den Hinweis.
 *
 * Der Variablen-Vorschlag (`GET /api/v1/kennzahlen/{id}/variablen-vorschlag`)
 * zeigt das Ergebnis als Hinweis; abgelehnt wird erst beim Übernehmen in eine
 * Fassung (IP-11b).
 */

import { STARTWERTE, abhaengigkeit } from './bezugsbasis';

export const SCHWELLE = Number(STARTWERTE.abhaengig_r);
/** Unter drei Monatspaaren ist r keine Aussage (zwei Punkte liegen immer auf einer Geraden). */
export const MINDEST_PAARE = 3;

export const ERGEBNISSE = ['unabhaengig', 'variablen_abhaengig', 'nicht_pruefbar'] as const;
export type AbhaengigkeitErgebnis = (typeof ERGEBNISSE)[number];
export const GRUENDE = ['zu_wenig_paare', 'keine_streuung', 'keine_variable_1'] as const;
export type AbhaengigkeitGrund = (typeof GRUENDE)[number];

export const OHNE_ZAHL = 'ohne Zahl — erst als Bezugsgröße erfassen';

/** Ein Monat, in dem beide Variablen einen Wert haben. */
export interface Paar {
  x: number;
  y: number;
}

export interface Abhaengigkeit {
  ergebnis: AbhaengigkeitErgebnis;
  r: number | null;
  paare: number;
  grund: AbhaengigkeitGrund | null;
}

/** Pearson-r für die Anzeige (ungerundet); `null`, wenn eine der beiden Reihen konstant ist. Dieselbe Rechnung wie in Java. */
export function pearson(paare: readonly Paar[]): number | null {
  const n = paare.length;
  let mx = 0;
  let my = 0;
  for (const p of paare) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of paare) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function pruefeAbhaengigkeit(paare: readonly Paar[]): Abhaengigkeit {
  const n = paare.length;
  if (n < MINDEST_PAARE) return { ergebnis: 'nicht_pruefbar', r: null, paare: n, grund: 'zu_wenig_paare' };
  const r = pearson(paare);
  if (r === null) return { ergebnis: 'nicht_pruefbar', r: null, paare: n, grund: 'keine_streuung' };
  const { abhaengig } = abhaengigkeit(
    paare.map((p) => String(p.x)),
    paare.map((p) => String(p.y)),
  );
  return { ergebnis: abhaengig ? 'variablen_abhaengig' : 'unabhaengig', r, paare: n, grund: null };
}

/** r im Kundensatz: drei Stellen, Komma, echtes Minus („0,997“, „−0,950“). */
export function rText(r: number): string {
  const betrag = (Math.round(Math.abs(r) * 1000) / 1000).toFixed(3).replace('.', ',');
  return (r < 0 && betrag !== '0,000' ? '−' : '') + betrag;
}

/** Der Hinweis an einem abhängigen Kandidaten (Vorschlag, noch keine Ablehnung). */
export function abhaengigSatz(kandidat: string, variable1: string, r: number): string {
  return `${kandidat} hängt an ${variable1} (r = ${rText(r)}). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.`;
}
