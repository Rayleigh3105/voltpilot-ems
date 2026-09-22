import { request } from './api';

/**
 * AP-16 IP-17 (G5, E10 = A): der Monatsvergleich einer Messstelle mit ihren Vergleichsquellen
 * (`GET /api/v1/messstellen/{kennzeichen}/vergleich`, `bewertung.md` §13). Hier stehen nur Typen,
 * Abruf und die Sätze der Befund-Zeile — gerechnet wird in der Cloud (Regel `monatsvergleich`,
 * Zwilling in `uemsBewertung.ts`). Der Satz nennt Abweichung und Toleranz, NIE eine Ursache.
 */
export type MonatsvergleichGrund =
  | 'vergleich_nicht_ganzer_monat'
  | 'fuehrend_luecke'
  | 'vergleich_luecke'
  | 'fuehrend_ersatzwert'
  | 'vergleich_ersatzwert'
  | 'fuehrend_nicht_positiv';

export interface VergleichMonat {
  monat: string;
  fuehrend: string | null;
  vergleich: string | null;
  zustand: 'passt' | 'abweichung' | 'nicht_vergleichbar';
  grund: MonatsvergleichGrund | null;
  abweichung_prozent: string | null;
  toleranz_prozent: string;
  toleranz_fassung: number;
  befund: boolean | null;
}

export interface VergleichQuelle {
  quelle_id: string;
  komponente: string | null;
  kanal: string;
  zweck: string;
  monatsvergleich: 'ja' | 'ohne_monatsmenge';
  monate: VergleichMonat[];
}

export interface MessstelleVergleich {
  kennzeichen: string;
  von: string;
  bis: string;
  vergleichsquellen: VergleichQuelle[];
  befunde: { art: 'abweichung_vergleichsquelle'; quelle_id: string; monat: string }[];
}

export const messstelleVergleich = (kennzeichen: string) =>
  request<MessstelleVergleich>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/vergleich`);

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September',
  'Oktober', 'November', 'Dezember'];

const GRUND: Record<MonatsvergleichGrund, string> = {
  vergleich_nicht_ganzer_monat: 'die Vergleichsquelle gilt nicht den ganzen Monat',
  fuehrend_luecke: 'der Monat ist nicht vollständig gemessen',
  vergleich_luecke: 'die Vergleichsquelle ist nicht vollständig gemessen',
  fuehrend_ersatzwert: 'der Monat enthält Ersatzwerte',
  vergleich_ersatzwert: 'die Vergleichsquelle enthält Ersatzwerte',
  fuehrend_nicht_positiv: 'kein Verbrauch im Monat',
};

/** „2026-12“ → „Dezember 2026“. */
export function monatWort(monat: string): string {
  const [jahr, m] = monat.split('-');
  return `${MONATE[Number(m) - 1]} ${jahr}`;
}

/** „1.1“ → „1,1 %“; „2“ → „2 %“. */
export function prozentWort(p: string): string {
  return `${p.replace('.', ',')} %`;
}

export interface BefundZeile {
  schluessel: string;
  zustand: VergleichMonat['zustand'];
  satz: string;
}

/**
 * Je Vergleichsquelle mit Monatsvergleich eine Zeile für den letzten Monat der Antwort (R9: „Vergleich
 * Dezember 2026: 1,1 % Abweichung zur Netzleistung am Wechselrichter (Toleranz 2 %) — passt“). Eine
 * Vergleichsquelle ohne Monatsmenge und eine ohne Monat im Zeitraum bekommen keine Zeile.
 */
export function befundZeilen(v: MessstelleVergleich): BefundZeile[] {
  return v.vergleichsquellen.flatMap((q) => {
    const m = q.monate[q.monate.length - 1];
    if (q.monatsvergleich !== 'ja' || !m) return [];
    const name = q.komponente ?? q.kanal;
    const toleranz = `Toleranz ${prozentWort(m.toleranz_prozent)}`;
    const satz = m.zustand === 'passt'
      ? `Vergleich ${monatWort(m.monat)}: ${prozentWort(m.abweichung_prozent!)} Abweichung zur ${name} (${toleranz}) — passt`
      : m.zustand === 'abweichung'
        ? `Abweichung zur Vergleichsquelle ${name} im ${monatWort(m.monat)}: ${prozentWort(m.abweichung_prozent!)} (${toleranz}) — bitte prüfen`
        : `Vergleich ${monatWort(m.monat)} mit ${name}: nicht vergleichbar — ${GRUND[m.grund!]}`;
    return [{ schluessel: q.quelle_id, zustand: m.zustand, satz }];
  });
}
