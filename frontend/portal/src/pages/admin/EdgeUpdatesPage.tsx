import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { fmtRelative } from '../../format';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { AdminPageHead } from './AdminPageHead';
import {
  APPLY_HOW,
  actorLabel,
  bakeLine,
  blockerLever,
  eventLabel,
  advanceMode,
  crossoverHint,
  crossoverState,
  formatTrustStamp,
  freshnessLabel,
  frozenFraming,
  handelnItems,
  loudBanner,
  progressBackbone,
  promoteHint,
  restingLine,
  rolloutStateLabel,
  signatureLabel,
  sortFleet,
  stateLabel,
  visibleJournal,
  waveDeviceName,
  waveRowView,
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
export function EdgeUpdatesPage() {
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
  const fleet = useMemo(() => sortFleet(data?.fleet ?? []), [data]);
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
                      <Button
                        variant="outline"
                        onClick={() => setDeviceFor(item.deviceId)}
                      >
                        Gerät ansehen
                      </Button>
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
                    <div className="vp-backbone-bar">
                      {progress.segments.map((s) => (
                        <span
                          key={s.cls}
                          className={`vp-backbone-seg vp-ustate-${s.cls}`}
                          style={{ flexGrow: s.count }}
                          title={`${s.count} ${s.label}`}
                        />
                      ))}
                    </div>
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
                      onClick={() => {
                        // Der Not-Aus ist ENDGÜLTIG - das steht in der Rückfrage,
                        // nicht erst hinterher.
                        if (
                          !window.confirm(
                            'Rollout einfrieren? Es wird nichts weiter verteilt. Bereits erteilte '
                              + 'Zuweisungen bleiben bestehen. Weitermachen ist danach ein NEUER Rollout.',
                          )
                        ) {
                          return;
                        }
                        void act(() => adminApi.haltRollout(rollout.id));
                      }}
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
                          const on = rollout.autoAdvance !== true;
                          if (on && !window.confirm(
                            'Wellen automatisch weiterschalten?\n\nEs ändert sich NUR, wer '
                              + '„Nächste Welle" drückt: dasselbe Bake-Kriterium (24 h gesund '
                              + 'und ein echter Steuerzyklus), derselbe automatische Halt bei '
                              + 'jedem Fehlschlag, derselbe endgültige Not-Aus.',
                          )) {
                            return;
                          }
                          void act(() => adminApi.setAutoAdvance(rollout.id, on));
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

          {/* ── 3. Flotten-Matrix ───────────────────────────────────────── */}
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <h3 style={{ marginTop: 0 }}>Flotten-Matrix</h3>
            {/* Der TOFU-Abschluss-Stand der Flotte: eine offene Aufgabe, kein
                Alarm - deshalb eine ruhige Zeile und kein Warn-Banner. */}
            {crossover && (
              <p className="vp-muted vp-text-sm" data-testid="crossover-hint">{crossover}</p>
            )}
            {fleet.length === 0 ? (
              <EmptyState title="Keine Geräte" description="Es ist kein Gerät verbunden." />
            ) : (
              /* Acht Spalten passen zwischen 720 und ~1000 px nicht in die
                 Karte, und die Karte KLIPPT (`overflow: hidden` rundet ihre
                 Ecken). Bis hierher waren die letzten Spalten dort schlicht
                 unerreichbar - seit dem Hebel wäre ausgerechnet der Satz
                 unsichtbar, der sagt, was eine Sperre aufhebt. Also scrollt
                 die Tabelle in ihrem EIGENEN Container (Haus-Regel für breite
                 Inhalte), statt abgeschnitten zu werden. */
              <div className="vp-table-scroll">
              <table className="vp-table responsive" data-testid="fleet">
                <thead>
                  <tr>
                    <th>Anlage</th>
                    <th>Mandant</th>
                    <th>Ist</th>
                    <th>Soll</th>
                    <th>Zustand</th>
                    <th>Vertrauen</th>
                    <th>seit</th>
                    <th>Grund</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.map((row) => (
                    <FleetTableRow
                      key={row.deviceId}
                      row={row}
                      onOpen={() => setDeviceFor(row.deviceId)}
                    />
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </Card>

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
          <DeviceTargetDrawer
            row={row}
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
          />
        );
      })()}

      {rolloutFor && data && (
        <StartRolloutDrawer
          release={rolloutFor}
          fleet={data.fleet}
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
}: {
  device: WaveDevice;
  fleet: FleetRow[];
  frozen: boolean;
}) {
  const name = waveDeviceName(device);
  const view = waveRowView(device, fleet, frozen);
  const bake = bakeLine(device);
  const lever = blockerLever(fleet.find((r) => r.deviceId === device.deviceId)?.blocker);
  return (
    <li className="vp-wave-device">
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

function FleetTableRow({ row, onOpen }: { row: FleetRow; onOpen: () => void }) {
  const cross = crossoverState(row.trust);
  const lever = blockerLever(row.blocker);
  return (
    <tr className="vp-row-click" onClick={onOpen} title="Zuweisung dieses Geräts">
      <td data-label="Anlage">
        {row.siteName}
        {row.pinned && (
          <>
            {' '}
            <Badge variant="off">festgenagelt</Badge>
          </>
        )}
      </td>
      <td data-label="Mandant" className="vp-muted">
        {row.tenantName}
      </td>
      {/* Der gemeldete Stempel VERBATIM - „–" heißt unbekannt, nie veraltet. */}
      <td data-label="Ist">{row.ist ?? '–'}</td>
      <td data-label="Soll">{row.soll ?? '–'}</td>
      <td data-label="Zustand">
        <StateChip state={row.state} />
      </td>
      {/* OTA Stufe 4: trägt diese Box schon ein schlüsseltragendes Image?
          „unbekannt" ist hier ruhig und heißt NIE „nicht gekreuzt". */}
      <td data-label="Vertrauen">
        <Badge variant={toneVariant(cross.tone)} dot title={cross.detail ?? undefined}>
          {cross.label}
        </Badge>
      </td>
      <td data-label="seit" className="vp-muted">
        {row.since ? fmtRelative(row.since) : '–'}
      </td>
      {/* `vp-cell-main` stapelt Grund + Hebel zu EINER Spalte - auch innerhalb
          der Telefon-Zeile aus Etikett und Wert. Ohne das stünden beide als
          zwei Flex-Kinder nebeneinander, und der Hebel liefe aus der Karte
          heraus (bei 375 px gemessen) - ausgerechnet der Satz, der sagt, was
          die Sperre aufhebt. */}
      <td data-label="Grund" className="vp-muted vp-text-sm">
        <span className="vp-cell-main">
          <span>{row.reason ?? '–'}</span>
          {lever && <span className="vp-lever" data-testid="lever">Hebel: {lever}</span>}
        </span>
      </td>
    </tr>
  );
}

/**
 * Die Zuweisung EINES Geräts (§7.1 „Geräte-Registry-Seite": Kanal + Pin +
 * „Jetzt aktualisieren" + die letzte Update-Historie).
 *
 * <p>Sie sitzt an der FLOTTEN-MATRIX, nicht an der Registry-Seite: die
 * Manufacturing-Registry kennt nur die Aufkleber-ID, eine Zuweisung braucht
 * aber die Geräte-Id - und die trägt genau diese Zeile.
 */
function DeviceTargetDrawer({
  row,
  releases,
  journal,
  busy,
  onClose,
  onAssign,
  onRevert,
}: {
  row: FleetRow;
  releases: EdgeUpdatesRelease[];
  journal: EdgeUpdates['journal'];
  busy: boolean;
  onClose: () => void;
  onAssign: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert: () => Promise<void>;
}) {
  const signed = releases.filter((r) => r.signed);
  const [seq, setSeq] = useState<number | null>(row.sollSeq ?? signed[0]?.releaseSeq ?? null);
  const [channel, setChannel] = useState(row.channel ?? 'stable');
  const [pinned, setPinned] = useState(row.pinned);
  const history = journal.filter((e) => e.deviceId === row.deviceId).slice(0, 10);

  return (
    <Drawer open title={row.siteName} onClose={onClose}>
      <p className="vp-muted">
        {row.tenantName} · {row.label}
      </p>
      <dl className="vp-kv-list">
        <dt>Ist</dt>
        <dd>{row.ist ?? '–'}</dd>
        <dt>Soll</dt>
        <dd>{row.soll ?? '–'}</dd>
        <dt>Zustand</dt>
        <dd><StateChip state={row.state} /></dd>
        {/* Die Vertrauens-Identität dieses Geräts (OTA Stufe 4): trägt es ein
            schlüsseltragendes Image, und WELCHES Vertrauens-Set fährt es? Das
            zweite ist der Blick, den ein Rotations-Drill je Box braucht. */}
        <dt>Vertrauen</dt>
        <dd>{crossoverState(row.trust).label}</dd>
        {row.trust && row.trust.trustSetKeyIds.length > 0 && (
          <>
            <dt>Vertrauens-Set</dt>
            <dd>
              {row.trust.trustSetKeyIds.join(', ')}
              {row.trust.trustSetGeneratedAt
                && ` (vom ${formatTrustStamp(row.trust.trustSetGeneratedAt)})`}
            </dd>
          </>
        )}
      </dl>
      {/* Der Grund steht IMMER dabei - „Crossover offen" ohne die Erklärung,
          dass das der dokumentierte Vor-TOFU-Zustand ist, läse sich wie ein
          Defekt. */}
      {crossoverState(row.trust).detail && (
        <p className="vp-muted vp-text-sm" data-testid="trust-detail">
          {crossoverState(row.trust).detail}
        </p>
      )}
      {row.reason && <p className="vp-muted vp-text-sm">{row.reason}</p>}
      {blockerLever(row.blocker) && (
        <p className="vp-text-sm vp-lever" data-testid="drawer-lever">
          Hebel: {blockerLever(row.blocker)}
        </p>
      )}
      {row.state === 'wartet_auf_anwendung' && (
        <p className="vp-text-sm" data-testid="drawer-apply-how">{APPLY_HOW}</p>
      )}

      {signed.length === 0 ? (
        <p className="vp-muted">
          Kein signiertes Release im Register – ohne signiertes Manifest hat ein Gerät nichts,
          was es gegen seinen Vertrauensanker prüfen könnte.
        </p>
      ) : (
        <>
          <label className="vp-field-row">
            <span>Release</span>
            <select
              value={seq ?? ''}
              onChange={(e) => setSeq(Number(e.target.value))}
              aria-label="Release"
            >
              {signed.map((r) => (
                <option key={r.releaseSeq} value={r.releaseSeq}>
                  {r.version}
                </option>
              ))}
            </select>
          </label>
          <label className="vp-field-row">
            <span>Kanal</span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              aria-label="Kanal"
            >
              <option value="stable">stable</option>
              <option value="canary">canary</option>
            </select>
          </label>
          <label className="vp-check-row">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />{' '}
            Festnageln – ein Rollout überschreibt dieses Gerät dann nicht, sondern
            überspringt es sichtbar.
          </label>
          <div className="vp-row-gap">
            {/* „Release zuweisen", nicht „Jetzt aktualisieren": der Knopf
                veröffentlicht eine Zuweisung - das ANWENDEN bleibt
                beaufsichtigt am Gerät. Der alte Wortlaut versprach genau das,
                was danach nicht passierte, und fütterte damit die Frage
                „warum passiert nichts?" (Reibung R5). */}
            <Button
              variant="primary"
              disabled={busy || seq == null}
              onClick={() => void onAssign(seq as number, channel, pinned)}
            >
              Release zuweisen
            </Button>
            {row.soll && (
              <Button variant="outline" disabled={busy} onClick={() => void onRevert()}>
                Zuweisung zurücknehmen
              </Button>
            )}
          </div>
        </>
      )}

      <h4>Update-Historie</h4>
      {history.length === 0 ? (
        <p className="vp-muted vp-text-sm">Für dieses Gerät ist noch nichts passiert.</p>
      ) : (
        <ul className="vp-plain-list">
          {history.map((e) => (
            <li key={e.id} className="vp-text-sm">
              <span className="vp-muted">{fmtWhen(e.at)}</span> · {actorLabel(e.actor)} ·{' '}
              {eventLabel(e.event)}
              {e.detail ? ` – ${e.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
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
  onClose,
  onStart,
}: {
  release: EdgeUpdatesRelease;
  fleet: FleetRow[];
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
  const candidates = useMemo(() => sortFleet(fleet), [fleet]);
  const rest = candidates.filter((d) => !canary.includes(d.deviceId));

  const waves: { name: string; devices: string[] }[] = [];
  if (canary.length > 0) waves.push({ name: 'Canary', devices: canary });
  if (rest.length > 0) waves.push({ name: 'Flotte', devices: rest.map((d) => d.deviceId) });

  return (
    <Drawer open title={`Rollout ${release.version}`} onClose={onClose}>
      <p className="vp-muted">
        Welle 1 wird sofort zugewiesen, jede weitere erst nach Freigabe (24 Std. gesunder
        Betrieb und – wo VoltPilot steuert – ein bestätigter Steuerzyklus).
      </p>
      <p className="vp-muted vp-text-sm">
        Ein festgenageltes Gerät wird übersprungen, nicht überschrieben.
      </p>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="vp-text-sm" style={{ fontWeight: 600 }}>
          Welle 1 (Canary)
        </legend>
        {candidates.map((d) => (
          <label key={d.deviceId} className="vp-check-row">
            <input
              type="checkbox"
              checked={canary.includes(d.deviceId)}
              onChange={(e) =>
                setCanary((prev) =>
                  e.target.checked
                    ? [...prev, d.deviceId]
                    : prev.filter((id) => id !== d.deviceId),
                )
              }
            />{' '}
            {d.siteName} <span className="vp-muted">· {d.tenantName}</span>
          </label>
        ))}
      </fieldset>
      <p className="vp-muted vp-text-sm">
        {rest.length === 0
          ? 'Alle Geräte stehen in Welle 1.'
          : `Welle 2 „Flotte“: ${rest.length} Gerät${rest.length === 1 ? '' : 'e'}.`}
      </p>
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
          ? 'Es ändert sich nur, WER „Nächste Welle“ drückt. Dasselbe Bake-Kriterium, '
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
