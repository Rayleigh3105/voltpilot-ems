import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import {
  api,
  ApiError,
  type ForecastAccuracyPoint,
  type ForecastModelId,
  type ForecastModelState,
  type ForecastQuality,
  type Site,
} from '../api';
import { NBSP } from '../format';
import { SitePicker } from '../components/SitePicker';
import { ForecastQualityChart } from '../ForecastQualityChart';

/**
 * Prognosequalität: the transparency page of shadow-mode forecasting
 * (Nachvollziehbarkeit). Plain German, no data-science vocabulary: which
 * model is LIVE for Verbrauch/PV, how accurate it was, what the learning
 * candidates are doing (honest "sammelt Daten" while gated), and the proof
 * that a candidate influences NOTHING until it is deliberately promoted.
 */

const MODEL_LABELS: Record<ForecastModelId, string> = {
  'load-persistence': 'Vergleichsmodell (Vortageswert)',
  'pv-physical': 'Physikalisches PV-Modell (Sonnenstand & Wetter)',
  'load-xgb': 'Lernendes Verbrauchsmodell',
  'pv-residual-xgb': 'Lernende PV-Korrektur',
};

const KIND_LABELS: Record<'load' | 'pv', string> = {
  load: 'Verbrauch (Last)',
  pv: 'PV-Erzeugung',
};

function modelLabel(model: ForecastModelId): string {
  return MODEL_LABELS[model] ?? model;
}

