import { useCallback, useEffect, useState } from 'react';
import { api, type EntityHistory } from '../api';
import { heuteAblesung, heuteView, type HeuteKanal } from '../geraetHeute';
import { LIST_POLL_MS } from '../pollCadence';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { MiniBarSpark, type MiniMark } from './MiniChart';
import './GeraetHeute.css';

/**
 * Der Baustein „Heute" (Konzept „Geräteseiten: Ein Blick, eine Antwort",
 * Baustein 4 · E2 a): der Tagesverlauf der Hauptgröße, als Streifen des
 * Mini-Chart-Systems mit echter Nulllinie, Zeitachse und Ablese-Tipp.
 *
 * <p>Er lädt EINEN bestehenden Abruf (`entities/{id}/history?range=day`) und
 * frischt ihn im Listen-Takt auf - die Viertelstunden ändern sich nicht
 * sekündlich. Fällt er aus, fällt die Karte still weg (fail-soft wie jeder
 * Neben-Abruf der Seite), statt eine leere Fläche zu behaupten.
 *
 * <p>Die Ableitung (Reihe, Extreme, Satz) ist die reine `geraetHeute.ts`.
 */
export function GeraetHeute({
  siteId,
  kanal,
  onAusfall,
}: {
  siteId: string;
  kanal: HeuteKanal;
  /**
   * Meldet, ob der Abruf AUSGEFALLEN ist - der Wirt nimmt die Karte dann weg.
   * Ein leerer Tag ist dagegen eine Auskunft und bleibt stehen.
   */
  onAusfall?: (ausgefallen: boolean) => void;
}) {
  const [history, setHistory] = useState<EntityHistory | null>(null);
  const [fehler, setFehler] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const laden = useCallback((signal?: { aktiv: boolean }) => {
    api.entityHistory(siteId, kanal.entityId, 'day').then(
      (h) => {
        if (signal && !signal.aktiv) return;
        setHistory(h);
        setFehler(false);
        setNow(Date.now());
      },
      () => {
        if (signal && !signal.aktiv) return;
        setFehler(true);
      },
    );
  }, [siteId, kanal.entityId]);

  useEffect(() => {
    const signal = { aktiv: true };
    setHistory(null);
    setFehler(false);
    laden(signal);
    return () => { signal.aktiv = false; };
  }, [laden]);

  useFreshnessPoll(() => laden(), LIST_POLL_MS);

  const view = history ? heuteView(history, kanal, now) : null;
  const ausgefallen = fehler && !history;

  useEffect(() => {
    onAusfall?.(ausgefallen);
  }, [ausgefallen, onAusfall]);

  if (!view) {
    return fehler ? null : <div className="vp-heute-platz" aria-hidden="true" />;
  }
  if (view.leer) {
    return <p className="vp-heute-leer">Heute noch keine Messwerte.</p>;
  }
  const marken: MiniMark[] = view.jetztKey ? [{ key: view.jetztKey, label: 'jetzt' }] : [];
  return (
    <div className={`vp-heute is-${kanal.farbe}`} data-testid="geraet-heute">
      <MiniBarSpark
        points={view.punkte}
        size="streifen"
        ariaLabel={`Tagesverlauf ${kanal.titel}${view.satz ? `: ${view.satz}` : ''}`}
        readout={(p) => heuteAblesung(p, kanal)}
        caption={view.satz}
        marks={marken}
      />
      <div className="vp-heute-achse" aria-hidden="true">
        {view.achse.map((t) => (
          <span
            key={t.label}
            className={t.anteil === 0 ? 'is-anfang' : t.anteil === 1 ? 'is-ende' : undefined}
            style={{ left: `${(t.anteil * 100).toFixed(2)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      {kanal.richtung && (
        <p className="vp-heute-legende">
          {kanal.richtung === 'netz'
            ? 'Über der Linie Bezug, darunter Einspeisung.'
            : 'Über der Linie laden, darunter abgeben.'}
        </p>
      )}
    </div>
  );
}
