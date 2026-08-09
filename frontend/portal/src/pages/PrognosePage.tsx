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
import { InfoTip } from '../components/InfoTip';
import { ChartCardSkeleton, ErrorState } from '../components/States';
import { ForecastQualityChart } from '../ForecastQualityChart';
import {
  KANDIDAT_EHRLICHKEIT,
  KIND_LABELS,
  RAHMUNG,
  kandidatenZeilen,
  mittlereMae,
  skillBilanz,
  verdikt,
} from '../prognose';
import { useIsPhone } from '../useIsPhone';
import './Prognose.css';

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

/*
 * `KIND_LABELS` (die beiden Prognosearten), `mittlereMae` und `skillBilanz`
 * leben seit dem Mobil-Umbau in `src/prognose.ts` — die Mobil-Fassung leitet
 * ihr Verdikt aus GENAU denselben Zahlen ab, also darf es sie nicht zweimal
 * geben.
 */

function modelLabel(model: ForecastModelId): string {
  return MODEL_LABELS[model] ?? model;
}

function kw(v: number | null | undefined, digits = 2): string {
  return v == null
    ? '-'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits })}${NBSP}kW`;
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
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [site?.id, reloadKey]);

  const challengers = useMemo(
    () => (quality?.models ?? []).filter((m) => !m.active),
    [quality],
  );
  const activeByKind = useMemo(() => {
    if (!quality) return {} as Record<'load' | 'pv', ForecastModelId>;
    return { load: quality.activeLoadModel, pv: quality.activePvModel };
  }, [quality]);

  /*
   * Mobil-Umbau Stufe 4: am Telefon führt das VERDIKT (2 Arten × Ø-Abweichung),
   * dann die Kurven, dann der Kandidaten-Stand in zwei Zeilen; die zwei
   * Erklär-Essays werden Aufklapper. Gemessen begann die Seite vorher mit dem
   * Essay und zeigte das erste Diagramm bei 3.437 px. Am Rechner ist die
   * Reihenfolge unverändert — dort trägt die Breite beides nebeneinander.
   */
  const isPhone = useIsPhone();

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Prognosequalität</h1>
          <p>
            {/* Am Telefon EIN Satz - der lange Untertitel schob das Verdikt nach
                unten, und die Anlage steht bereits in der Kopfzeile der Schale. */}
            {isPhone
              ? 'Wie treffsicher Ihre Anlage vorhersagt.'
              : `Welches Prognosemodell Ihre Anlage plant, wie genau es ist - und was die lernenden Kandidaten leisten${site ? ` (${site.name})` : ''}.`}
          </p>
        </div>
        <div className="actions">
          <SitePicker sites={props.sites} value={props.selectedSite} onChange={props.onSelectSite} />
        </div>
      </div>

      {props.sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch keine Anlage - legen Sie zuerst unter „Meine Anlage“ eine an.
          </p>
        </Card>
      ) : (
        <>
          {/* Intro: what this page is, and what "live" vs "Schattenbetrieb" mean.
              Am Telefon zieht dieser Essay in den Aufklapper am Seitenfuß - er
              beantwortet eine Frage, die man EINMAL stellt, und stand vor der
              Antwort, die man bei jedem Besuch sucht. */}
          {!isPhone && (
          <section className="vp-section" style={{ marginTop: 'var(--vp-space-5)' }}>
            <Card padding="lg" radius="lg">
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="primary" size={40}>
                  <Icon name="info" size={20} />
                </IconTile>
                <h2>Was sehe ich hier?</h2>
              </div>
              <p style={{ margin: 0, maxWidth: '74ch' }}>
                Diese Seite zeigt, wie treffsicher die Prognosen sind, mit denen Ihre
                Anlage ihren Batterie-Fahrplan plant. Ihre Anlage nutzt dafür{' '}
                <strong>zwei getrennte Prognosen</strong>: eine für den{' '}
                <strong>Verbrauch (Last)</strong> und eine für die{' '}
                <strong>PV-Erzeugung</strong>. Aus beiden berechnet die Optimierung, wann
                sich Laden und Entladen lohnt - je genauer die Prognose, desto besser der
                Plan.
              </p>
              <p style={{ margin: 'var(--vp-space-3) 0 0', maxWidth: '74ch' }}>
                Jede der beiden Prognosen hat genau <strong>ein aktives Modell</strong>,
                das den Fahrplan steuert - und optional einen{' '}
                <strong>lernenden Kandidaten</strong>, der im Hintergrund mitrechnet, ohne
                etwas zu steuern. Unten stehen beide Prognosen getrennt: erst die aktiven
                Modelle, dann die Kandidaten.
              </p>
              <div className="vp-legend" style={{ marginTop: 'var(--vp-space-4)' }}>
                <div className="vp-legend-item">
                  <span className="vp-badge-hold">
                    <Badge variant="ok" dot>
                      live
                    </Badge>
                  </span>
                  <span>
                    Das aktive Modell - genau diese Prognosen nutzt die Optimierung, um
                    Ihre Anlage zu steuern.
                  </span>
                </div>
                <div className="vp-legend-item">
                  <span className="vp-badge-hold">
                    <Badge variant="tint">Schattenbetrieb</Badge>
                  </span>
                  <span>
                    Lernende Kandidaten - sie rechnen mit und werden bewertet, haben aber
                    keinerlei Einfluss auf die Steuerung.
                  </span>
                </div>
              </div>
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                Ein Kandidat wird nie automatisch aktiv: Das Umschalten des aktiven Modells
                ist immer eine bewusste Entscheidung anhand dieser Auswertung.
              </p>
            </Card>
          </section>
          )}

          {loading && (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton stats={2} />
            </Card>
          )}
          {err && (
            <ErrorState
              message={`Die Prognosequalität konnte nicht geladen werden (${err}).`}
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          )}

          {!loading && !err && quality && (
            <>
              {/* MOBIL: das Verdikt zuerst. Es rechnet nichts Neues - es sind
                  dieselben Zahlen wie in „Aktive Modelle" darunter, nur an der
                  Stelle, an der die Frage gestellt wird. */}
              {isPhone && (
                <section className="vp-section" style={{ marginTop: 'var(--vp-space-5)' }}>
                  <Card padding="lg" radius="lg">
                    <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                      <IconTile category="dynamic" size={40}>
                        <Icon name="check" size={20} />
                      </IconTile>
                      <h2>Wie gut Ihre Anlage vorhersagt</h2>
                      <InfoTip title="Ø Abweichung (MAE)">
                        Mittlerer absoluter Fehler in kW: der durchschnittliche Abstand
                        zwischen Prognose und tatsächlichem Messwert - berechnet je
                        Viertelstunde und über die Tage gemittelt. Niedriger = genauer.
                      </InfoTip>
                    </div>
                    <div className="vp-pq-verdikt">
                      {verdikt(quality.accuracy, activeByKind).map((z) => (
                        <div key={z.kind} className="vp-pq-zeile">
                          <span className="vp-pq-art">{z.art}</span>
                          <span className="vp-pq-wert">
                            <b>{z.wert}</b>
                            <span>{z.note}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="vp-pq-rahmung">
                      Je Viertelstunde verglichen mit dem, was wirklich gemessen wurde.
                      Diese zwei Prognosen planen Ihren Batterie-Fahrplan.
                    </p>
                  </Card>
                </section>
              )}

              {/* Which model is live, and how accurate it was. */}
              {!isPhone && (
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="dynamic" size={40}>
                      <Icon name="check" size={20} />
                    </IconTile>
                    <h2>Aktive Modelle</h2>
                    <InfoTip title="Ø Abweichung (MAE)">
                      Mittlerer absoluter Fehler in kW: der durchschnittliche Abstand
                      zwischen Prognose und tatsächlichem Messwert - berechnet je
                      Viertelstunde und über die Tage gemittelt. Niedriger = genauer.
                    </InfoTip>
                  </div>
                  <p className="vp-muted" style={{ margin: '0 0 var(--vp-space-4)' }}>
                    Je ein aktives Modell steuert die beiden Prognosen. Genau diese Modelle
                    plant Ihre Anlage - keine Doppelung, sondern zwei verschiedene Arten.
                  </p>
                  <div className="vp-grid vp-grid-two">
                    {(['load', 'pv'] as const).map((kind) => {
                      const model = activeByKind[kind];
                      const recent = mittlereMae(quality.accuracy, model);
                      return (
                        <div key={kind} className="vp-kind-card">
                          <div className="vp-kind-head">
                            <span className="vp-kind-title">{KIND_LABELS[kind]}</span>
                            <Badge variant="ok" dot>
                              aktiv
                            </Badge>
                          </div>
                          <p style={{ margin: '0 0 var(--vp-space-2)', fontWeight: 600 }}>
                            {modelLabel(model)}
                          </p>
                          <Stat
                            value={recent ? kw(recent.mae) : '-'}
                            label={
                              recent
                                ? `Ø Abweichung, letzte ${recent.tage} ${recent.tage === 1 ? 'Tag' : 'Tage'}`
                                : 'Ø Abweichung (noch keine Bewertung)'
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                  <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                    Die Abweichung vergleicht jede Viertelstunden-Prognose mit dem
                    tatsächlichen Messwert Ihrer Anlage - je niedriger, desto genauer.
                  </p>
                </Card>
              </section>
              )}

              {/* The learning candidates (shadow mode). Am Telefon steht der
                  Kandidaten-Stand als Zwei-Zeilen-Wahrheit UNTER den Kurven -
                  drei Karten mit Fortschrittsbalken, Trainingsdatum und
                  Merkmalsliste sind dort die Vertiefung, nicht die Aussage. */}
              {!isPhone && (
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="battery" size={40}>
                      <Icon name="trending-up" size={20} />
                    </IconTile>
                    <h2>Lernende Kandidaten</h2>
                    <Badge variant="tint">Schattenbetrieb</Badge>
                    <InfoTip title="Skill: besser als das aktive Modell?">
                      Skill = 1 − (Fehler des Kandidaten ÷ Fehler des aktiven Modells).
                      0 = so gut wie das aktive Modell, positiv = besser, negativ =
                      schlechter. „In X von Y Bewertungen genauer“ zählt die Tage mit
                      positivem Skill.
                    </InfoTip>
                  </div>
                  <p className="vp-muted" style={{ margin: '0 0 var(--vp-space-4)' }}>
                    Zu jeder der beiden Prognosen kann höchstens ein Kandidat mitlernen. Er
                    wird gegen genau das aktive Modell derselben Art bewertet - der
                    Verbrauchs-Kandidat gegen die Verbrauchsprognose, der PV-Kandidat gegen
                    die PV-Prognose.
                  </p>

                  {challengers.length === 0 ? (
                    <div className="vp-empty">
                      <h3>Noch keine Kandidaten aktiv</h3>
                      <p>
                        Sobald Messdaten eintreffen, beginnt je Prognoseart ein lernendes
                        Modell im Hintergrund mitzurechnen. Die Bewertung startet nach dem
                        ersten vollen Tag mit Daten.
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
              )}

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
                        <InfoTip title="Ø Abweichung (MAE) je Tag">
                          Jeder Punkt ist die mittlere Abweichung eines Modells an einem
                          Tag in kW (Prognose gegen Messwert). Niedriger = genauer.
                          Durchgezogen: aktives Modell. Gestrichelt: lernender Kandidat
                          (ohne Einfluss auf die Steuerung).
                        </InfoTip>
                      </div>
                      <ForecastQualityChart
                        points={points}
                        modelLabels={MODEL_LABELS}
                        activeModel={activeByKind[kind]}
                      />
                      <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                        Tägliche mittlere Abweichung je Modell - je niedriger die Linie,
                        desto genauer die Prognose. Gestrichelt: der lernende Kandidat
                        (ohne Einfluss auf die Steuerung).
                      </p>
                    </Card>
                  </section>
                );
              })}

              {/* MOBIL: der Kandidaten-Stand als Zwei-Zeilen-Wahrheit, darunter
                  EINMAL der Ehrlichkeits-Satz - der Schattenbetrieb-Kern in
                  ~90 px statt in drei Karten. */}
              {isPhone && challengers.length > 0 && (
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                      <IconTile category="battery" size={40}>
                        <Icon name="trending-up" size={20} />
                      </IconTile>
                      <h2>Lernende Kandidaten</h2>
                      <Badge variant="tint">Schattenbetrieb</Badge>
                    </div>
                    {kandidatenZeilen(challengers, quality.accuracy).map((z) => (
                      <div key={z.model} className="vp-pq-kandidat">
                        <span>{z.art}</span>
                        <span className={`vp-pq-stand ton-${z.ton}`}>{z.stand}</span>
                      </div>
                    ))}
                    <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                      {KANDIDAT_EHRLICHKEIT}
                    </p>
                  </Card>
                </section>
              )}

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
              {!isPhone && (
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
              )}

              {/* MOBIL: die zwei Erklär-Essays als Aufklapper am Seitenfuß.
                  Der INHALT ist unverändert - er wandert nur aus dem täglichen
                  Scrollweg heraus. Die Rahmung „2 Arten × (1 aktiv + höchstens
                  1 Schatten)" bleibt dabei SICHTBAR, sie ist die Antwort auf die
                  dokumentierte Verwirrung „zwei aktive Prognosen". */}
              {isPhone && (
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <p className="vp-pq-rahmung" style={{ marginTop: 0 }}>
                      {RAHMUNG}
                    </p>
                    <details className="vp-pq-fold">
                      <summary>
                        <Icon name="chevron-down" size={16} />
                        Was sehe ich hier?
                      </summary>
                      <div className="vp-pq-fold-body">
                        <p>
                          Diese Seite zeigt, wie treffsicher die Prognosen sind, mit denen
                          Ihre Anlage ihren Batterie-Fahrplan plant. Ihre Anlage nutzt dafür{' '}
                          <strong>zwei getrennte Prognosen</strong>: eine für den{' '}
                          <strong>Verbrauch (Last)</strong> und eine für die{' '}
                          <strong>PV-Erzeugung</strong>. Aus beiden berechnet die
                          Optimierung, wann sich Laden und Entladen lohnt - je genauer die
                          Prognose, desto besser der Plan.
                        </p>
                        <p>
                          Jede der beiden Prognosen hat genau{' '}
                          <strong>ein aktives Modell</strong>, das den Fahrplan steuert -
                          und optional einen <strong>lernenden Kandidaten</strong>, der im
                          Hintergrund mitrechnet, ohne etwas zu steuern.
                        </p>
                      </div>
                    </details>
                    <details className="vp-pq-fold">
                      <summary>
                        <Icon name="chevron-down" size={16} />
                        So funktioniert der Schattenbetrieb
                      </summary>
                      <div className="vp-pq-fold-body">
                        <p>
                          Neue Prognosemodelle laufen zunächst nur im Hintergrund mit: Sie
                          erstellen jeden Tag ihre eigenen Vorhersagen, haben aber{' '}
                          <strong>keinerlei Einfluss</strong> auf die Steuerung Ihrer
                          Anlage. Jede Nacht wird nachgerechnet, welches Modell näher an den
                          echten Messwerten lag. Erst wenn ein Kandidat über längere Zeit
                          nachweislich genauer ist, schalten wir ihn bewusst frei -
                          automatisch passiert das nie.
                        </p>
                      </div>
                    </details>
                  </Card>
                </section>
              )}
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
  const record = skillBilanz(accuracy, state.model);
  const progress =
    collecting && state.daysCollected != null && state.daysRequired
      ? Math.min(100, Math.round((state.daysCollected / state.daysRequired) * 100))
      : null;

  return (
    <div
      style={{
        border: '1px solid var(--vp-border)',
        borderRadius: 'var(--vp-radius-md)',
        padding: 'var(--vp-space-4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--vp-space-2)', flexWrap: 'wrap' }}>
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
          <p style={{ margin: 'var(--vp-space-3) 0 var(--vp-space-2)' }}>
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
                background: 'var(--vp-border)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: 'var(--vp-action)',
                }}
              />
            </div>
          )}
          <p className="vp-note" style={{ marginTop: 'var(--vp-space-2)' }}>
            Das ist normal: Ein lernendes Modell trainiert erst nach 21 vollständigen
            Messtagen. Bis dahin sammelt es nur Daten und gibt bewusst keine Prognose ab.
            Danach erstellt es automatisch eigene Vorhersagen und wird täglich gegen das
            aktive Modell bewertet.
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: 'var(--vp-space-3) 0 var(--vp-space-1)' }}>
            {record
              ? `In ${record.besser} der letzten ${record.gesamt} ${
                  record.gesamt === 1 ? 'Bewertung' : 'Bewertungen'
                } genauer als das aktive Modell.`
              : 'Rechnet mit - die erste Tagesbewertung folgt nach dem nächsten vollen Tag.'}
          </p>
          <p className="vp-muted" style={{ margin: '0 0 var(--vp-space-2)', fontSize: 'var(--vp-text-sm)' }}>
            {state.trainedAt
              ? `Zuletzt trainiert am ${new Date(state.trainedAt).toLocaleDateString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}` +
                (state.trainRows
                  ? ` mit ${state.trainRows.toLocaleString('de-DE')} Messwerten.`
                  : '.')
              : 'Noch nicht trainiert.'}
          </p>
          {state.featureImportance.length > 0 && (
            <>
              <p style={{ margin: 'var(--vp-space-2) 0 var(--vp-space-1)', fontWeight: 600, fontSize: 'var(--vp-text-sm)' }}>
                Worauf das Modell besonders achtet:
              </p>
              <ul style={{ margin: 0, paddingLeft: 'var(--vp-space-5)' }}>
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
