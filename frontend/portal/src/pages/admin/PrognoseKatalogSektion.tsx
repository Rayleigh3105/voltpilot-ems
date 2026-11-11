import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Card } from '../../../designsystem/components/core/Card';
import { VpPicker } from '../../components/VpPicker';
import { ApiError, type ForecastModelId } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { ErrorState, TextSkeleton } from '../../components/States';
import { KIND_LABELS } from '../../prognose';

const MODEL_LABELS: Record<ForecastModelId, string> = {
  'load-persistence': 'Vergleichsmodell (Vortageswert)',
  'pv-physical': 'Physikalisches PV-Modell (Sonnenstand & Wetter)',
  'load-xgb': 'Lernendes Verbrauchsmodell',
  'pv-residual-xgb': 'Lernende PV-Korrektur',
  'pv-physical-legacy-dni': 'Physikalisches PV-Modell (alte Lesart, nur Vergleich)',
};

/**
 * Katalog › Prognosemodelle (N8, Konzept `vp-adminview-konzept-k1` §9): die
 * PLATTFORM-VORGABE des Prognosemodells je Prognoseart hatte Server
 * (`AdminForecastModelController`) und Portal-Funktion
 * (`adminApi.forecastModels`/`promoteForecastModel`), aber keine Fläche -
 * diese Sektion ist sie, ohne neuen Endpunkt. Die Wahl EINER Anlage bleibt
 * ihre eigene Seite (`api.siteForecastModels`, `PrognosePage.tsx`); hier
 * steht nur die Vorgabe für jede Anlage OHNE eigene Wahl.
 */
export function PrognoseKatalogSektion(): JSX.Element {
  const [zustand, setZustand] = useState<{
    kinds: { kind: 'load' | 'pv'; activeModel: ForecastModelId; source: 'portal' | 'env'; selectable: ForecastModelId[] }[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    adminApi.forecastModels().then(
      (z) => { if (active) setZustand(z); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [reloadKey]);

  async function waehlen(kind: 'load' | 'pv', model: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await adminApi.promoteForecastModel(kind, model);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Die Vorgabe ließ sich nicht setzen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vp-admin-sec" id="sektion-prognose">
      <h2 className="vp-admin-sec-head">Prognosemodelle</h2>
      <p className="vp-cert-summary">
        Die Vorgabe je Prognoseart für jede Anlage ohne eigene Wahl - eine Anlage mit eigener Wahl
        bleibt davon unberührt (Vorrang Anlage &gt; Plattform &gt; ausgeliefertes Modell).
      </p>

      {error && <div className="vp-alert-warn vp-cert-error">{error}</div>}

      {failed && (
        <ErrorState message="Die Prognosemodelle konnten nicht geladen werden." onRetry={() => setReloadKey((k) => k + 1)} />
      )}
      {!failed && !zustand && <TextSkeleton lines={3} />}

      {!failed && zustand && (
        <Card radius="lg" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Am Telefon: Prognoseart und Herkunft oben, darunter die Auswahl (sie nennt die Vorgabe selbst). */}
          <table className="vp-table responsive vp-zeilen vp-prognose-tabelle">
            <thead>
              <tr>
                <th>Prognoseart</th>
                <th>Vorgabe</th>
                <th>Herkunft</th>
                <th>Ändern</th>
              </tr>
            </thead>
            <tbody>
              {zustand.kinds.map((k) => (
                <tr key={k.kind}>
                  <td data-label="Prognoseart" data-zeile="haupt"><b>{KIND_LABELS[k.kind]}</b></td>
                  <td data-label="Vorgabe" data-zeile="breit">{MODEL_LABELS[k.activeModel] ?? k.activeModel}</td>
                  <td data-label="Herkunft" data-zeile="neben">
                    <Badge variant={k.source === 'portal' ? 'tint' : 'off'}>
                      {k.source === 'portal' ? 'Im Portal gesetzt' : 'Ausgeliefertes Modell'}
                    </Badge>
                  </td>
                  <td data-label="Ändern" data-zeile="fuss">
                    <VpPicker
                      id={`prognose-vorgabe-${k.kind}`}
                      ariaLabel={`Vorgabe ${KIND_LABELS[k.kind]}`}
                      options={k.selectable.map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m }))}
                      value={k.activeModel}
                      disabled={busy}
                      onChange={(v) => void waehlen(k.kind, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
