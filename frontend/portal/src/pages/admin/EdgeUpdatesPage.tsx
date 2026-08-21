import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MiniShareBar } from '../../components/MiniChart';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { fmtRelative } from '../../format';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { pageRoute, type Route } from '../../nav';
import { AdminPageHead } from './AdminPageHead';
import { GeraeteDrawer } from './GeraeteDrawer';
import {
  actorLabel,
  bakeLine,
  blockerLever,
  eventLabel,
  advanceMode,
  crossoverHint,
  freshnessLabel,
  frozenFraming,
  applyView,
  handelnItems,
  loudBanner,
  progressBackbone,
  promoteHint,
  restingLine,
  rolloutStateLabel,
  signatureLabel,
  candidates,
  startSummary,
  stateLabel,
  visibleJournal,
  waveDeviceName,
  waveRowView,
  type ActiveRollout,
  type EdgeUpdates,
  type EdgeUpdatesRelease,
  type FleetRow,
  type UpdateTone,
  type WaveDevice,
} from '../../adminEdgeUpdates';

const toneVariant = (tone: UpdateTone): 'ok' | 'warn' | 'off' =>
  tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'off';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';

/**
 * Das Kleid EINES Zustands - die vier Klassen der Beobachtungs-Grammatik.
 *
 * Bewusst KEIN `Badge`: die Unterscheidung „läuft von selbst" (pulsiert) vs.
 * „SIE sind dran" (statisch, navy) ist der ganze Punkt des Umbaus, und der
 * Badge kennt nur ok/warn/off. Die Klasse trägt sie, die Beschriftung bleibt
 * die des reinen Moduls.
 */
function StateChip({ state }: { state: string }) {
  const st = stateLabel(state);
  return (
    <span className={`vp-ustate vp-ustate-${st.cls}`} data-testid={`state-${st.cls}`}>
      <i className="vp-ustate-dot" aria-hidden="true" />
      {st.label}
    </span>
  );
}


/**
 * Plattform → **Edge-Updates** (OTA Stufe 2, Scout §7.3): Releases · aktiver
 * Rollout · Flotten-Matrix · Verlauf.
 *
 * **Diese Seite entscheidet NICHTS.** Ob eine Welle frei ist, was ein Gerät
 * gerade tut und warum eine Freigabe gesperrt ist, sagt der Server
 * (`RolloutStates`/`BakeGate`) - hier wird es gerendert. Die Freigabe ist
 * server-seitig gesperrt, nicht nur der Knopf: ein direkter Aufruf des
 * Endpunkts bekommt dieselbe 409 mit demselben Grund.
 *
 * Die Ehrlichkeitsregeln (§7): „unbekannt" ist nie „veraltet", „offline" ist
 * nie „fehlgeschlagen", Prozente laufen über die erreichbare Menge, und jede
 * rote Zeile trägt ihren Grund.
 */