function kw(v: number | null | undefined, digits = 2): string {
  return v == null
    ? '-'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits })}${NBSP}kW`;
}

/** Mean MAE of one model over its most recent `days` evaluated days. */
function recentMae(
  accuracy: ForecastAccuracyPoint[],
  model: ForecastModelId,
  days = 7,
): { mae: number; days: number } | null {
  const mine = accuracy
    .filter((a) => a.model === model)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, days);
  if (mine.length === 0) return null;
  return {
    mae: mine.reduce((s, a) => s + a.maeKw, 0) / mine.length,
    days: mine.length,
  };
}

/** "In X von Y Tagen genauer" - days the challenger beat the baseline. */
function skillRecord(
  accuracy: ForecastAccuracyPoint[],
  model: ForecastModelId,
  days = 10,
): { better: number; total: number } | null {
  const judged = accuracy
    .filter((a) => a.model === model && a.skillVsBaseline != null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, days);
  if (judged.length === 0) return null;
  return {
    better: judged.filter((a) => (a.skillVsBaseline ?? 0) > 0).length,
    total: judged.length,
  };
}

export function PrognosePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const [quality, setQuality] = useState<ForecastQuality | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!site) {
      setQuality(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .forecastQuality(site.id)
      .then((q) => active && setQuality(q))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [site?.id]);

  const challengers = useMemo(
    () => (quality?.models ?? []).filter((m) => !m.active),
    [quality],
  );
  const activeByKind = useMemo(() => {
    if (!quality) return {} as Record<'load' | 'pv', ForecastModelId>;
    return { load: quality.activeLoadModel, pv: quality.activePvModel };
  }, [quality]);

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Prognosequalität</h1>
          <p>
            Welches Prognosemodell Ihre Anlage plant, wie genau es ist - und was die
            lernenden Kandidaten leisten{site ? ` (${site.name})` : ''}.
          </p>
        </div>
        <div className="actions">
          <SitePicker sites={props.sites} value={props.selectedSite} onChange={props.onSelectSite} />
        </div>
      </div>

      {props.sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch kein Standort - legen Sie zuerst unter „Standorte“ einen an.
          </p>
        </Card>
      ) : (
        <>
          {loading && (
            <Card padding="lg" radius="lg">
              <p className="vp-muted">Lade Prognosequalität…</p>
            </Card>
          )}
          {err && (
            <div className="vp-alert vp-alert-err">
              Die Prognosequalität konnte nicht geladen werden ({err}). Bitte versuchen
              Sie es später erneut.
            </div>
          )}

          {!loading && !err && quality && (
            <>
              {/* Which model is live, and how accurate it was. */}
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="dynamic" size={40}>
                      <Icon name="check" size={20} />
                    </IconTile>
                    <h2>Aktive Prognosen</h2>
                  </div>
                  <div className="vp-grid vp-grid-stats">
                    {(['load', 'pv'] as const).map((kind) => {
                      const model = activeByKind[kind];
                      const recent = recentMae(quality.accuracy, model);
                      return (
                        <div key={kind}>
                          <p className="vp-muted" style={{ margin: '0 0 4px' }}>
                            {KIND_LABELS[kind]}
                          </p>
                          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
                            {modelLabel(model)}{' '}
                            <Badge variant="ok" dot>
                              live
                            </Badge>
                          </p>
                          <Stat
                            value={recent ? kw(recent.mae) : '-'}
                            label={
                              recent
                                ? `Ø Abweichung, letzte ${recent.days} ${recent.days === 1 ? 'Tag' : 'Tage'}`
                                : 'Ø Abweichung (noch keine Bewertung)'
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                  <p className="vp-note" style={{ marginTop: 12 }}>
                    Die Abweichung vergleicht jede Viertelstunden-Prognose mit dem
                    tatsächlichen Messwert Ihrer Anlage - je niedriger, desto genauer.
                  </p>
                </Card>
              </section>

              {/* The learning candidates (shadow mode). */}
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="battery" size={40}>
                      <Icon name="trending-up" size={20} />
                    </IconTile>
                    <h2>Lernende Kandidaten</h2>
                    <Badge variant="tint">Schattenbetrieb</Badge>
                  </div>

                  {challengers.length === 0 ? (
                    <div className="vp-empty">
                      <h3>Noch keine Kandidaten aktiv</h3>
                      <p>
                        Sobald Messdaten eintreffen, beginnen die lernenden Modelle im
                        Hintergrund mitzurechnen. Die Bewertung startet nach dem ersten
                        vollen Tag mit Daten.
                      </p>
                    </div>
                  ) : (
                    <div className="vp-grid" style={{ gap: 'var(--vp-space-4)' }}>
                      {challengers.map((m) => (
                        <ChallengerCard
                          key={m.model}
                          state={m}
                          accuracy={quality.accuracy}
                        />
                      ))}
                    </div>
                  )}
                </Card>
              </section>

              {/* Accuracy over time, per kind - the comparison line. */}
              {(['load', 'pv'] as const).map((kind) => {
                const points = quality.accuracy.filter((a) => a.kind === kind);
                if (points.length === 0) return null;
                return (
                  <section className="vp-section" key={kind}>
                    <Card padding="lg" radius="lg">
                      <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                        <IconTile category="dynamic" size={40}>
                          <Icon name="activity" size={20} />
                        </IconTile>
                        <h2>Treffsicherheit {KIND_LABELS[kind]}</h2>
                      </div>
                      <ForecastQualityChart
                        points={points}
                        modelLabels={MODEL_LABELS}
                        activeModel={activeByKind[kind]}
                      />
                      <p className="vp-note" style={{ marginTop: 12 }}>
                        Tägliche mittlere Abweichung je Modell - je niedriger die Linie,
                        desto genauer die Prognose. Gestrichelt: der lernende Kandidat
                        (ohne Einfluss auf die Steuerung).
                      </p>
                    </Card>
                  </section>
                );
              })}

              {/* No evaluated day yet: honest empty state. */}
              {quality.accuracy.length === 0 && (
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <div className="vp-empty">
                      <IconTile category="dynamic" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
                        <Icon name="activity" size={24} />
                      </IconTile>
                      <h3>Noch zu wenig Daten</h3>
                      <p>
                        Die Bewertung vergleicht Prognosen mit den tatsächlichen
                        Messwerten und beginnt nach dem ersten vollen Tag mit Daten.
                        Schauen Sie morgen wieder vorbei.
                      </p>
                    </div>
                  </Card>
                </section>
              )}

              {/* The shadow-mode principle, in plain German. */}
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="home" size={40}>
                      <Icon name="list" size={20} />
                    </IconTile>
                    <h2>So funktioniert der Schattenbetrieb</h2>
                  </div>
                  <p style={{ margin: 0, maxWidth: '70ch' }}>
                    Neue Prognosemodelle laufen zunächst nur im Hintergrund mit: Sie
                    erstellen jeden Tag ihre eigenen Vorhersagen, haben aber{' '}
                    <strong>keinerlei Einfluss</strong> auf die Steuerung Ihrer Anlage.
                    Jede Nacht wird nachgerechnet, welches Modell näher an den echten
                    Messwerten lag. Erst wenn ein Kandidat über längere Zeit nachweislich
                    genauer ist, schalten wir ihn bewusst frei - automatisch passiert das
                    nie. So bleibt jederzeit nachvollziehbar, welches Modell Ihre Anlage
                    plant und warum.
                  </p>
                </Card>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}

function ChallengerCard({
  state,
  accuracy,
}: {
  state: ForecastModelState;
  accuracy: ForecastAccuracyPoint[];
}) {
  const collecting = state.status === 'collecting';
  const record = skillRecord(accuracy, state.model);
  const progress =
    collecting && state.daysCollected != null && state.daysRequired
      ? Math.min(100, Math.round((state.daysCollected / state.daysRequired) * 100))
      : null;

  return (
    <div
      style={{
        border: '1px solid var(--vp-color-border, #E9ECEF)',
        borderRadius: 'var(--vp-radius-md, 10px)',
        padding: 'var(--vp-space-4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{modelLabel(state.model)}</strong>
        {collecting ? (
          <Badge variant="warn" dot>
            sammelt Daten
          </Badge>
        ) : (
          <Badge variant="tint" dot>
            rechnet mit
          </Badge>
        )}
        <span className="vp-muted" style={{ fontSize: 'var(--vp-text-sm)' }}>
          {KIND_LABELS[state.kind]}
        </span>
      </div>

      {collecting ? (
        <>
          <p style={{ margin: '10px 0 6px' }}>
            Sammelt Daten: Tag {state.daysCollected ?? 0} von {state.daysRequired ?? 21}.
          </p>
          {progress != null && (
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Datensammlung ${progress} %`}
              style={{
                height: 6,
                borderRadius: 3,
                background: 'var(--vp-color-border, #E9ECEF)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: 'var(--vp-color-primary, #5A8DE8)',
                }}
              />
            </div>
          )}
          <p className="vp-note" style={{ marginTop: 8 }}>
            Der Kandidat wartet, bis genug Messtage vorliegen - vorher gibt er bewusst
            keine Prognose ab.
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: '10px 0 4px' }}>
            {record
              ? `In ${record.better} der letzten ${record.total} ${
                  record.total === 1 ? 'Bewertung' : 'Bewertungen'
                } genauer als das aktive Modell.`
              : 'Rechnet mit - die erste Tagesbewertung folgt nach dem nächsten vollen Tag.'}
          </p>
          <p className="vp-muted" style={{ margin: '0 0 8px', fontSize: 'var(--vp-text-sm)' }}>
            {state.trainedAt
              ? `Zuletzt trainiert am ${new Date(state.trainedAt).toLocaleDateString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}` +
                (state.trainRows
                  ? ` mit ${state.trainRows.toLocaleString('de-DE')} Messpunkten.`
                  : '.')
              : 'Noch nicht trainiert.'}
          </p>
          {state.featureImportance.length > 0 && (
            <>
              <p style={{ margin: '8px 0 4px', fontWeight: 600, fontSize: 'var(--vp-text-sm)' }}>
                Worauf das Modell besonders achtet:
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {state.featureImportance.slice(0, 5).map((fi) => (
                  <li key={fi.feature} style={{ fontSize: 'var(--vp-text-sm)' }}>
                    {fi.label}{' '}
                    <span className="vp-muted">
                      ({Math.round(fi.weight * 100).toLocaleString('de-DE')}{NBSP}%)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
