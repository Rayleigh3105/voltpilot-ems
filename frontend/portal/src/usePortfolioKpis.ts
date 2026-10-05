/**
 * Der eine Abruf des UEMS-Übersichts-Kachelrasters (`GET /api/v1/portfolio/kpis`):
 * Leitkennzahl, Verbrauch vs. Vorjahr, Lastspitze und Kosten, aggregiert über die
 * Anlagen. Eine dünne React-Anbindung ohne Cache - das Raster steht einmal oben
 * auf der Seite, nicht in einem Blätter-Fluss (anders als `useSiteEarnings`).
 *
 * Lade-/Fehlerzustand bleiben ehrlich (Konzept §5.3): `laedt` trägt das Skelett,
 * `fehler` die nüchterne Hinweiskarte mit „Erneut versuchen"; `kpis` bleibt null,
 * solange nichts Gültiges da ist (nie ein halber Stand).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PortfolioKpi } from './api';

export interface PortfolioKpisState {
  kpis: PortfolioKpi | null;
  laedt: boolean;
  fehler: string | null;
  erneut: () => void;
}

export function usePortfolioKpis(enabled = true): PortfolioKpisState {
  const [kpis, setKpis] = useState<PortfolioKpi | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [erneutZaehler, setErneutZaehler] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let aktiv = true;
    setLaedt(true);
    setFehler(null);
    api
      .portfolioKpis()
      .then((d) => {
        if (aktiv) setKpis(d);
      })
      .catch((e) => {
        if (aktiv) setFehler(e instanceof ApiError ? e.message : 'Fehler');
      })
      .finally(() => {
        if (aktiv) setLaedt(false);
      });
    return () => {
      aktiv = false;
    };
  }, [enabled, erneutZaehler]);

  const erneut = useCallback(() => setErneutZaehler((k) => k + 1), []);
  return { kpis, laedt, fehler, erneut };
}