export function EdgeUpdatesPage({
  onNavigate,
  onJumpToTenant,
  tabs,
}: {
  onNavigate?: (target: Route) => void;
  /**
   * Der Weg auf die EINE Geräteseite (Stufe 3, PR 3b): sie liegt hinter dem
   * RLS-Zaun, also muss der Mandant gesetzt sein, bevor die Adresse gilt.
   * Ohne diesen Rückruf bietet der Drawer den Weg gar nicht erst an.
   */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  /**
   * Die Tab-Leiste des Geräte-Bereichs (Stufe 3). Sie kommt vom Wirt
   * `GeraeteBereich` und wird hier nur PLATZIERT - ohne sie (Direktaufruf,
   * Test) rendert die Seite unverändert wie vorher.
   */
  tabs?: ReactNode;
} = {}) {
  const [data, setData] = useState<EdgeUpdates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolloutFor, setRolloutFor] = useState<EdgeUpdatesRelease | null>(null);
  const [deviceFor, setDeviceFor] = useState<string | null>(null);
  // Zustand UND Bezugszeit werden ZUSAMMEN gesetzt - ein Alter, das gegen eine
  // Uhr über einem stehenden Schnappschuss rechnet, verfällt von selbst
  // (die Lebendigkeits-Lehre aus `liveness.ts`).
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  // Welche Rückfrage gerade aussteht - beide im Haus-Muster (Folgenliste),
  // nie ein nativer `window.confirm`.
  const [confirm, setConfirm] = useState<'halt' | 'auto' | null>(null);
  // Das Gerät, für das gerade eine Freigabe bestätigt wird. Eine Handlung, die
  // eine Kundenanlage neu startet, geht nie ohne Rückfrage - und die Rückfrage
  // NENNT die Folgen.
  const [applyFor, setApplyFor] = useState<string | null>(null);
  const [tick, setTick] = useState<number>(() => Date.now());

  async function load() {
    try {
      setData(await adminApi.edgeUpdates());
      setFetchedAt(Date.now());
      setTick(Date.now());
      setLoadError(null);
    } catch (e) {
      // Ein Fehlschlag ist keine Datenlage: steht schon eine Tabelle, bleibt sie
      // mit ihrer ALTEN Bezugszeit stehen - der stille Takt darf den Zustand
      // nie kippen.
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Edge-Updates konnten nicht geladen werden.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Ein Beobachtungs-Werkzeug, das man von Hand aktualisieren muss, erzeugt
  // genau das „hängt es?"-Gefühl, für das dieser Umbau existiert. 30 s still,
  // beim Zurückkehren in den Tab sofort (der Hook pausiert im Hintergrund).
  useFreshnessPoll(() => void load(), 30_000, true);
  // Der zweite, billige Takt lässt NUR die Bezugszeit-Zeile weiterzählen -
  // ohne ihn stünde „vor 0 Sek." bis zum nächsten Abruf.
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      // Der Server liefert seinen deutschen Grund mit - er wird gezeigt, nicht
      // durch eine allgemeine Floskel ersetzt.
      setActionError(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const rollout = data?.activeRollout ?? null;
  const banner = useMemo(() => loudBanner(data?.fleet ?? []), [data]);
  const journal = useMemo(() => visibleJournal(data?.journal ?? []), [data]);
  const hint = promoteHint(rollout);
  const mode = advanceMode(rollout);
  // Was gerade auf den Betreiber wartet - der Job, der bis hierher kein
  // Zuhause hatte. Leer = die Karte verschwindet, sie ist nie ein Dauerbanner.
  const handeln = useMemo(() => handelnItems(data), [data]);
  const progress = useMemo(() => progressBackbone(data), [data]);
  const framing = frozenFraming(rollout);
  const resting = restingLine(data);
  // OTA Stufe 4: der ruhige TOFU-Hinweis über der Flotte. Er zählt nur BELEGT
  // offene Crossover; ein Gerät, das nichts meldet, wird getrennt genannt -
  // aus „unbekannt" lässt sich keine Aufgabe ableiten.
  const crossover = useMemo(() => crossoverHint(data?.fleet ?? []), [data]);

  return (
    <>
      {tabs}
      <AdminPageHead
        icon="refresh-cw"
        category="industry"
        title="Edge-Updates"
        description="Welches Release läuft wo, was ist zugewiesen - und was ist daraus geworden."
        actions={
          <div className="vp-row-gap" style={{ alignItems: 'center' }}>
            {/* Die Bezugszeit der gezeigten Daten - ohne sie ist „nichts
                bewegt sich" von „niemand hat nachgesehen" nicht zu trennen. */}
            <span className="vp-muted vp-text-sm" data-testid="freshness">
              {freshnessLabel(fetchedAt, tick)} · aktualisiert sich alle 30 s
            </span>
            <Button
              variant="outline"
              iconLeft={<Icon name="refresh-cw" size={18} />}
              onClick={() => void load()}
            >
              Aktualisieren
            </Button>
          </div>
        }
      />

      {/* Warn-first, wie im Flotten-Puls: was Aufmerksamkeit braucht, steht oben
          und NENNT die Geräte. Ein Alarm ohne Adresse ist Lärm. */}
      {banner && (
        <div className="vp-alert vp-alert-warn" data-testid="loud-banner">
          {banner}
        </div>
      )}
      {actionError && <div className="vp-alert vp-alert-warn">{actionError}</div>}

      {loadError && data == null ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : data == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={6} />
        </Card>
      ) : (
        <>
          {/* ── 0. „Sie sind dran" ──────────────────────────────────────── */}
          {/* Handeln zuerst: Welle-freigeben und Anwenden-am-Gerät gebündelt,
              mit Ort und Weg. Es gibt sie nur, wenn wirklich etwas ansteht. */}
          {handeln.length > 0 && (
            <Card padding="lg" radius="lg" className="vp-handeln"
                  style={{ marginBottom: 'var(--vp-space-6)' }}>
              <div className="vp-row-between">
                <h3 style={{ marginTop: 0 }}>
                  <Icon name="users" size={18} /> Sie sind dran
                </h3>
                <span className="vp-muted vp-text-sm" data-testid="handeln-count">
                  {handeln.length === 1 ? '1 Schritt wartet auf Sie'
                    : `${handeln.length} Schritte warten auf Sie`}
                </span>
              </div>
              <ul className="vp-plain-list" data-testid="handeln">
                {handeln.map((item) => (
                  <li key={item.key} className="vp-handeln-item">
                    <strong>{item.title}</strong>
                    <div className="vp-muted vp-text-sm">{item.detail}</div>
                    {/* Ohne den WEG ist „Sie sind dran" nur ein Vorwurf. */}
                    {item.how && <div className="vp-muted vp-text-sm">{item.how}</div>}
                    {item.kind === 'wave' && rollout && (
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void act(() => adminApi.promoteRollout(rollout.id))}
                      >
                        Welle freigeben ▸
                      </Button>
                    )}
                    {item.kind === 'apply' && item.deviceId && (
                      <>
                        {/* Was die Anwendung verhindern WIRD, steht VOR dem
                            Knopf - eine Verweigerung danach wäre ein Rätsel. */}
                        {item.apply?.warn && (
                          <div className="vp-text-sm vp-lever" data-testid="handeln-warn">
                            Achtung: {item.apply.warn}
                          </div>
                        )}
                        <div className="vp-row-gap">
                          <Button
                            variant="primary"
                            disabled={busy || !item.apply?.canClick}
                            onClick={() => setApplyFor(item.deviceId)}
                          >
                            {/* Das ▸ ist ein Versprechen auf einen nächsten
                                Schritt - ein Knopf, der gerade nichts auslösen
                                kann, gibt es nicht. */}
                            {item.apply?.label ?? 'Auf Gerät anwenden'}
                            {item.apply?.canClick ? ' ▸' : ''}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => setDeviceFor(item.deviceId)}
                          >
                            Gerät ansehen
                          </Button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Der Ruhezustand: EINE Zeile statt leerer Karten. */}
          {resting && (
            <div className="vp-alert vp-alert-info" data-testid="resting-line">{resting}</div>
          )}

          {/* ── 1. Releases ─────────────────────────────────────────────── */}
          {/* Sie treten ZURÜCK, solange ein Rollout läuft: dann ist Beobachten
              der Job dieser Seite, nicht Starten. Ein `details` bleibt dabei
              vollständig erreichbar - nichts wird versteckt, nur geordnet. */}
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <details open={rollout == null}>
            <summary className="vp-sec-summary"><h3 style={{ margin: 0, display: 'inline' }}>
              Releases
            </h3></summary>
            {data.releases.length === 0 ? (
              <EmptyState
                title="Noch kein Release registriert"
                description="Ohne Register ist „veraltet“ keine Aussage. Ein Release wird nach der Signatur über die Admin-Schnittstelle eingetragen (docs/ota-signing.md)."
              />
            ) : (
              <table className="vp-table responsive" data-testid="releases">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Commit</th>
                    <th>Signatur</th>
                    <th>Läuft auf</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.releases.map((r) => {
                    const sig = signatureLabel(r);
                    return (
                      <tr key={r.releaseSeq}>
                        <td data-label="Version">
                          <strong>{r.version}</strong>
                          {r.notes && (
                            <div className="vp-muted vp-text-sm">{r.notes}</div>
                          )}
                        </td>
                        <td data-label="Commit" className="vp-muted">
                          {r.targetCommit ?? '–'}
                        </td>
                        <td data-label="Signatur">
                          <Badge variant={toneVariant(sig.tone)} dot>
                            {sig.label}
                          </Badge>
                        </td>
                        <td data-label="Läuft auf">
                          {r.runningOnDevices === 0
                            ? '–'
                            : `${r.runningOnDevices} Gerät${r.runningOnDevices === 1 ? '' : 'e'}`}
                        </td>
                        <td>
                          {/* Nur ein SIGNIERTES Release ist verteilbar: ohne
                              Manifest-Bytes hat ein Gerät nichts, was es gegen
                              seine eingebackene Wurzel prüfen könnte. */}
                          {r.signed ? (
                            <Button
                              variant="outline"
                              onClick={() => setRolloutFor(r)}
                              disabled={busy}
                            >
                              Rollout starten ▸
                            </Button>
                          ) : (
                            <span className="vp-muted vp-text-sm">
                              Nicht signiert – nicht verteilbar
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            </details>
          </Card>

          {/* ── 2. Aktiver Rollout ──────────────────────────────────────── */}
          {/* Ohne Rollout gibt es die Karte GAR NICHT: die ruhige Zeile oben
              sagt dasselbe in einem Satz, und eine leere Karte ist Fläche ohne
              Aussage. */}
          {rollout && (
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <div className="vp-row-between">
              <h3 style={{ marginTop: 0 }}>Aktiver Rollout</h3>
              <Badge variant={toneVariant(rolloutStateLabel(rollout.state).tone)} dot>
                {rolloutStateLabel(rollout.state).label}
              </Badge>
            </div>
            {(
              <>
                <p className="vp-muted">
                  {rollout.releaseVersion} → {rollout.channel} · gestartet{' '}
                  {fmtWhen(rollout.createdAt)}
                  {rollout.createdBy ? ` von ${actorLabel(rollout.createdBy)}` : ''}
                </p>
                {/* Ein eingefrorener Rollout ist ein ABSCHLUSSBILD: die Zeilen
                    führen mit dem LIVE-Zustand, die Geschichte steht darunter.
                    Als gleichrangige Nachbarn lasen sich die beiden Wahrheiten
                    als Widerspruch (§1 Nr. 3). */}
                {framing && (
                  <div className="vp-alert vp-alert-info" data-testid="frozen-framing">
                    <strong>{framing.headline}</strong> · {framing.note}
                  </div>
                )}
                {rollout.haltedReason && (
                  <div className="vp-alert vp-alert-warn" data-testid="halted-reason">
                    {rollout.haltedReason}
                  </div>
                )}

                {/* Das Fortschritts-Rückgrat: wo steht die Verteilung, in einem
                    Blick - über die ERREICHBARE Menge, offline daneben. */}
                {progress && progress.total > 0 && (
                  <div className="vp-backbone" data-testid="backbone">
                    <MiniShareBar
                      className="vp-backbone-bar"
                      segments={progress.segments.map((s) => ({
                        key: s.cls,
                        weight: s.count,
                        className: `vp-backbone-seg vp-ustate-${s.cls}`,
                        title: `${s.count} ${s.label}`,
                      }))}
                    />
                    <div className="vp-backbone-legend vp-text-sm">
                      {progress.segments.map((s) => (
                        <span key={s.cls} className="vp-backbone-key">
                          <i className={`vp-ustate-dot vp-ustate-${s.cls}`} aria-hidden="true" />
                          {s.count} {s.label}
                        </span>
                      ))}
                      {progress.asideNote && (
                        <span className="vp-muted" data-testid="backbone-aside">
                          {progress.asideNote}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {rollout.waves.map((w) => (
                  <div key={w.index} style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <div className="vp-text-sm" style={{ fontWeight: 600 }}>
                      Welle {w.index} · {w.name}{' '}
                      {!w.released && <span className="vp-muted">(noch nicht freigegeben)</span>}
                    </div>
                    <ul className="vp-plain-list">
                      {w.devices.map((d) => (
                        <WaveDeviceRow
                          key={d.deviceId}
                          device={d}
                          fleet={data.fleet}
                          frozen={framing != null}
                          onOpen={setDeviceFor}
                        />
                      ))}
                    </ul>
                  </div>
                ))}

                <div className="vp-row-gap">
                  {rollout.state === 'active' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => adminApi.pauseRollout(rollout.id))}
                    >
                      ⏸ Pausieren
                    </Button>
                  )}
                  {rollout.state === 'paused' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => adminApi.resumeRollout(rollout.id))}
                    >
                      ▶ Fortsetzen
                    </Button>
                  )}
                  {(rollout.state === 'active' || rollout.state === 'paused') && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      /* Der Not-Aus ist ENDGÜLTIG - er verdient die Folgenliste
                         des Hauses, nicht den nativen Ein-Satz-Dialog, den
                         niemand liest. */
                      onClick={() => setConfirm('halt')}
                    >
                      ⛔ Einfrieren
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy || !rollout.canPromote}
                    onClick={() => void act(() => adminApi.promoteRollout(rollout.id))}
                  >
                    Nächste Welle ▸
                  </Button>
                </div>
                {/* In welchem Modus läuft dieser Rollout - und was passiert als
                    Nächstes. Ohne diese Zeile wäre die Automatik ein
                    unsichtbarer Zustand. */}
                {mode && (
                  <div className="vp-row-gap" style={{ marginTop: 'var(--vp-space-3)' }}
                       data-testid="advance-mode">
                    <Badge variant={toneVariant(mode.tone)} dot>{mode.label}</Badge>
                    {(rollout.state === 'active' || rollout.state === 'paused') && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          // Das AUSschalten braucht keine Rückfrage: es nimmt
                          // eine Erleichterung zurück, es gibt keine her.
                          if (rollout.autoAdvance === true) {
                            void act(() => adminApi.setAutoAdvance(rollout.id, false));
                          } else {
                            setConfirm('auto');
                          }
                        }}
                      >
                        {rollout.autoAdvance ? 'Auf Hand-Vorschub umstellen'
                          : 'Automatisch weiterschalten'}
                      </Button>
                    )}
                  </div>
                )}
                {mode?.note && (
                  <p className="vp-muted vp-text-sm" data-testid="advance-note">{mode.note}</p>
                )}
                {/* WARUM der Knopf gesperrt ist - ein deaktivierter Knopf ohne
                    Begründung ist eine Sackgasse. */}
                {hint && (
                  <p className="vp-muted vp-text-sm" data-testid="promote-hint">
                    {hint}
                  </p>
                )}
              </>
            )}
          </Card>
          )}

          {/* ── 3. Die Flotten-Matrix ist ENTFALLEN (E2) ────────────────
              Sie war die strukturelle Ursache der „zwei Wahrheiten auf einer
              Seite": das Wellen-Board zeigte den historischen Zustand, sie
              daneben die Live-Ableitung - als gleichrangige Nachbarn las sich
              das als Widerspruch. Ihre drei Aufgaben haben bessere Wohnorte:
              Flotten-Zustand → Puls (Spalte „Edge-Stand"), Rollout-Beobachtung
              → das Wellen-Board oben (es zeigt ohnehin JEDES Gerät des
              Rollouts), Geräte-Drilldown → die Seite „Geräte".
              Das REVIDIERT bewusst §7.3 des OTA-Scouts; kein Informations-
              gehalt geht verloren. */}
          {/* Ein VERWEIS ist keine Meldung: er steht ruhig, nicht als zweiter
              blauer Kasten neben der Ruhezustands-Zeile. */}
          <p className="vp-muted vp-text-sm" data-testid="fleet-pointer"
             style={{ marginBottom: 'var(--vp-space-6)' }}>
            Der heutige Stand JEDES Geräts steht in der{' '}
            <button type="button" className="vp-linkbtn"
                    onClick={() => onNavigate?.(pageRoute('geraete-registry'))}>
              Geräte-Übersicht
            </button>
            {' '}(dort auch Kanal, Pin und Vertrauen je Gerät) und im Flotten-Puls.
            {crossover ? ` ${crossover}` : ''}
          </p>

          {/* ── 4. Verlauf ──────────────────────────────────────────────── */}
          <Card padding="lg" radius="lg">
            <details open={rollout == null}>
            <summary className="vp-sec-summary"><h3 style={{ margin: 0, display: 'inline' }}>
              Verlauf
            </h3></summary>
            {journal.length === 0 ? (
              <EmptyState title="Noch nichts passiert" description="" />
            ) : (
              <ul className="vp-plain-list" data-testid="journal">
                {journal.slice(0, 50).map((e) => (
                  <li key={e.id}>
                    <span className="vp-muted">{fmtWhen(e.at)}</span> ·{' '}
                    <strong>{actorLabel(e.actor)}</strong> · {eventLabel(e.event)}
                    {e.detail ? ` – ${e.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}
            </details>
          </Card>
        </>
      )}

      {deviceFor && data && (() => {
        const row = data.fleet.find((r) => r.deviceId === deviceFor);
        if (!row) return null;
        return (
          <GeraeteDrawer
            device={row}
            releases={data.releases}
            journal={data.journal}
            busy={busy}
            onClose={() => setDeviceFor(null)}
            onAssign={async (releaseSeq, channel, pinned) => {
              await act(() =>
                adminApi.setUpdateTarget(row.deviceId, { releaseSeq, channel, pinned }),
              );
              setDeviceFor(null);
            }}
            onRevert={async () => {
              await act(() => adminApi.revertUpdateTarget(row.deviceId));
              setDeviceFor(null);
            }}
            onApply={async () => setApplyFor(row.deviceId)}
            onOpenGeraetseite={
              onJumpToTenant
                ? () => {
                    setDeviceFor(null);
                    onJumpToTenant(row.tenantId, {
                      page: 'anlagen',
                      siteId: row.siteId,
                      sub: 'geraet',
                      geraet: { ref: row.externalRef, geraetId: null },
                    });
                  }
                : undefined
            }
          />
        );
      })()}

      {applyFor && data && (() => {
        const row = data.fleet.find((r) => r.deviceId === applyFor);
        if (!row) return null;
        const view = applyView(row);
        return (
          <ConfirmDialog
            open
            title="Release jetzt auf dem Gerät anwenden?"
            intro={`${row.siteName}: ${row.soll ?? 'das zugewiesene Release'} wird angewandt.`}
            consequences={[
              'Das Gerät startet seine Dienste neu - die Anlage ist dabei kurz ohne '
                + 'VoltPilot-Steuerung und fällt in ihr eigenes Verhalten zurück.',
              'Es ist GENAU EINE Freigabe für GENAU DIESES Release: sie gilt 15 Minuten und '
                + 'wird danach nicht nachgeliefert.',
              'Das Gerät prüft die Signatur weiterhin selbst und wendet nur an, wenn alle '
                + 'seine Bedingungen erfüllt sind - Selbsttest und automatische Rücknahme '
                + 'inklusive.',
              'Automatische Updates werden dadurch NICHT eingeschaltet.',
              ...(view.warn ? [`Achtung: ${view.warn}`] : []),
            ]}
            confirmLabel="Jetzt freigeben"
            busy={busy}
            onCancel={() => setApplyFor(null)}
            onConfirm={() => {
              setApplyFor(null);
              setDeviceFor(null);
              void act(() => adminApi.requestApply(row.deviceId));
            }}
          />
        );
      })()}

      {rollout && (
        <ConfirmDialog
          open={confirm === 'halt'}
          tone="danger"
          title="Rollout einfrieren?"
          intro={`Der Rollout von ${rollout.releaseVersion} wird angehalten.`}
          consequences={[
            'Es wird nichts weiter verteilt - keine weitere Welle, kein weiteres Gerät.',
            'Bereits erteilte Zuweisungen BLEIBEN bestehen: sie zurückzunehmen schickte eine '
              + 'halb aktualisierte Flotte auf einen dritten Stand.',
            'Das Einfrieren ist ENDGÜLTIG. Weitermachen ist danach ein neuer, bewusst '
              + 'gestarteter Rollout.',
          ]}
          confirmLabel="Endgültig einfrieren"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(() => adminApi.haltRollout(rollout.id));
          }}
        />
      )}

      {rollout && (
        <ConfirmDialog
          open={confirm === 'auto'}
          title="Wellen automatisch weiterschalten?"
          intro={'Es ändert sich AUSSCHLIESSLICH, wer „Nächste Welle" drückt.'}
          consequences={[
            'Dasselbe Bake-Kriterium: 24 Std. gesunder Betrieb und - wo VoltPilot steuert - '
              + 'ein bestätigter Steuerzyklus.',
            'Derselbe automatische Halt bei jedem Fehlschlag.',
            'Derselbe endgültige Not-Aus.',
            'Jederzeit wieder auf Hand-Vorschub umstellbar.',
          ]}
          confirmLabel="Automatik einschalten"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(() => adminApi.setAutoAdvance(rollout.id, true));
          }}
        />
      )}

      {rolloutFor && data && (
        <StartRolloutDrawer
          release={rolloutFor}
          fleet={data.fleet}
          rollout={data.activeRollout}
          onClose={() => setRolloutFor(null)}
          onStart={async (waves, channel, autoAdvance) => {
            await act(() =>
              adminApi.createRollout({
                releaseSeq: rolloutFor.releaseSeq,
                channel,
                waves,
                autoAdvance,
              }),
            );
            setRolloutFor(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Eine Wellen-Zeile: **Name immer, LIVE führt, Geschichte ist Fußnote.**
 *
 * Beides sind die zwei Reibungen, die diese Zeile bis hierher erzeugt hat: sie
 * fiel auf eine nackte UUID zurück, sobald das Gerät die Plattform verlassen
 * hatte (R2), und sie widersprach der Flotte darunter, weil sie den
 * persistierten statt des heutigen Zustands zeigte (R3).
 */
function WaveDeviceRow({
  device,
  fleet,
  frozen,
  onOpen,
}: {
  device: WaveDevice;
  fleet: FleetRow[];
  frozen: boolean;
  /** Seit die Matrix entfallen ist, ist DIESE Zeile der Weg ins Gerät. */
  onOpen?: (deviceId: string) => void;
}) {
  const name = waveDeviceName(device);
  const view = waveRowView(device, fleet, frozen);
  const bake = bakeLine(device);
  const live = fleet.find((r) => r.deviceId === device.deviceId);
  const lever = blockerLever(live?.blocker);
  // Ein Gerät, das die Plattform verlassen hat, ist nicht mehr zu öffnen -
  // ein Klick führte ins Leere.
  const open = live && onOpen ? () => onOpen(device.deviceId) : undefined;
  return (
    <li className={open ? 'vp-wave-device vp-row-click' : 'vp-wave-device'}
        onClick={open} title={open ? 'Gerät öffnen' : undefined}>
      <StateChip state={view.state} />{' '}
      <strong className={name.removed ? 'vp-muted' : undefined}>{name.name}</strong>
      {device.tenantName && <span className="vp-muted"> · {device.tenantName}</span>}
      {device.since && <span className="vp-muted"> · seit {fmtRelative(device.since)}</span>}
      {/* Jede nicht-grüne Zeile trägt ihren Grund. */}
      {view.reason && <div className="vp-muted vp-text-sm">{view.reason}</div>}
      {/* Der HEBEL kommt aus dem maschinenlesbaren Namen, nie aus einer
          Stichwortsuche im deutschen Satz. */}
      {lever && (
        <div className="vp-text-sm vp-lever" data-testid="lever">
          Hebel: {lever}
        </div>
      )}
      {bake && <div className="vp-muted vp-text-sm">{bake}</div>}
      {view.historyNote && (
        <div className="vp-muted vp-text-sm vp-wave-history" data-testid="wave-history">
          {view.historyNote}
        </div>
      )}
    </li>
  );
}

/**
 * Die Wellen werden von HAND geschnitten (D4: hand-advanced ist bei ≤10
 * Geräten richtig) - wer die Wellen schneidet, trifft eine Entscheidung, die
 * niemand raten sollte. Deshalb: Canary auswählen, Rest bildet Welle 2.
 */
function StartRolloutDrawer({
  release,
  fleet,
  rollout,
  onClose,
  onStart,
}: {
  release: EdgeUpdatesRelease;
  fleet: FleetRow[];
  /** Der letzte Rollout - er BELEGT, welcher Canary sich bewährt hat (D4). */
  rollout: ActiveRollout | null;
  onClose: () => void;
  onStart: (
    waves: { name: string; devices: string[] }[],
    channel: string,
    autoAdvance: boolean,
  ) => Promise<void>;
}) {
  const [canary, setCanary] = useState<string[]>([]);
  // OTA Stufe 4: die Automatik ist eine OPTION und startet AUS - Hand-Vorschub
  // ist bei dieser Flottengröße die richtige Vorgabe (D4).
  const [autoAdvance, setAutoAdvance] = useState(false);
  // Kandidaten MIT Zustand: ein offline gewähltes Canary lässt Welle 1 still
  // stehen, und bis hierher sah man das an der Checkbox nicht.
  const cands = useMemo(() => candidates(fleet, rollout), [fleet, rollout]);
  const rest = fleet.filter((d) => !canary.includes(d.deviceId));
  const summary = useMemo(() => startSummary(canary, fleet), [canary, fleet]);

  const waves: { name: string; devices: string[] }[] = [];
  if (canary.length > 0) waves.push({ name: 'Canary', devices: canary });
  if (rest.length > 0) waves.push({ name: 'Flotte', devices: rest.map((d) => d.deviceId) });

  return (
    <Drawer open title={`Rollout ${release.version}`} onClose={onClose}>
      <p className="vp-muted">
        Welle 1 wird sofort zugewiesen, jede weitere erst nach Freigabe (24 Std. gesunder
        Betrieb und – wo VoltPilot steuert – ein bestätigter Steuerzyklus).
      </p>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="vp-text-sm" style={{ fontWeight: 600 }}>
          Welle 1 (Canary)
        </legend>
        {cands.map((c) => (
          <label key={c.deviceId} className="vp-check-row vp-candidate">
            <input
              type="checkbox"
              checked={canary.includes(c.deviceId)}
              onChange={(e) =>
                setCanary((prev) =>
                  e.target.checked
                    ? [...prev, c.deviceId]
                    : prev.filter((id) => id !== c.deviceId),
                )
              }
            />{' '}
            <span className="vp-cell-main">
              <span>
                {c.name} <span className="vp-muted">· {c.tenantName}</span>{' '}
                <span className={`vp-ustate vp-ustate-${c.cls}`}>
                  <i className="vp-ustate-dot" aria-hidden="true" />
                  {c.state}
                </span>
                {/* Der VORSCHLAG ist eine Beobachtung, keine Empfehlung aus
                    dem Nichts: dieses Gerät stand in Welle 1 des letzten
                    Rollouts (D4, der eingespielte Canary). */}
                {c.proven && (
                  <>
                    {' '}
                    <Badge variant="ok" data-testid="proven-canary">bewährter Canary</Badge>
                  </>
                )}
              </span>
              {c.caveat && <span className="vp-cell-sub vp-lever">{c.caveat}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      {/* Was dieser Klick konkret auslöst - inklusive dessen, was NICHT
          passiert (übersprungene Pins, offline nachholend). Beides sieht
          später wie ein Fehler aus, wenn es hier nicht angekündigt wurde. */}
      {summary.length > 0 && (
        <>
          <h4>Das passiert beim Start</h4>
          <ul className="vp-plain-list vp-text-sm" data-testid="start-summary">
            {summary.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </>
      )}

      <label className="vp-check-row" style={{ marginTop: 'var(--vp-space-3)' }}>
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(e) => setAutoAdvance(e.target.checked)}
        />{' '}
        Automatisch weiter, wenn das Bake-Kriterium erfüllt ist
      </label>
      <p className="vp-muted vp-text-sm">
        {autoAdvance
          ? 'Es ändert sich nur, WER „Nächste Welle" drückt. Dasselbe Bake-Kriterium, '
            + 'derselbe automatische Halt bei jedem Fehlschlag, derselbe endgültige Not-Aus.'
          : 'Vorgabe: jede weitere Welle geben Sie von Hand frei. Umstellen geht auch '
            + 'später, während der Rollout läuft.'}
      </p>
      <Button
        variant="primary"
        disabled={waves.length === 0}
        onClick={() => void onStart(waves, canary.length > 0 ? 'canary' : 'stable', autoAdvance)}
      >
        Rollout starten
      </Button>
    </Drawer>
  );
}
